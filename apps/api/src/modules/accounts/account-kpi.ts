/**
 * Customer KPI formulas.
 *
 * Pure arithmetic, no database — so what each figure MEANS is readable in one
 * place, and testable without a tenant.
 *
 * The discipline is the same one product-kpi.ts already follows, and it is the
 * most important thing in this file: a figure that CANNOT BE CALCULATED comes
 * back as `null`, never as zero. "No customer has bought twice yet" and "the
 * repeat rate is 0%" look identical on a dashboard and mean completely
 * different things — the first is an organization with three customers and no
 * history, the second is a retention problem. Returning 0 for the first states
 * something false about the business.
 */

/**
 * Below this many customers, a rate over them is noise.
 *
 * Two customers where one bought twice is "50% repeat rate", which reads as a
 * finding and is a coin toss. The counts are reported instead, which say
 * exactly as much and claim less.
 */
export const MIN_CUSTOMERS_FOR_RATE = 5;

/** Same reasoning for prospect-to-customer conversion. */
export const MIN_ACCOUNTS_FOR_CONVERSION = 5;

export interface CustomerCounts {
  prospects: number;
  customers: number;
  dormant: number;
  formerCustomers: number;
}

/**
 * Everyone we have a record of.
 *
 * Includes prospects deliberately: an "accounts" total that counted only
 * customers would make the customer base look like the whole database.
 */
export function totalAccounts(counts: CustomerCounts): number {
  return counts.prospects + counts.customers + counts.dormant + counts.formerCustomers;
}

/**
 * Everyone who has ever bought.
 *
 * DORMANT and FORMER_CUSTOMER are counted, because they did buy. A lifetime
 * figure that quietly drops churned customers overstates how well the business
 * converts.
 */
export function everBoughtCount(counts: CustomerCounts): number {
  return counts.customers + counts.dormant + counts.formerCustomers;
}

/**
 * The share of known companies that ever became customers.
 *
 * Null below the sample floor, and null when there are no accounts at all —
 * 0% conversion for an organization that has recorded nothing is a statement
 * about a business that has not started yet.
 */
export function prospectConversionRate(counts: CustomerCounts): number | null {
  const total = totalAccounts(counts);
  if (total === 0) return null;
  if (total < MIN_ACCOUNTS_FOR_CONVERSION) return null;

  return everBoughtCount(counts) / total;
}

/**
 * The share of customers who bought more than once.
 *
 * The denominator is customers who have EVER bought, not all accounts: a
 * prospect cannot repeat, and including them would report a retention problem
 * that is really a pipeline in its early days.
 */
export function repeatCustomerRate(input: {
  customersWithAnyWin: number;
  customersWithMultipleWins: number;
}): number | null {
  if (input.customersWithAnyWin === 0) return null;
  if (input.customersWithAnyWin < MIN_CUSTOMERS_FOR_RATE) return null;

  return input.customersWithMultipleWins / input.customersWithAnyWin;
}

/**
 * Average won value per customer who has bought.
 *
 * Null when nobody has, rather than 0 — no revenue yet is not an average of
 * nothing.
 */
export function averageCustomerValue(input: {
  totalWonValue: number;
  customersWithAnyWin: number;
}): number | null {
  if (input.customersWithAnyWin === 0) return null;
  return input.totalWonValue / input.customersWithAnyWin;
}

/** Average number of won deals per paying customer. */
export function averageWinsPerCustomer(input: {
  totalWins: number;
  customersWithAnyWin: number;
}): number | null {
  if (input.customersWithAnyWin === 0) return null;
  return input.totalWins / input.customersWithAnyWin;
}

/**
 * How much of the won revenue came from customers buying AGAIN.
 *
 * Defined as revenue from every won deal after a customer's first. The first
 * deal is acquisition; everything after it is the relationship paying off, and
 * separating them is the only way to answer whether growth comes from new
 * customers or existing ones.
 */
export function repeatRevenueShare(input: {
  totalWonValue: number;
  repeatWonValue: number;
}): number | null {
  if (input.totalWonValue <= 0) return null;
  return input.repeatWonValue / input.totalWonValue;
}

/**
 * Demand for a product, split by who is asking.
 *
 * `unknown` is reported rather than folded into either side. A lead with no
 * account cannot be attributed, and silently counting it as a prospect would
 * inflate new-business demand with every historical row the backfill has not
 * reached yet.
 */
export interface DemandSplit {
  prospect: number;
  existingCustomer: number;
  unknown: number;
}

export function totalDemand(split: DemandSplit): number {
  return split.prospect + split.existingCustomer + split.unknown;
}

/**
 * The share of ATTRIBUTABLE demand that came from existing customers.
 *
 * Unattributed leads are excluded from the denominator rather than counted
 * against either side, and the caller is expected to show `unknown` beside
 * this so the coverage of the figure is visible.
 */
export function existingCustomerShare(split: DemandSplit): number | null {
  const attributable = split.prospect + split.existingCustomer;
  if (attributable === 0) return null;
  return split.existingCustomer / attributable;
}

/**
 * Whether an account has gone quiet for longer than the tenant's threshold.
 *
 * Reports a fact; it does NOT change a status. Dormancy is applied by a person
 * from the review list, because an account can easily have been active on the
 * phone with nothing written down, and silently reclassifying a live customer
 * would be both wrong and invisible.
 *
 * An account with no recorded activity at all is NOT dormant — it has never
 * been active, so it has not gone quiet. It is a prospect nobody has worked.
 */
export function isDormancyCandidate(input: {
  status: string;
  lastActivityAt: Date | null;
  thresholdDays: number;
  now: Date;
}): boolean {
  if (input.status !== 'CUSTOMER') return false;
  if (input.lastActivityAt === null) return false;

  const elapsedDays =
    (input.now.getTime() - input.lastActivityAt.getTime()) / (1000 * 60 * 60 * 24);

  return elapsedDays >= input.thresholdDays;
}

/**
 * Products this customer has never enquired about.
 *
 * The whole of the V1 cross-sell rule, and deliberately so: it is a set
 * difference over what actually happened, with no model, no score and no
 * ranking pretending to know what they want next. A rep reading "they buy
 * garlic powder and have never asked about garlic flakes" can judge that
 * themselves.
 *
 * Retired products are the caller's responsibility to exclude — suggesting
 * something no longer sold would waste a call.
 */
export function crossSellGaps(input: {
  catalogueProductIds: string[];
  enquiredProductIds: string[];
}): string[] {
  const enquired = new Set(input.enquiredProductIds);
  return input.catalogueProductIds.filter((id) => !enquired.has(id));
}
