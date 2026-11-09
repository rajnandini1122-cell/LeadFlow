import { Injectable } from '@nestjs/common';
import type { BillingInterval } from '@leadflow/api-types';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { PrismaTransaction } from '../../common/prisma/transaction';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';

export const subscriptionSelect = {
  id: true,
  organizationId: true,
  planId: true,
  status: true,
  billingInterval: true,
  currentPeriodStart: true,
  currentPeriodEnd: true,
  trialStartsAt: true,
  trialEndsAt: true,
  cancelledAt: true,
  lifetime: true,
  complimentaryUntil: true,
  exempt: true,
  accessHold: true,
  entitlementDecision: true,
  decisionReason: true,
  decisionAt: true,
  decisionBy: true,
  planPriceId: true,
  plan: { select: { code: true, name: true, maxUsers: true, maxActiveLeads: true } },
} as const;

export const priceSelect = {
  id: true,
  interval: true,
  version: true,
  currency: true,
  baseAmountPaise: true,
  taxRateBp: true,
  taxInclusive: true,
  taxAmountPaise: true,
  totalAmountPaise: true,
  renewal: true,
  active: true,
  effectiveFrom: true,
  effectiveUntil: true,
  plan: { select: { id: true, code: true, name: true } },
} as const;

/**
 * Every database read and write behind billing.
 *
 * Billing is platform-level (a payment, a price and an entitlement are not a
 * tenant's records to edit), so it runs under an explicit system scope with a
 * stated reason — and EVERY organization-specific query names its
 * organization explicitly. A tenant endpoint passes the caller's own
 * organization id from the principal, never one from the request body.
 */
