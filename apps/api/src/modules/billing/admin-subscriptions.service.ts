import { Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  daysRemaining,
  evaluateEntitlement,
  paiseToAmount,
  type EntitlementState,
} from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import { MembershipCacheService } from '../auth/membership-cache.service';
import type { PrismaTransaction } from '../../common/prisma/transaction';
import { BillingRepository, lockSubscription } from './billing.repository';
import { BillingService, entitlementFacts, serialise, snapshot, toPaymentView } from './billing.service';

const DAY = 86_400_000;
/** Recovery window between a deletion request and the earliest permitted purge. */
export const DELETION_RECOVERY_DAYS = 30;

export const ADMIN_ACTIONS = [
  'extend_trial',
  'set_trial_end',
  'grant_complimentary',
  'revoke_complimentary',
  'extend_paid',
  'change_plan',
  'record_decision',
  'suspend',
  'reactivate',
  'deactivate',
  'set_exempt',
  'request_deletion',
  'cancel_deletion',
  'reconcile_payment',
] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

export interface AdminActionInput {
  action: AdminAction;
  reason: string;
  days?: number;
  until?: string;
  planCode?: string;
  decision?: 'GRANDFATHERED' | 'PENDING_REVIEW';
  exempt?: boolean;
  confirm?: string;
  paymentId?: string;
}

type AdminOrg = Awaited<ReturnType<BillingRepository['adminOrganizations']>>[number];

/**
 * CRAVION platform administration of LeadFlow subscriptions, reached only
 * through the signed integrations/admin-subscriptions API (itself reached only
 * through the CRAVION Admin backend, for an explicit super_admin).
 *
 * Every action needs a reason and writes an append-only subscription_changes
 * row: actor, organization, timestamp, previous state, new state.
 *
 * Protected: the INTERNAL organization (CRAVION) and any organization holding
 * a PLATFORM_OWNER membership cannot be suspended, deactivated, expired or put
 * up for deletion. Deletion here is a REQUEST with a 30-day recovery window
 * and a dependency report; the purge itself is not available through any API
 * (it needs an approved data-deletion procedure), and nothing is ever deleted
 * for nonpayment.
 */
@Injectable()
export class AdminSubscriptionsService {
  constructor(
    private readonly repository: BillingRepository,
    private readonly billing: BillingService,
    private readonly memberships: MembershipCacheService,
  ) {}

  async overview(now = new Date()) {
    const [orgs, totals] = await Promise.all([this.repository.adminOrganizations(), this.repository.paymentTotals()]);
    const counts: Record<string, number> = {};
    let upcoming = 0;
    for (const org of orgs) {
      const e = evaluateEntitlement(entitlementFacts(org), now);
      counts[e.state] = (counts[e.state] ?? 0) + 1;
      if (e.accessEndsAt && e.accessEndsAt.getTime() - now.getTime() < 14 * DAY && e.state !== 'PAST_DUE') upcoming += 1;
    }
    const sum = (status: string, field: 'totalAmountPaise' | 'refundedPaise') =>
      totals.filter((t) => t.status === status).reduce((n, t) => n + (t._sum[field] ?? 0), 0);
    const paidGross = sum('PAID', 'totalAmountPaise') + sum('PARTIALLY_REFUNDED', 'totalAmountPaise') + sum('REFUNDED', 'totalAmountPaise');
    const refunded = sum('PAID', 'refundedPaise') + sum('PARTIALLY_REFUNDED', 'refundedPaise') + sum('REFUNDED', 'refundedPaise');
    return {
      generatedAt: now.toISOString(),
      organizations: orgs.length,
      byState: counts,
      trialing: counts['TRIALING'] ?? 0,
      activePremium: (counts['ACTIVE'] ?? 0) + (counts['PAST_DUE'] ?? 0),
      lifetime: counts['LIFETIME'] ?? 0,
      complimentary: counts['COMPLIMENTARY'] ?? 0,
      expired: (counts['EXPIRED'] ?? 0) + (counts['CANCELLED'] ?? 0),
      suspended: (counts['SUSPENDED'] ?? 0) + (counts['DEACTIVATED'] ?? 0),
      exempt: counts['EXEMPT'] ?? 0,
      pendingReview: counts['PENDING_REVIEW'] ?? 0,
      upcomingRenewals: upcoming,
      revenue: {
        currency: 'INR',
        collected: paiseToAmount(paidGross),
        refunded: paiseToAmount(refunded),
        net: paiseToAmount(paidGross - refunded),
        paidPayments: totals.filter((t) => ['PAID', 'PARTIALLY_REFUNDED'].includes(t.status)).reduce((n, t) => n + t._count, 0),
      },
      pendingPayments: totals.filter((t) => t.status === 'CREATED').reduce((n, t) => n + t._count, 0),
    };
  }

