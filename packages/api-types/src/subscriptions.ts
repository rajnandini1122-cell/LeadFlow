/**
 * Subscription contracts, shared by the API and both clients.
 *
 * The state machine lives here rather than in the API alone so a client can
 * grey out an impossible action for the same reason the server would refuse
 * it — one definition, not two that drift.
 */

export const SUBSCRIPTION_STATUSES = [
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'CANCELLED',
  'EXPIRED',
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const BILLING_INTERVALS = ['MONTHLY', 'YEARLY'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

/**
 * Legal status transitions.
 *
 * Deliberately restrictive, and worth reading as a set of refusals:
 *
 *   - Nothing returns to TRIAL. A trial is a one-time state; allowing a return
 *     would let an organization cycle free periods indefinitely.
 *   - ACTIVE does not go straight to EXPIRED. Something must first observe a
 *     failed payment (PAST_DUE) or an explicit cancellation, so an account is
 *     never cut off without a recorded reason.
 *   - A terminal state can be reactivated, because a customer who comes back
 *     is the point of keeping the row at all.
 */
export const SUBSCRIPTION_TRANSITIONS: Record<SubscriptionStatus, SubscriptionStatus[]> = {
  TRIAL: ['ACTIVE', 'CANCELLED', 'EXPIRED'],
  ACTIVE: ['PAST_DUE', 'CANCELLED'],
  PAST_DUE: ['ACTIVE', 'CANCELLED', 'EXPIRED'],
  CANCELLED: ['ACTIVE'],
  EXPIRED: ['ACTIVE'],
};

/**
 * Whether a status change is allowed.
 *
 * A no-op transition is refused rather than ignored: it is almost always a
 * duplicate webhook or a double-clicked button, and treating it as success
 * hides that.
 */
export function canTransition(from: SubscriptionStatus, to: SubscriptionStatus): boolean {
  return SUBSCRIPTION_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Statuses that still grant access to the application.
 *
 * PAST_DUE is included on purpose. Locking a customer out on the first failed
 * charge — usually an expired card — loses accounts that a retry would have
 * recovered. Access ends at CANCELLED or EXPIRED, which are decisions rather
 * than accidents.
 */
export const ACCESS_GRANTING_STATUSES: SubscriptionStatus[] = ['TRIAL', 'ACTIVE', 'PAST_DUE'];

export function grantsAccess(status: SubscriptionStatus): boolean {
  return ACCESS_GRANTING_STATUSES.includes(status);
}

/** A plan as the public pricing page and the billing screen see it. */
export interface PlanView {
  id: string;
  code: string;
  name: string;
  tagline: string | null;
  description: string | null;
  featured: boolean;
  currency: string;
  /** Decimal strings, never floats — money must not round-trip through one. */
  monthlyPrice: string;
  yearlyPrice: string | null;
  /** null means "no stated limit" for that dimension. */
  maxUsers: number | null;
  maxActiveLeads: number | null;
  features: string[];
}

export interface SubscriptionView {
  id: string;
  status: SubscriptionStatus;
  billingInterval: BillingInterval;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialEndsAt: string | null;
  cancelledAt: string | null;
  plan: PlanView;
  /** Derived, so a client need not reimplement the access rule. */
  grantsAccess: boolean;
  /**
   * Whether plan limits are actually applied by the server.
   *
   * False today. Published so a client never implies a cap the product does
   * not enforce.
   */
  limitsEnforced: boolean;
}
