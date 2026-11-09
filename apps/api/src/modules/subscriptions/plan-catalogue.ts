/**
 * The plan catalogue, seeded into `plans` and `plan_prices` by bootstrap.
 *
 * Owner-approved pricing (2026-11-07): one plan, LeadFlow Premium, sold three
 * ways. Prices EXCLUDE GST; 18% GST is added at checkout.
 *
 *   Monthly   ₹200   + ₹36.00  GST = ₹236.00    renewed manually each month
 *   Yearly    ₹1,780 + ₹320.40 GST = ₹2,100.40  renewed manually each year
 *   Lifetime  ₹5,000 + ₹900.00 GST = ₹5,900.00  one payment, no renewal
 *
 * Prices live in the database (plan_prices), versioned: changing one is a new
 * version here with a new effective date, never an edit of an old row, so a
 * past payment always points at exactly what it was charged. Nothing in a
 * frontend holds a price.
 *
 * Two rules for the feature bullets, because a pricing page is a promise:
 *   1. Every bullet describes something that EXISTS today.
 *   2. Limits are stored but NOT enforced (PLAN_LIMITS_ENFORCED). They are the
 *      stated fair-use scope of every interval, Lifetime included.
 */
import type { BillingInterval } from '@leadflow/api-types';

export { TRIAL_DAYS } from '@leadflow/api-types';

export interface PlanSeed {
  code: string;
  name: string;
  tagline: string;
  description: string;
  sortOrder: number;
  featured: boolean;
  currency: string;
  /** Base (pre-tax) monthly and yearly prices, kept for the existing plan columns. */
  monthlyPrice: string;
  yearlyPrice: string | null;
  maxUsers: number | null;
  maxActiveLeads: number | null;
  features: string[];
}

export interface PriceSeed {
  planCode: string;
  interval: BillingInterval;
  version: number;
  currency: string;
  basePaise: number;
  /** Basis points: 1800 = 18% GST. */
  taxRateBp: number;
  taxInclusive: boolean;
  renewal: 'MANUAL' | 'NONE';
  effectiveFrom: string;
}

export const CATALOGUE_CURRENCY = 'INR';

export const PLAN_CATALOGUE: PlanSeed[] = [
  {
    code: 'PREMIUM',
    name: 'LeadFlow Premium',
    tagline: 'Everything LeadFlow does, for your whole sales team',
    description:
      'Leads, follow-ups, team visibility, reporting and administration for one organization.',
    sortOrder: 1,
    featured: true,
    currency: CATALOGUE_CURRENCY,
    monthlyPrice: '200',
    yearlyPrice: '1780',
    // Fair-use scope for every interval, Lifetime included. Stated, not yet enforced.
    maxUsers: 25,
    maxActiveLeads: 50_000,
    features: [
      'Up to 25 team members',
      'Leads, contacts and the full activity timeline',
      'Follow-up scheduling with overdue visibility',
      'Lead assignment, teams and territories',
      'Team performance and date-range reporting',
      'Duplicate detection and reviewed contact merge',
      'Roles, permissions and an administrative audit trail',
      'CSV import and export',
    ],
  },
];

export const PRICE_CATALOGUE: PriceSeed[] = [
  { planCode: 'PREMIUM', interval: 'MONTHLY', version: 1, currency: 'INR', basePaise: 20_000, taxRateBp: 1800, taxInclusive: false, renewal: 'MANUAL', effectiveFrom: '2026-11-07T00:00:00.000Z' },
  { planCode: 'PREMIUM', interval: 'YEARLY', version: 1, currency: 'INR', basePaise: 178_000, taxRateBp: 1800, taxInclusive: false, renewal: 'MANUAL', effectiveFrom: '2026-11-07T00:00:00.000Z' },
  { planCode: 'PREMIUM', interval: 'LIFETIME', version: 1, currency: 'INR', basePaise: 500_000, taxRateBp: 1800, taxInclusive: false, renewal: 'NONE', effectiveFrom: '2026-11-07T00:00:00.000Z' },
];

/**
 * Plan codes that are no longer offered.
 *
 * Deactivated rather than deleted on the next seed. An organization already
 * subscribed to one keeps working — its subscription still resolves — but
 * nobody new can choose it, and it disappears from the pricing page. STARTER
 * and BASIC were placeholder plans; the six organizations on STARTER keep
 * their row and await an entitlement decision.
 */
export const WITHDRAWN_PLAN_CODES = ['PROFESSIONAL', 'BUSINESS', 'STARTER', 'BASIC'];

/** Which plan a brand-new organization starts on: a 30-day trial of Premium. */
export const DEFAULT_PLAN_CODE = 'PREMIUM';
