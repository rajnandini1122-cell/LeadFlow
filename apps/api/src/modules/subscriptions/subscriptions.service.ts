import { Injectable, Logger } from '@nestjs/common';
import {
  ERROR_CODES,
  canTransition,
  grantsAccess,
  type BillingInterval,
  type PlanView,
  type SubscriptionStatus,
  type SubscriptionView,
} from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import { AuditRepository } from '../../common/audit/audit.repository';
import {
  TenantContextService,
  type TenantPrincipal,
} from '../../common/tenancy/tenant-context.service';
import { DEFAULT_PLAN_CODE, TRIAL_DAYS } from './plan-catalogue';
import { SubscriptionsRepository } from './subscriptions.repository';

/**
 * Whether plan limits are applied by the server.
 *
 * FALSE, and every surface that shows a limit says so. The columns exist and
 * are populated; nothing reads them to refuse an action. Publishing "up to 15
 * users" while allowing 200 is a promise broken at the worst possible moment —
 * when a customer discovers it — so the honest thing is to store the intent and
 * state plainly that it is not yet enforced.
 *
 * Flip this only when the checks exist at invite time and lead-create time AND
 * are covered by tests.
 */
export const PLAN_LIMITS_ENFORCED = false;

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly repository: SubscriptionsRepository,
    private readonly audit: AuditRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  // ---------------------------------------------------------------------------
  // Public catalogue
  // ---------------------------------------------------------------------------

  /** The plan catalogue. Deliberately requires no authentication. */
  async listPlans(): Promise<PlanView[]> {
    const plans = await this.repository.activePlans();
    return plans.map(toPlanView);
  }

  // ---------------------------------------------------------------------------
  // The caller's subscription
  // ---------------------------------------------------------------------------

  async current(): Promise<SubscriptionView> {
    const subscription = await this.repository.findCurrent();
    if (!subscription) {
      throw AppException.notFound(
        ERROR_CODES.SUBSCRIPTION_NOT_FOUND,
        'This organization has no subscription.',
      );
    }

    return toSubscriptionView(subscription);
  }

  /**
   * Starts a trial for a newly registered organization.
   *
   * Never throws. An organization that exists without a subscription row is
   * recoverable — `current()` reports it and an admin can be given one — but a
   * registration that fails because the catalogue was not seeded would leave a
   * would-be customer unable to sign up at all. The failure is logged loudly
   * instead.
   */
  async startTrial(organizationId: string, now = new Date()): Promise<void> {
    // Runs under an explicit system scope. Registration creates the
    // organization BEFORE anyone is authenticated, so there is no request
    // tenant context — and the Prisma scoper fails closed rather than guessing,
    // which is exactly what it should do. The organizationId is passed
    // explicitly instead, so the row is still written to the right tenant.
    await this.tenantContext.runAsSystem('registration: start trial subscription', async () => {
      await this.createTrial(organizationId, now);
    });
  }

  private async createTrial(organizationId: string, now: Date): Promise<void> {
    try {
      const plan = await this.repository.findActivePlanByCode(DEFAULT_PLAN_CODE);
      if (!plan) {
        this.logger.error(
          { organizationId, planCode: DEFAULT_PLAN_CODE },
          'Default plan is missing from the catalogue — organization created without a subscription',
        );
        return;
      }

      const trialEnd = new Date(now.getTime() + TRIAL_DAYS * 86_400_000);

      await this.repository.create({
        organizationId,
        planId: plan.id,
        status: 'TRIAL',
        billingInterval: 'MONTHLY',
        currentPeriodStart: now,
        currentPeriodEnd: trialEnd,
        trialEndsAt: trialEnd,
      });
    } catch (error) {
      this.logger.error({ organizationId, err: error }, 'Could not start trial subscription');
    }
  }

  /**
   * Changes the plan or the billing interval.
   *
   * Deliberately cannot change `status`. A client asserting "I am ACTIVE" would
   * be asserting that it has been paid, which only a payment provider can know
   * — so status moves through `transitionStatus` below, which no HTTP route
   * currently exposes.
   */
  async changePlan(
    input: { planCode?: string | undefined; billingInterval?: BillingInterval | undefined },
    principal: TenantPrincipal,
  ): Promise<SubscriptionView> {
    const existing = await this.repository.findCurrent();
    if (!existing) {
      throw AppException.notFound(
        ERROR_CODES.SUBSCRIPTION_NOT_FOUND,
        'This organization has no subscription.',
      );
    }

    const data: Record<string, unknown> = {};
    let nextPlan: PlanView | null = null;

    if (input.planCode !== undefined) {
      const plan = await this.repository.findActivePlanByCode(input.planCode);
      if (!plan) {
        throw AppException.validation('Unknown plan.', {
          planCode: ['must be one of the plans currently offered'],
        });
      }
      data['planId'] = plan.id;
      nextPlan = toPlanView(plan);
    }

    if (input.billingInterval !== undefined) {
      data['billingInterval'] = input.billingInterval;
    }

    if (Object.keys(data).length === 0) {
      // Nothing asked for. Returning the unchanged subscription is friendlier
      // than an error and keeps the endpoint idempotent.
      return toSubscriptionView(existing);
    }

    const changed = await this.repository.updateCurrent(data);
    if (changed === 0) {
      throw AppException.notFound(
        ERROR_CODES.SUBSCRIPTION_NOT_FOUND,
        'This organization has no subscription.',
      );
    }

    await this.audit.record({
      action: 'subscription.plan_changed',
      entityType: 'subscription',
      entityId: existing.id,
      before: { plan: existing.plan.code, billingInterval: existing.billingInterval },
      after: {
        plan: nextPlan?.code ?? existing.plan.code,
        billingInterval: input.billingInterval ?? existing.billingInterval,
        changedBy: principal.userId,
      },
    });

    return this.current();
  }

  /**
   * Moves the subscription to a new status, refusing illegal moves.
   *
   * Not reachable over HTTP by design. This is the seam a payment provider
   * webhook will call once one exists: the provider is the system of record for
   * whether money arrived, and nothing else — including an organization's own
   * admin — should be able to declare itself paid.
   */
  async transitionStatus(
    to: SubscriptionStatus,
    reason: string,
    now = new Date(),
  ): Promise<SubscriptionView> {
    const existing = await this.repository.findCurrent();
    if (!existing) {
      throw AppException.notFound(
        ERROR_CODES.SUBSCRIPTION_NOT_FOUND,
        'This organization has no subscription.',
      );
    }

    const from = existing.status as SubscriptionStatus;
    if (!canTransition(from, to)) {
      throw AppException.conflict(
        ERROR_CODES.INVALID_SUBSCRIPTION_TRANSITION,
        `A subscription cannot move from ${from} to ${to}.`,
      );
    }

    const data: Record<string, unknown> = { status: to };
    if (to === 'CANCELLED') data['cancelledAt'] = now;
    // Reactivating clears the cancellation, or the row would claim to be both
    // active and cancelled.
    if (to === 'ACTIVE') data['cancelledAt'] = null;

    await this.repository.updateCurrent(data);

    await this.audit.record({
      action: 'subscription.status_changed',
      entityType: 'subscription',
      entityId: existing.id,
      before: { status: from },
      after: { status: to, reason },
    });

    return this.current();
  }
}