@Injectable()
export class BillingRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private get db() {
    return this.prisma.client;
  }

  system<T>(reason: string, run: () => Promise<T>): Promise<T> {
    return this.tenantContext.runAsSystem(`billing: ${reason}`, run);
  }

  transaction<T>(reason: string, run: (tx: PrismaTransaction) => Promise<T>): Promise<T> {
    return this.system(reason, () => this.db.$transaction((tx) => run(tx as PrismaTransaction)));
  }

  // --- facts -----------------------------------------------------------------

  organization(organizationId: string) {
    return this.system('read organization', () =>
      this.db.organization.findUnique({
        where: { id: organizationId },
        select: {
          id: true,
          name: true,
          status: true,
          organizationType: true,
          deletedAt: true,
          createdAt: true,
          deletionRequestedAt: true,
          deletionScheduledFor: true,
          subscription: { select: subscriptionSelect },
        },
      }),
    );
  }

  // --- prices ----------------------------------------------------------------

  activePrices() {
    return this.system('read prices', () =>
      this.db.planPrice.findMany({
        where: { active: true, plan: { active: true } },
        orderBy: [{ totalAmountPaise: 'asc' }],
        select: priceSelect,
      }),
    );
  }

  activePrice(interval: BillingInterval) {
    return this.system('read price', () =>
      this.db.planPrice.findFirst({
        where: { active: true, interval, plan: { active: true } },
        orderBy: { version: 'desc' },
        select: priceSelect,
      }),
    );
  }

  premiumPlanId() {
    return this.system('read plan', async () => {
      const plan = await this.db.plan.findUnique({ where: { code: 'PREMIUM' }, select: { id: true } });
      return plan?.id ?? null;
    });
  }

  // --- payments --------------------------------------------------------------

  payments(organizationId: string, take = 50) {
    return this.system('read payments', () =>
      this.db.billingPayment.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        take,
      }),
    );
  }

  /** A recent unpaid order for the same interval, reused rather than piling up orders. */
  openPayment(organizationId: string, interval: BillingInterval, since: Date) {
    return this.system('read open payment', () =>
      this.db.billingPayment.findFirst({
        where: { organizationId, interval, status: 'CREATED', createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  createPayment(data: {
    organizationId: string;
    planPriceId: string;
    interval: BillingInterval;
    currency: string;
    baseAmountPaise: number;
    taxAmountPaise: number;
    totalAmountPaise: number;
    receipt: string;
    providerOrderId: string;
    createdByUserId: string;
  }) {
    return this.system('create payment', () =>
      this.db.billingPayment.create({ data: { ...data, status: 'CREATED' } }),
    );
  }

  paymentByOrder(providerOrderId: string) {
    return this.system('read payment', () =>
      this.db.billingPayment.findUnique({ where: { providerOrderId } }),
    );
  }

  paymentByProviderPayment(providerPaymentId: string) {
    return this.system('read payment', () =>
      this.db.billingPayment.findUnique({ where: { providerPaymentId } }),
    );
  }

  paymentById(id: string) {
    return this.system('read payment', () => this.db.billingPayment.findUnique({ where: { id } }));
  }

  /** CREATED -> FAILED only; a payment that already succeeded is never marked failed. */
  async markFailed(id: string, reason: string): Promise<boolean> {
    const result = await this.system('mark payment failed', () =>
      this.db.billingPayment.updateMany({
        where: { id, status: 'CREATED' },
        data: { status: 'FAILED', failureReason: reason.slice(0, 300), lastCheckedAt: new Date() },
      }),
    );
    return result.count === 1;
  }

  touchChecked(id: string) {
    return this.system('mark payment checked', () =>
      this.db.billingPayment.update({ where: { id }, data: { lastCheckedAt: new Date() } }),
    );
  }

  expireStale(before: Date) {
    return this.system('expire stale orders', () =>
      this.db.billingPayment.updateMany({
        where: { status: 'CREATED', createdAt: { lt: before } },
        data: { status: 'EXPIRED' },
      }),
    );
  }

  paymentsToReconcile(createdAfter: Date, createdBefore: Date, checkedBefore: Date) {
    return this.system('read payments to reconcile', () =>
      this.db.billingPayment.findMany({
        where: {
          status: { in: ['CREATED', 'FAILED'] },
          createdAt: { gte: createdAfter, lte: createdBefore },
          OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: checkedBefore } }],
        },
        orderBy: { createdAt: 'asc' },
        take: 50,
      }),
    );
  }

  /** Paid payments recent enough to be refunded, not checked today. */
  paidToCheckForRefunds(paidAfter: Date, checkedBefore: Date) {
    return this.system('read paid payments', () =>
      this.db.billingPayment.findMany({
        where: {
          status: { in: ['PAID', 'PARTIALLY_REFUNDED'] },
          paidAt: { gte: paidAfter },
          OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: checkedBefore } }],
        },
        take: 50,
      }),
    );
  }

  // --- events (webhook idempotency) -------------------------------------------

  /** True if this event was new; false if it was already recorded (a redelivery). */
  async recordEvent(input: {
    eventId: string;
    eventType: string;
    paymentId: string | null;
    outcome: string;
  }): Promise<boolean> {
    const result = await this.system('record provider event', () =>
      this.db.billingEvent.createMany({
        data: [{ provider: 'razorpay', ...input }],
        skipDuplicates: true,
      }),
    );
    return result.count === 1;
  }

  // --- trial claims --------------------------------------------------------------

  /** True if this person had not claimed a trial before. */
  async claimTrial(fingerprint: string, organizationId: string): Promise<boolean> {
    const result = await this.system('claim trial', () =>
      this.db.trialClaim.createMany({ data: [{ fingerprint, organizationId }], skipDuplicates: true }),
    );
    return result.count === 1;
  }

  user(userId: string) {
    return this.db.user.findUnique({ where: { id: userId }, select: { fullName: true, email: true } });
  }

  // --- platform administration (CRAVION Admin, via the signed API) -------------------

  adminOrganizations() {
    return this.system('admin: list organizations', () =>
      this.db.organization.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          status: true,
          organizationType: true,
          deletedAt: true,
          createdAt: true,
          deletionRequestedAt: true,
          deletionScheduledFor: true,
          subscription: { select: subscriptionSelect },
          _count: { select: { memberships: { where: { status: 'ACTIVE' } } } },
          memberships: {
            where: { role: { key: 'OWNER' } },
            take: 1,
            select: { user: { select: { fullName: true, email: true } } },
          },
        },
      }),
    );
  }

  /** Last authenticated activity per organization (from platform analytics). */
  async lastActivity(): Promise<Map<string, Date>> {
    const rows = await this.system('admin: last activity', () =>
      this.db.userActivityDay.groupBy({ by: ['organizationId'], _max: { firstSeenAt: true } }),
    );
    return new Map(rows.filter((r) => r._max.firstSeenAt).map((r) => [r.organizationId, r._max.firstSeenAt as Date]));
  }

  adminOrganization(organizationId: string) {
    return this.system('admin: organization detail', async () => {
      const [org, users, payments, changes, counts] = await Promise.all([
        this.organization(organizationId),
        this.db.organizationUser.findMany({
          where: { organizationId },
          orderBy: { createdAt: 'asc' },
          select: {
            status: true,
            createdAt: true,
            role: { select: { key: true } },
            user: { select: { id: true, fullName: true, email: true, status: true, lastActiveAt: true, lastLoginAt: true } },
          },
        }),
        this.db.billingPayment.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' }, take: 100 }),
        this.db.subscriptionChange.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' }, take: 200 }),
        Promise.all([
          this.db.lead.count({ where: { organizationId } }),
          this.db.contact.count({ where: { organizationId } }),
          this.db.followUp.count({ where: { organizationId } }),
        ]),
      ]);
      return { org, users, payments, changes, records: { leads: counts[0], contacts: counts[1], followUps: counts[2] } };
    });
  }

  paymentTotals() {
    return this.system('admin: payment totals', () =>
      this.db.billingPayment.groupBy({ by: ['status'], _sum: { totalAmountPaise: true, refundedPaise: true }, _count: true }),
    );
  }

  recordChange(data: {
    organizationId: string;
    action: string;
    actorType: string;
    actorRef: string;
    reason: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  }) {
    return this.system('record subscription change', () =>
      this.db.subscriptionChange.create({ data: { ...data, before: data.before as object, after: data.after as object } }),
    );
  }

  // --- members to notify ------------------------------------------------------------

  billingContacts(organizationId: string) {
    return this.system('read billing contacts', () =>
      this.db.organizationUser.findMany({
        where: {
          organizationId,
          status: 'ACTIVE',
          role: { key: { in: ['OWNER', 'ADMIN'] } },
          user: { status: 'ACTIVE' },
        },
        select: { role: { select: { key: true } }, user: { select: { id: true, fullName: true, email: true } } },
      }),
    );
  }

  /** Customer subscriptions whose trial or paid period ends within the window. */
  subscriptionsEndingBetween(from: Date, to: Date) {
    return this.system('read subscriptions ending', () =>
      this.db.subscription.findMany({
        where: {
          lifetime: false,
          exempt: false,
          accessHold: null,
          OR: [
            { status: 'TRIAL', trialEndsAt: { gte: from, lte: to } },
            { status: { in: ['ACTIVE', 'PAST_DUE'] }, currentPeriodEnd: { gte: from, lte: to } },
          ],
          organization: { organizationType: 'CUSTOMER', deletedAt: null, status: { not: 'SUSPENDED' } },
        },
        select: { ...subscriptionSelect, organization: { select: { name: true } } },
      }),
    );
  }
}

/**
 * Row lock on one organization's subscription, inside a transaction.
 *
 * The no-op UPDATE idiom used elsewhere (lockLeadForFollowUps): writing
 * updated_at back unchanged takes the row lock without a raw SELECT … FOR
 * UPDATE. Two concurrent payment confirmations for the same organization
 * therefore apply one after the other, each reading what the first committed.
 */
export async function lockSubscription(tx: PrismaTransaction, organizationId: string) {
  const row = await tx.subscription.findUnique({ where: { organizationId }, select: { updatedAt: true } });
  if (!row) return null;
  await tx.subscription.updateMany({ where: { organizationId }, data: { updatedAt: row.updatedAt } });
  return tx.subscription.findUnique({ where: { organizationId }, select: subscriptionSelect });
}