  async organizations(filter: { search?: string | undefined; state?: string | undefined }, now = new Date()) {
    const [orgs, activity] = await Promise.all([this.repository.adminOrganizations(), this.repository.lastActivity()]);
    const search = filter.search?.trim().toLowerCase();
    return orgs
      .map((org) => this.row(org, activity.get(org.id) ?? null, now))
      .filter((row) => !filter.state || row.state === filter.state)
      .filter(
        (row) =>
          !search ||
          row.name.toLowerCase().includes(search) ||
          row.id === search ||
          (row.owner?.email ?? '').toLowerCase().includes(search),
      );
  }

  private row(org: AdminOrg, lastActivityAt: Date | null, now: Date) {
    const e = evaluateEntitlement(entitlementFacts(org), now);
    const sub = org.subscription;
    return {
      id: org.id,
      name: org.name,
      organizationType: org.organizationType,
      organizationStatus: org.status,
      registeredAt: org.createdAt.toISOString(),
      owner: org.memberships[0]?.user ? { name: org.memberships[0].user.fullName, email: org.memberships[0].user.email } : null,
      activeUsers: org._count.memberships,
      state: e.state as EntitlementState,
      grantsAccess: e.grantsAccess,
      accessEndsAt: e.accessEndsAt?.toISOString() ?? null,
      daysRemaining: daysRemaining(e.accessEndsAt, now),
      plan: sub?.plan.code ?? null,
      interval: sub?.billingInterval ?? null,
      subscriptionStatus: sub?.status ?? null,
      trialStartsAt: sub?.trialStartsAt?.toISOString() ?? null,
      trialEndsAt: sub?.trialEndsAt?.toISOString() ?? null,
      paidUntil: sub && (sub.status === 'ACTIVE' || sub.status === 'PAST_DUE') ? sub.currentPeriodEnd.toISOString() : null,
      lifetime: sub?.lifetime ?? false,
      complimentaryUntil: sub?.complimentaryUntil?.toISOString() ?? null,
      exempt: org.organizationType === 'INTERNAL' || (sub?.exempt ?? false),
      entitlementDecision: sub?.entitlementDecision ?? (org.organizationType === 'INTERNAL' ? 'EXEMPT' : null),
      decisionReason: sub?.decisionReason ?? null,
      deletionRequestedAt: org.deletionRequestedAt?.toISOString() ?? null,
      deletionScheduledFor: org.deletionScheduledFor?.toISOString() ?? null,
      lastActivityAt: lastActivityAt?.toISOString() ?? null,
      protected: org.organizationType === 'INTERNAL',
    };
  }

  async organization(organizationId: string, now = new Date()) {
    const detail = await this.repository.adminOrganization(organizationId);
    if (!detail.org) throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Organization not found.');
    const all = await this.repository.adminOrganizations();
    const listed = all.find((o) => o.id === organizationId)!;
    const activity = await this.repository.lastActivity();
    return {
      ...this.row(listed, activity.get(organizationId) ?? null, now),
      users: detail.users.map((m) => ({
        id: m.user.id,
        name: m.user.fullName,
        email: m.user.email,
        role: m.role.key,
        membershipStatus: m.status,
        userStatus: m.user.status,
        joinedAt: m.createdAt.toISOString(),
        lastLoginAt: m.user.lastLoginAt?.toISOString() ?? null,
        lastActiveAt: m.user.lastActiveAt?.toISOString() ?? null,
      })),
      payments: detail.payments.map(toPaymentView),
      changes: detail.changes.map((c) => ({
        id: c.id,
        action: c.action,
        actorType: c.actorType,
        actor: c.actorRef,
        reason: c.reason,
        before: c.before,
        after: c.after,
        at: c.createdAt.toISOString(),
      })),
      records: detail.records,
      deletionRecoveryDays: DELETION_RECOVERY_DAYS,
      purgeAvailable: false,
    };
  }

