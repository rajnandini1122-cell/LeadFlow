/**
 * Billing and entitlement contracts, shared by the API, the web app and (by
 * copy of the views) the CRAVION Admin panel.
 *
 * `evaluateEntitlement` is THE access rule. The API's subscription guard, the
 * billing summary and the web banner all call it, so "may this organization
 * use LeadFlow right now" has one answer. It is a pure function of stored
 * facts and the current instant, computed on every read — never a status that
 * a background job has to remember to update before access changes.
 */
import type { BillingInterval, SubscriptionStatus } from './subscriptions';

/** Calendar days of free access a new organization receives. */
export const TRIAL_DAYS = 30;

/**
 * Days a lapsed paid period keeps access while the customer renews. Renewal is
 * a manual payment (no recurring mandate), so a short grace keeps a customer
 * who pays a day late from being cut off mid-task.
 */
export const PAST_DUE_GRACE_DAYS = 3;

/** Reminders before the end of a trial or a paid period, in days. */
export const REMINDER_DAYS = [7, 3, 1] as const;

export const TRIAL_EXPIRED_MESSAGE =
  'Your LeadFlow free trial has expired. Upgrade to Premium to continue using LeadFlow CRM.';
export const SUBSCRIPTION_EXPIRED_MESSAGE =
  'Your LeadFlow Premium subscription has ended. Renew to continue using LeadFlow CRM.';

/**
 * What the Lifetime plan is, and is not. Shown wherever it is sold.
 */
export const LIFETIME_SCOPE =
  'Lifetime Premium is a one-time payment for one organization. It covers the LeadFlow Premium features as offered at purchase, for as long as LeadFlow is operated, within the same plan limits and fair-use terms as Monthly and Yearly. It does not include unlimited usage or infrastructure, third-party charges (for example WhatsApp or SMS provider fees), or separately sold future products and add-ons. It is not transferable to another organization.';

/** How an organization came to have the access it has. */
export const ENTITLEMENT_DECISIONS = [
  'NEW_TRIAL',
  'TRIAL_ALREADY_USED',
  'PENDING_REVIEW',
  'GRANDFATHERED',
  'COMPLIMENTARY',
  'PAID',
  'EXEMPT',
] as const;
export type EntitlementDecision = (typeof ENTITLEMENT_DECISIONS)[number];

/** The effective state an organization is in right now. */
export const ENTITLEMENT_STATES = [
  'EXEMPT',
  'PENDING_REVIEW',
  'TRIALING',
  'ACTIVE',
  'LIFETIME',
  'COMPLIMENTARY',
  'PAST_DUE',
  'EXPIRED',
  'CANCELLED',
  'SUSPENDED',
  'DEACTIVATED',
] as const;
export type EntitlementState = (typeof ENTITLEMENT_STATES)[number];

export const ACCESS_STATES: readonly EntitlementState[] = [
  'EXEMPT',
  'PENDING_REVIEW',
  'TRIALING',
  'ACTIVE',
  'LIFETIME',
  'COMPLIMENTARY',
  'PAST_DUE',
];

export type AccessHold = 'SUSPENDED' | 'DEACTIVATED';

export interface EntitlementFacts {
  organizationType: 'CUSTOMER' | 'INTERNAL';
  organizationStatus: 'TRIAL' | 'ACTIVE' | 'SUSPENDED';
  deleted: boolean;
  subscription: {
    status: SubscriptionStatus;
    trialEndsAt: Date | null;
    currentPeriodEnd: Date;
    lifetime: boolean;
    complimentaryUntil: Date | null;
    exempt: boolean;
    accessHold: string | null;
    entitlementDecision: string | null;
  } | null;
}

export interface EntitlementResult {
  state: EntitlementState;
  grantsAccess: boolean;
  /** When access ends if nothing changes; null = no end (exempt, lifetime, pending review). */
  accessEndsAt: Date | null;
}

const DAY = 86_400_000;

/**
 * The access rule. Order matters and is the specification:
 *
 *  1. A deleted, suspended or deactivated organization has no access — a hold
 *     outranks every entitlement, so a paid organization can still be stopped.
 *  2. The INTERNAL organization (CRAVION) is exempt — by organization_type,
 *     never by name.
 *  3. A customer with no subscription row keeps access (a registration whose
 *     trial could not be created is a defect to fix, not a customer to lock out).
 *  4. Explicit exemption, Lifetime, and PENDING_REVIEW (existing organizations
 *     awaiting a decision) have access with no end date.
 *  5. Complimentary access until its end.
 *  6. A paid (ACTIVE) period until its end, then PAST_DUE for the grace days.
 *  7. A trial until its end.
 *  8. Otherwise CANCELLED or EXPIRED: no access to paid features.
 */
