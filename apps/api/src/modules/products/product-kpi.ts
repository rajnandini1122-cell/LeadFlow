/**
 * Product KPI arithmetic.
 *
 * Pure, so every formula is cheap to test and every edge case is visible in one
 * place. The edge cases are most of the value here: a win rate computed from
 * zero closed deals, an average from zero wins, or a trend from two leads are
 * all easy to produce and all misleading.
 *
 * The rule throughout: when a figure cannot legitimately be calculated, return
 * NULL rather than zero. Zero is a measurement — "we won none of them" — and
 * showing it for "nothing has closed yet" tells management something untrue
 * about a product that is doing fine.
 */

/** Below this many closed deals, a rate is noise dressed as a number. */
export const MIN_SAMPLE_FOR_RATE = 3;

/**
 * Combined leads across both periods below which a percentage is withheld.
 *
 * Ten is a judgement, not a statistic: two leads becoming three is "+50%",
 * which reads as a trend and is noise, and a dashboard that prints that trains
 * people to ignore every percentage on it. The direction is still shown, and
 * the raw counts go out alongside, so nothing is hidden — only the misleading
 * precision.
 */
export const MIN_SAMPLE_FOR_TREND = 10;

/**
 * Win rate over CLOSED deals only.
 *
 * Open leads are deliberately excluded from the denominator. Including them
 * would make every product's win rate fall simply for having a healthy
 * pipeline, and would make a brand-new product look like a failure.
 *
 * Null when nothing has closed: "no deals closed yet" is not "0% win rate".
 */
export function winRate(won: number, lost: number): number | null {
  const closed = won + lost;
  if (closed === 0) return null;
  return round(won / closed, 4);
}

/**
 * Whether a rate is backed by enough deals to show as a percentage.
 *
 * One win out of one is a 100% win rate and tells nobody anything. The caller
 * shows the raw counts instead when this is false.
 */
export function rateIsReliable(won: number, lost: number): boolean {
  return won + lost >= MIN_SAMPLE_FOR_RATE;
}

/**
 * Average value of the deals actually won.
 *
 * Divides by WON COUNT, not total leads: the question is "what does a sale of
 * this product bring in", and dividing by leads that never closed answers a
 * different question much less flatteringly.
 *
 * Null when nothing has been won, or when the wins carry no recorded value.
 */
export function averageWonValue(totalWonValue: number | null, wonCount: number): number | null {
  if (wonCount === 0 || totalWonValue === null) return null;
  return round(totalWonValue / wonCount, 2);
}

/**
 * Mean days from creation to won, per product.
 *
 * Null for a product with no wins. A product nobody has closed yet has no
 * time-to-close, and showing 0 would rank it as the fastest.
 */
export function averageDaysToClose(
  durations: { createdAt: Date; wonAt: Date | null }[],
): number | null {
  const days = durations
    .filter((row): row is { createdAt: Date; wonAt: Date } => row.wonAt !== null)
    .map((row) => (row.wonAt.getTime() - row.createdAt.getTime()) / 86_400_000)
    // A clock skew or a backdated import can produce a negative interval.
    // Dropping it is better than letting it pull the mean below zero.
    .filter((value) => value >= 0);

  if (days.length === 0) return null;
  return round(days.reduce((sum, value) => sum + value, 0) / days.length, 1);
}

export interface ForecastAccuracy {
  /** What the won deals were estimated at, before they closed. */
  estimated: number | null;
  /** What they actually closed at. */
  actual: number | null;
  /** actual - estimated. Positive means the estimate was conservative. */
  variance: number | null;
  /**
   * How close the estimate was, as a fraction.
   *
   * `1 - |actual - estimated| / estimated`, floored at 0 — an estimate that was
   * wrong by more than itself is simply "0% accurate" rather than a negative
   * number nobody can interpret.
   */
  accuracy: number | null;
}

/**
 * How good the forecast was, measured only on deals that CLOSED WON.
 *
 * Open leads cannot be scored: their estimate has not been tested yet.
 * Comparing a live pipeline estimate against a won total would measure how
 * much is still open, not how accurate anyone was.
 *
 * This is only possible because the schema keeps `estimatedValue` and
 * `wonValue` separate — overwriting the estimate on close would destroy the
 * only evidence of what was predicted.
 */
export function forecastAccuracy(
  estimatedOnWon: number | null,
  actualOnWon: number | null,
): ForecastAccuracy {
  if (estimatedOnWon === null || actualOnWon === null || estimatedOnWon === 0) {
    return { estimated: estimatedOnWon, actual: actualOnWon, variance: null, accuracy: null };
  }

  const variance = round(actualOnWon - estimatedOnWon, 2);
  const accuracy = Math.max(0, 1 - Math.abs(variance) / estimatedOnWon);

  return {
    estimated: round(estimatedOnWon, 2),
    actual: round(actualOnWon, 2),
    variance,
    accuracy: round(accuracy, 4),
  };
}

export type TrendDirection = 'rising' | 'falling' | 'stable' | 'new' | 'insufficient';

export interface Trend {
  current: number;
  previous: number;
  /** Fractional change. Null when it would be misleading or undefined. */
  change: number | null;
  direction: TrendDirection;
}

/**
 * Period-over-period demand change.
 *
 * The interesting part is what it REFUSES to report:
 *
 *   - a product with no leads in the previous period has no percentage at all,
 *     because dividing by zero is not "infinite growth" — it is `new`;
 *   - small numbers get a direction but no percentage. Two leads becoming three
 *     is "+50%", which reads as a trend and is noise. The caller shows the
 *     counts instead.
 *
 * A dashboard that prints +50% for one extra enquiry trains people to ignore
 * it, which costs more than the missing number.
 */
export function demandTrend(current: number, previous: number): Trend {
  if (previous === 0) {
    return {
      current,
      previous,
      change: null,
      direction: current > 0 ? 'new' : 'stable',
    };
  }

  if (current + previous < MIN_SAMPLE_FOR_TREND) {
    const raw = (current - previous) / previous;
    return {
      current,
      previous,
      change: null,
      direction: raw > 0 ? 'rising' : raw < 0 ? 'falling' : 'stable',
    };
  }

  const change = round((current - previous) / previous, 4);

  return {
    current,
    previous,
    change,
    // A few percent either way is noise in most datasets; calling it "stable"
    // keeps the rising/falling lists to things worth looking at.
    direction: change > 0.05 ? 'rising' : change < -0.05 ? 'falling' : 'stable',
  };
}

/**
 * A product's share of total product demand.
 *
 * Null when nothing has a product yet, rather than 0 — with an empty catalogue
 * every share would read as "0% of demand", which is not true of anything.
 */
export function demandShare(productLeads: number, totalProductLeads: number): number | null {
  if (totalProductLeads === 0) return null;
  return round(productLeads / totalProductLeads, 4);
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Prisma returns Decimal; every KPI here works in plain numbers. */
export function toNumber(value: { toString(): string } | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value.toString());
  return Number.isFinite(parsed) ? parsed : null;
}