type PlanRow = {
  id: string;
  code: string;
  name: string;
  tagline: string | null;
  description: string | null;
  featured: boolean;
  currency: string;
  monthlyPrice: { toString(): string };
  yearlyPrice: { toString(): string } | null;
  maxUsers: number | null;
  maxActiveLeads: number | null;
  features: string[];
};

function toPlanView(plan: PlanRow): PlanView {
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    tagline: plan.tagline,
    description: plan.description,
    featured: plan.featured,
    currency: plan.currency,
    // Strings, not numbers. Money must not round-trip through a float, and the
    // NUMERIC column type exists precisely to prevent that.
    monthlyPrice: plan.monthlyPrice.toString(),
    yearlyPrice: plan.yearlyPrice?.toString() ?? null,
    maxUsers: plan.maxUsers,
    maxActiveLeads: plan.maxActiveLeads,
    features: plan.features,
  };
}

type SubscriptionRow = {
  id: string;
  status: string;
  billingInterval: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  trialEndsAt: Date | null;
  cancelledAt: Date | null;
  plan: PlanRow;
};

function toSubscriptionView(subscription: SubscriptionRow): SubscriptionView {
  const status = subscription.status as SubscriptionStatus;

  return {
    id: subscription.id,
    status,
    billingInterval: subscription.billingInterval as BillingInterval,
    currentPeriodStart: subscription.currentPeriodStart.toISOString(),
    currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
    trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
    cancelledAt: subscription.cancelledAt?.toISOString() ?? null,
    plan: toPlanView(subscription.plan),
    grantsAccess: grantsAccess(status),
    limitsEnforced: PLAN_LIMITS_ENFORCED,
  };
}
