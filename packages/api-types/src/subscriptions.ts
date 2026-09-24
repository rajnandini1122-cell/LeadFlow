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

/**
 * WHY an organization is entitled to use LeadFlow.
 *
 * Two answers, and keeping them separate is the point:
 *
 *   CUSTOMER_SUBSCRIPTION  the ordinary case. A plan, a period, a trial or a
 *                          payment, and the status machine above decides.
 *
 *   PLATFORM_INTERNAL      CRAVION operating its own platform. There is no
 *                          plan, no period and no payment, because there is
 *                          nobody to bill — the operator billing itself is a
 *                          fiction that would then have to be maintained
 *                          forever, with a trial that expires and an invoice
 *                          nobody sends.
 *
 * Stated as its own dimension rather than as a sixth SubscriptionStatus. A
 * status is a position in the customer lifecycle, and every transition rule,
 * dunning path and expiry sweep is written against that lifecycle. Adding
 * INTERNAL to it would put a state into the machine that must never transition,
 * never expire and never be billed — a special case in every one of those
 * rules. This way the customer state machine is untouched.
 */
export const ENTITLEMENT_SOURCES = ['CUSTOMER_SUBSCRIPTION', 'PLATFORM_INTERNAL'] as const;
export type EntitlementSource = (typeof ENTITLEMENT_SOURCES)[number];

/**
 * What an organization is entitled to, and why.
 *
 * ONE place both clients and the server read the answer from, so "may this
 * organization use the product" and "should it be shown a payment prompt" are
 * not re-derived — and not re-derived differently — in a guard, a controller
 * and a React component.
 */
export interface EntitlementView {
  source: EntitlementSource;
  /** Whether the organization may use the product at all. */
  grantsAccess: boolean;
  /**
   * Whether anything about billing should be shown: price, trial countdown,
   * upgrade prompt, payment warning.
   *
   * False for the platform operator. Not because the bill is paid — there is no
   * bill — so a client must not present this as "paid".
   */
  billable: boolean;
  /** Seat cap, or null for no stated limit. */
  maxUsers: number | null;
  /** Active-lead cap, or null for no stated limit. */
  maxActiveLeads: number | null;
  /**
   * Whether the server actually applies the caps above.
   *
   * Published so a client never implies a limit the product does not enforce.
   */
  limitsEnforced: boolean;
  /** Present only for CUSTOMER_SUBSCRIPTION. Null for the platform operator. */
  subscription: SubscriptionView | null;
}

/**
 * The platform operator's entitlement.
 *
 * Unlimited, unbillable, permanent, and derived in one function so no caller
 * assembles its own version. `limitsEnforced` follows the customer value it is
 * given rather than being hardcoded false: if limits are ever enforced, the
 * honest statement for an organization with no caps is still "enforced, and
 * there are none".
 */
export function platformInternalEntitlement(limitsEnforced: boolean): EntitlementView {
  return {
    source: 'PLATFORM_INTERNAL',
    grantsAccess: true,
    billable: false,
    maxUsers: null,
    maxActiveLeads: null,
    limitsEnforced,
    subscription: null,
  };
}

/** A customer's entitlement, derived from their subscription. */
export function customerEntitlement(subscription: SubscriptionView): EntitlementView {
  return {
    source: 'CUSTOMER_SUBSCRIPTION',
    grantsAccess: subscription.grantsAccess,
    billable: true,
    maxUsers: subscription.plan.maxUsers,
    maxActiveLeads: subscription.plan.maxActiveLeads,
    limitsEnforced: subscription.limitsEnforced,
    subscription,
  };
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