  async act(organizationId: string, input: AdminActionInput, actorRef: string, now = new Date()) {
    const reason = input.reason?.trim() ?? '';
    if (reason.length < 5) throw AppException.validation('A reason of at least 5 characters is required.', { reason: ['required'] });
    const org = await this.repository.organization(organizationId);
    if (!org) throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Organization not found.');
    const actor = { type: 'admin' as const, ref: actorRef };

    if (input.action === 'reconcile_payment') {
      if (!input.paymentId) throw AppException.validation('paymentId is required.');
      const payment = await this.repository.paymentById(input.paymentId);
      if (!payment || payment.organizationId !== organizationId) throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Payment not found.');
      const result = await this.billing.reconcileOne(payment.id, actor);
      await this.repository.recordChange({ organizationId, action: 'admin.reconcile_payment', actorType: 'admin', actorRef, reason, before: { payment: payment.status }, after: { payment: result.status } });
      return this.organization(organizationId, now);
    }

    const protectedOrg = org.organizationType === 'INTERNAL' || (await this.hasPlatformOwner(organizationId));
    const restricting = ['suspend', 'deactivate', 'request_deletion'].includes(input.action);
    if (protectedOrg && restricting) {
      throw AppException.forbiddenWithCode(ERROR_CODES.FORBIDDEN, 'The CRAVION platform organization and platform administration accounts are protected.');
    }
    if (org.organizationType === 'INTERNAL') {
      throw AppException.conflict(ERROR_CODES.CONFLICT, 'The CRAVION internal organization is permanently exempt; it has no subscription to change.');
    }

    await this.repository.transaction(`admin ${input.action}`, async (tx) => {
      const sub = await this.ensureSubscription(tx, organizationId, now);
      const before: Record<string, unknown> = { ...snapshot(sub), organizationStatus: org.status, deletionRequestedAt: org.deletionRequestedAt?.toISOString() ?? null };
      const data: Record<string, unknown> = {};
      const orgData: Record<string, unknown> = {};
      const until = input.until ? new Date(input.until) : null;
      if (until && Number.isNaN(until.getTime())) throw AppException.validation('until must be an ISO date.');
      const future = (d: Date | null, label: string) => {
        if (!d || d.getTime() <= now.getTime()) throw AppException.validation(`${label} must be in the future.`);
        if (d.getTime() > now.getTime() + 10 * 365 * DAY) throw AppException.validation(`${label} is too far ahead.`);
        return d;
      };
      const days = (n: number | undefined) => {
        if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 3650) throw AppException.validation('days must be a whole number from 1 to 3650.');
        return n as number;
      };
      const reviewed = sub.entitlementDecision === 'PENDING_REVIEW' || sub.entitlementDecision === 'TRIAL_ALREADY_USED' || !sub.entitlementDecision;

      switch (input.action) {
        case 'extend_trial':
        case 'set_trial_end': {
          const end =
            input.action === 'extend_trial'
              ? new Date(Math.max(now.getTime(), sub.trialEndsAt?.getTime() ?? 0) + days(input.days) * DAY)
              : future(until, 'until');
          Object.assign(data, { status: 'TRIAL', trialEndsAt: end, currentPeriodEnd: end, cancelledAt: null, trialStartsAt: sub.trialStartsAt ?? now });
          if (reviewed) Object.assign(data, { entitlementDecision: 'GRANDFATHERED' });
          break;
        }
        case 'grant_complimentary':
          Object.assign(data, { complimentaryUntil: until ? future(until, 'until') : new Date(now.getTime() + days(input.days) * DAY), entitlementDecision: 'COMPLIMENTARY' });
          break;
        case 'revoke_complimentary':
          Object.assign(data, { complimentaryUntil: null });
          break;
        case 'extend_paid': {
          const base = sub.status === 'ACTIVE' || sub.status === 'PAST_DUE' ? Math.max(now.getTime(), sub.currentPeriodEnd.getTime()) : now.getTime();
          const end = until ? future(until, 'until') : new Date(base + days(input.days) * DAY);
          Object.assign(data, { status: 'ACTIVE', currentPeriodEnd: end, cancelledAt: null });
          if (reviewed) Object.assign(data, { entitlementDecision: 'GRANDFATHERED' });
          break;
        }
        case 'change_plan': {
          const plan = await tx.plan.findFirst({ where: { code: input.planCode ?? '', active: true }, select: { id: true } });
          if (!plan) throw AppException.validation('Unknown or withdrawn plan.');
          Object.assign(data, { planId: plan.id });
          break;
        }
        case 'record_decision':
          if (input.decision !== 'GRANDFATHERED' && input.decision !== 'PENDING_REVIEW') throw AppException.validation('decision must be GRANDFATHERED or PENDING_REVIEW.');
          Object.assign(data, { entitlementDecision: input.decision });
          break;
        case 'suspend':
        case 'deactivate':
          Object.assign(data, { accessHold: input.action === 'suspend' ? 'SUSPENDED' : 'DEACTIVATED' });
          Object.assign(orgData, { status: 'SUSPENDED' });
          break;
        case 'reactivate':
          if (org.deletionRequestedAt) throw AppException.conflict(ERROR_CODES.CONFLICT, 'Cancel the deletion request before reactivating.');
          Object.assign(data, { accessHold: null });
          Object.assign(orgData, { status: 'ACTIVE' });
          break;
        case 'set_exempt':
          if (input.confirm !== 'EXEMPT') throw AppException.validation('Type EXEMPT to confirm.', { confirm: ['must be EXEMPT'] });
          Object.assign(data, { exempt: Boolean(input.exempt), ...(input.exempt ? { entitlementDecision: 'EXEMPT' } : {}) });
          break;
        case 'request_deletion':
          if ((input.confirm ?? '').trim() !== org.name) throw AppException.validation('Type the organization name exactly to confirm.', { confirm: ['must equal the organization name'] });
          if (org.deletionRequestedAt) throw AppException.conflict(ERROR_CODES.CONFLICT, 'Deletion is already requested.');
          Object.assign(data, { accessHold: 'SUSPENDED' });
          Object.assign(orgData, {
            status: 'SUSPENDED',
            deletionRequestedAt: now,
            deletionScheduledFor: new Date(now.getTime() + DELETION_RECOVERY_DAYS * DAY),
            deletionReason: reason.slice(0, 500),
            deletionRequestedBy: actorRef,
          });
          break;
        case 'cancel_deletion':
          if (!org.deletionRequestedAt) throw AppException.conflict(ERROR_CODES.CONFLICT, 'No deletion is requested.');
          Object.assign(orgData, { deletionRequestedAt: null, deletionScheduledFor: null, deletionReason: null, deletionRequestedBy: null });
          break;
        default:
          throw AppException.validation('Unknown action.');
      }
      Object.assign(data, { decisionReason: reason.slice(0, 500), decisionAt: now, decisionBy: actorRef });
      await tx.subscription.update({ where: { organizationId }, data });
      if (Object.keys(orgData).length > 0) await tx.organization.update({ where: { id: organizationId }, data: orgData });
      await tx.subscriptionChange.create({
        data: {
          organizationId,
          action: `admin.${input.action}`,
          actorType: actor.type,
          actorRef,
          reason: reason.slice(0, 500),
          before: before as object,
          after: { ...before, ...serialise(data), ...(Object.keys(orgData).length ? { organization: serialise(orgData) } : {}) } as object,
        },
      });
    });
    this.billing.invalidate(organizationId);
    if (['suspend', 'deactivate', 'reactivate', 'request_deletion'].includes(input.action)) {
      // The authentication guard caches each membership (with its
      // organization status) for a minute; a suspension takes effect now.
      const detail = await this.repository.adminOrganization(organizationId);
      await Promise.all(detail.users.map((m) => this.memberships.invalidate(m.user.id, organizationId)));
    }
    return this.organization(organizationId, now);
  }

  private async hasPlatformOwner(organizationId: string): Promise<boolean> {
    const detail = await this.repository.adminOrganization(organizationId);
    return detail.users.some((u) => u.role.key === 'PLATFORM_OWNER');
  }

  /** A customer organization with no subscription row gets one (on the Premium plan, expired trial) to act on. */
  private async ensureSubscription(tx: PrismaTransaction, organizationId: string, now: Date) {
    const existing = await lockSubscription(tx, organizationId);
    if (existing) return existing;
    const plan = await tx.plan.findFirstOrThrow({ where: { code: 'PREMIUM' }, select: { id: true } });
    await tx.subscription.create({
      data: { organizationId, planId: plan.id, status: 'EXPIRED', billingInterval: 'MONTHLY', currentPeriodStart: now, currentPeriodEnd: now, trialEndsAt: now, trialStartsAt: now, entitlementDecision: 'PENDING_REVIEW' },
    });
    return (await lockSubscription(tx, organizationId))!;
  }
}