export function evaluateEntitlement(facts: EntitlementFacts, now: Date): EntitlementResult {
  const t = now.getTime();
  const sub = facts.subscription;
  if (facts.deleted) return { state: 'SUSPENDED', grantsAccess: false, accessEndsAt: null };
  if (facts.organizationType === 'INTERNAL') return { state: 'EXEMPT', grantsAccess: true, accessEndsAt: null };
  if (sub?.accessHold === 'DEACTIVATED') return { state: 'DEACTIVATED', grantsAccess: false, accessEndsAt: null };
  if (facts.organizationStatus === 'SUSPENDED' || sub?.accessHold === 'SUSPENDED') {
    return { state: 'SUSPENDED', grantsAccess: false, accessEndsAt: null };
  }
  if (!sub) return { state: 'PENDING_REVIEW', grantsAccess: true, accessEndsAt: null };
  if (sub.exempt) return { state: 'EXEMPT', grantsAccess: true, accessEndsAt: null };
  if (sub.lifetime) return { state: 'LIFETIME', grantsAccess: true, accessEndsAt: null };
  if (sub.entitlementDecision === 'PENDING_REVIEW') {
    return { state: 'PENDING_REVIEW', grantsAccess: true, accessEndsAt: null };
  }

  // Paid access first, then complimentary, then trial: an organization holding
  // more than one keeps the latest end, and is shown the paid one if paid.
  if ((sub.status === 'ACTIVE' || sub.status === 'PAST_DUE') && sub.currentPeriodEnd.getTime() > t) {
    const comp = sub.complimentaryUntil && sub.complimentaryUntil.getTime() > sub.currentPeriodEnd.getTime() ? sub.complimentaryUntil : null;
    return comp
      ? { state: 'COMPLIMENTARY', grantsAccess: true, accessEndsAt: comp }
      : { state: 'ACTIVE', grantsAccess: true, accessEndsAt: sub.currentPeriodEnd };
  }
  if (sub.complimentaryUntil && sub.complimentaryUntil.getTime() > t) {
    return { state: 'COMPLIMENTARY', grantsAccess: true, accessEndsAt: sub.complimentaryUntil };
  }
  if (sub.status === 'ACTIVE' || sub.status === 'PAST_DUE') {
    const graceEnd = new Date(sub.currentPeriodEnd.getTime() + PAST_DUE_GRACE_DAYS * DAY);
    if (graceEnd.getTime() > t) return { state: 'PAST_DUE', grantsAccess: true, accessEndsAt: graceEnd };
    return { state: 'EXPIRED', grantsAccess: false, accessEndsAt: null };
  }
  if (sub.status === 'TRIAL' && sub.trialEndsAt && sub.trialEndsAt.getTime() > t) {
    return { state: 'TRIALING', grantsAccess: true, accessEndsAt: sub.trialEndsAt };
  }
  if (sub.status === 'CANCELLED') return { state: 'CANCELLED', grantsAccess: false, accessEndsAt: null };
  return { state: 'EXPIRED', grantsAccess: false, accessEndsAt: null };
}

/** Whole days left, rounded up (23 hours left is "1 day"); null when there is no end. */
export function daysRemaining(accessEndsAt: Date | null, now: Date): number | null {
  if (!accessEndsAt) return null;
  return Math.max(0, Math.ceil((accessEndsAt.getTime() - now.getTime()) / DAY));
}

/** The end of a paid period that starts at `from`: calendar months/years, in UTC. */
export function periodEnd(from: Date, interval: BillingInterval): Date | null {
  if (interval === 'LIFETIME') return null;
  const end = new Date(from.getTime());
  if (interval === 'MONTHLY') {
    const day = end.getUTCDate();
    end.setUTCMonth(end.getUTCMonth() + 1);
    // 31 January + 1 month is 28/29 February, not 3 March.
    if (end.getUTCDate() !== day) end.setUTCDate(0);
  } else {
    const month = end.getUTCMonth();
    end.setUTCFullYear(end.getUTCFullYear() + 1);
    if (end.getUTCMonth() !== month) end.setUTCDate(0);
  }
  return end;
}

/** Tax on a base amount, in paise, rounded half up. 1800 bp = 18%. */
export function taxPaise(basePaise: number, rateBp: number): number {
  return Math.round((basePaise * rateBp) / 10_000);
}

/** "₹2,100.40" style decimal string from paise. */
export function paiseToAmount(paise: number): string {
  return (paise / 100).toFixed(2);
}

export interface PlanPriceView {
  id: string;
  planCode: string;
  planName: string;
  interval: BillingInterval;
  version: number;
  currency: string;
  /** Decimal strings in rupees, e.g. "1780.00". */
  baseAmount: string;
  taxRatePercent: string;
  taxAmount: string;
  totalAmount: string;
  taxInclusive: boolean;
  /** MANUAL: renewed by paying again before the period ends. NONE: lifetime. */
  renewal: 'MANUAL' | 'NONE';
}

export type BillingPaymentStatus =
  | 'CREATED'
  | 'PAID'
  | 'FAILED'
  | 'EXPIRED'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED';

export interface BillingPaymentView {
  id: string;
  receipt: string;
  interval: BillingInterval;
  status: BillingPaymentStatus;
  currency: string;
  baseAmount: string;
  taxAmount: string;
  totalAmount: string;
  refundedAmount: string;
  providerPaymentId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface BillingSummaryView {
  state: EntitlementState;
  grantsAccess: boolean;
  billable: boolean;
  accessEndsAt: string | null;
  daysRemaining: number | null;
  trialStartsAt: string | null;
  trialEndsAt: string | null;
  planName: string | null;
  interval: BillingInterval | null;
  lifetime: boolean;
  /** The message to show when access has ended, else null. */
  message: string | null;
  enforcementEnabled: boolean;
  checkoutEnabled: boolean;
  /** Whether the caller may pay (the organization OWNER). */
  canPay: boolean;
  prices: PlanPriceView[];
  payments: BillingPaymentView[];
  lifetimeScope: string;
  supportEmail: string;
}

/** What the browser needs to open Razorpay Checkout. No secret is ever included. */
export interface CheckoutOrderView {
  paymentId: string;
  providerOrderId: string;
  keyId: string;
  amountPaise: number;
  currency: string;
  receipt: string;
  description: string;
  organizationName: string;
  prefill: { name: string; email: string };
}
