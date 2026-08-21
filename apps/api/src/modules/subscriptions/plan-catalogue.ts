/**
 * The plan catalogue, seeded into the `plans` table.
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │  PLACEHOLDER PRICING — NOT COMMERCIALLY APPROVED.                     │
 * │                                                                       │
 * │  These figures are structure, not a decision. Nobody has agreed them  │
 * │  and they are benchmarked against nothing. Set real values before     │
 * │  the product is sold.                                                 │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * The seed UPSERTS by `code`, so editing a price here and re-running the seed
 * updates the catalogue without disturbing any organization already subscribed.
 *
 * Two rules for the feature bullets below, because a pricing page is a promise:
 *
 *   1. Every bullet describes something that EXISTS today. No "AI-powered", no
 *      integrations that are not built, no "enterprise security".
 *   2. Limits are stored but NOT enforced — see PLAN_LIMITS_ENFORCED. The
 *      pricing page says so in plain words rather than implying a cap the
 *      server does not apply.
 */

export interface PlanSeed {
  code: string;
  name: string;
  tagline: string;
  description: string;
  sortOrder: number;
  featured: boolean;
  currency: string;
  monthlyPrice: string;
  yearlyPrice: string | null;
  maxUsers: number | null;
  maxActiveLeads: number | null;
  features: string[];
}

/**
 * The currency the catalogue is priced in.
 *
 * Fixed, and deliberately unrelated to an organization's display currency. A
 * tenant chooses how THEIR figures are shown; that has nothing to do with what
 * they would be charged, and converting a published price by the reader's
 * locale advertises a number nobody can actually pay.
 */
export const CATALOGUE_CURRENCY = 'USD';

export const PLAN_CATALOGUE: PlanSeed[] = [
  {
    code: 'STARTER',
    name: 'Starter',
    tagline: 'For a founder or a first salesperson',
    description: 'Everything needed to stop losing leads, for a very small team.',
    sortOrder: 1,
    featured: false,
    currency: CATALOGUE_CURRENCY,
    monthlyPrice: '0',
    yearlyPrice: '0',
    maxUsers: 3,
    maxActiveLeads: 500,
    features: [
      'Up to 3 team members',
      'Leads, contacts and the full activity timeline',
      'Follow-up scheduling with overdue visibility',
      'Call, note and WhatsApp logging',
      'Dashboard and daily report',
      'CSV import and export',
    ],
  },
  {
    code: 'PROFESSIONAL',
    name: 'Professional',
    tagline: 'For a sales team that shares a pipeline',
    description: 'Adds team visibility, reporting over any date range, and data hygiene.',
    sortOrder: 2,
    featured: true,
    currency: CATALOGUE_CURRENCY,
    monthlyPrice: '29',
    yearlyPrice: '290',
    maxUsers: 15,
    maxActiveLeads: 10_000,
    features: [
      'Up to 15 team members',
      'Everything in Starter',
      'Lead assignment and reassignment',
      'Team performance reporting',
      'Custom date-range reports in your timezone',
      'Duplicate detection and reviewed contact merge',
      'Roles and permissions',
    ],
  },
  {
    code: 'BUSINESS',
    name: 'Business',
    tagline: 'For several teams and stricter oversight',
    description: 'Adds administrative control and a full record of who changed what.',
    sortOrder: 3,
    featured: false,
    currency: CATALOGUE_CURRENCY,
    monthlyPrice: '79',
    yearlyPrice: '790',
    maxUsers: null,
    maxActiveLeads: null,
    features: [
      'No stated team-size limit',
      'Everything in Professional',
      'Administrative audit trail',
      'Safe employee offboarding with lead handover',
      'Organization-wide lead visibility controls',
      'Priority support',
    ],
  },
];

/** Which plan a brand-new organization starts on. */
export const DEFAULT_PLAN_CODE = 'STARTER';

/** How long a new organization's trial runs, in days. */
export const TRIAL_DAYS = 14;
