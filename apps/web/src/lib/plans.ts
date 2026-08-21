/**
 * Pricing, in one place.
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │  PLACEHOLDER PRICING — SET REAL VALUES BEFORE LAUNCH.                 │
 * │                                                                       │
 * │  The numbers below are structure, not a decision. Nobody has agreed   │
 * │  them and they are not benchmarked against any market.                │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * Two things this module deliberately gets right, whatever the numbers end up
 * being:
 *
 *   1. Prices live HERE and nowhere else. They appear on the landing page
 *      today and will appear in a billing screen and in upgrade prompts later.
 *      Three copies of "₹999" drift; one does not.
 *
 *   2. `limits` are DISPLAY COPY, not enforcement. Nothing in the application
 *      currently caps users or leads — see `enforced` below. Anyone reading
 *      this file should know that before quoting a number to a customer.
 */

export interface PlanLimits {
  /** null means "no stated limit" rather than "unlimited and enforced". */
  users: number | null;
  leads: number | null;
}

export interface Plan {
  id: 'free' | 'growth' | 'business';
  name: string;
  /** One line under the plan name. */
  tagline: string;
  /** Monthly price in minor-unit-free whole numbers. 0 renders as "Free". */
  monthlyPrice: number;
  /** Shown when billed annually; null hides the annual option for that plan. */
  annualPrice: number | null;
  limits: PlanLimits;
  features: string[];
  /** The visually emphasised plan. Exactly one should be true. */
  highlighted: boolean;
  cta: { label: string; to: string };
}

/**
 * The currency prices are quoted in.
 *
 * Fixed rather than derived from the visitor's locale. An organization picks
 * its own display currency in Settings, but that is about how THEIR figures are
 * shown — it has nothing to do with what they are charged, and converting a
 * public price by browser locale would advertise a number nobody can pay.
 */
export const PRICING_CURRENCY = 'USD';
export const PRICING_LOCALE = 'en-US';

/**
 * Whether plan limits are enforced by the application.
 *
 * FALSE today, and the landing page says so in plain words. The tables and the
 * PLAN_LIMIT_EXCEEDED error code exist from the original design but nothing
 * throws it: no cap is applied at invite time or at lead creation. Displaying a
 * limit the product does not keep is a promise broken at the worst moment —
 * when a customer discovers it — so the page is explicit that this is early
 * access.
 *
 * Flip this only when the caps are actually implemented AND tested.
 */
export const PLAN_LIMITS_ENFORCED = false;

export const PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Starter',
    tagline: 'For a founder or a first salesperson',
    monthlyPrice: 0,
    annualPrice: 0,
    limits: { users: 3, leads: 500 },
    features: [
      'Up to 3 team members',
      'Lead pipeline and follow-up reminders',
      'WhatsApp and call shortcuts',
      'Daily report',
      'CSV import and export',
    ],
    highlighted: false,
    cta: { label: 'Start free', to: '/register' },
  },
  {
    id: 'growth',
    name: 'Growth',
    tagline: 'For a small sales team that shares a pipeline',
    monthlyPrice: 29,
    annualPrice: 290,
    limits: { users: 15, leads: 10_000 },
    features: [
      'Up to 15 team members',
      'Everything in Starter',
      'Team performance reporting',
      'Lead assignment and reassignment',
      'Duplicate detection and contact merge',
      'Role-based access control',
    ],
    highlighted: true,
    cta: { label: 'Start free trial', to: '/register' },
  },
  {
    id: 'business',
    name: 'Business',
    tagline: 'For multiple teams and stricter reporting needs',
    monthlyPrice: 79,
    annualPrice: 790,
    limits: { users: null, leads: null },
    features: [
      'Unlimited team members',
      'Everything in Growth',
      'Custom date-range reporting',
      'Full administrative audit trail',
      'Employee offboarding with safe handover',
      'Priority support',
    ],
    highlighted: false,
    cta: { label: 'Start free trial', to: '/register' },
  },
];

/** Formats a plan price for display. */
export function formatPlanPrice(amount: number): string {
  if (amount === 0) return 'Free';

  return new Intl.NumberFormat(PRICING_LOCALE, {
    style: 'currency',
    currency: PRICING_CURRENCY,
    maximumFractionDigits: 0,
  }).format(amount);
}

/** Months of a yearly plan you effectively get free, or null. */
export function annualSaving(plan: Plan): number | null {
  if (plan.annualPrice === null || plan.monthlyPrice === 0) return null;

  const fullYear = plan.monthlyPrice * 12;
  if (plan.annualPrice >= fullYear) return null;

  return Math.round(((fullYear - plan.annualPrice) / fullYear) * 100);
}
