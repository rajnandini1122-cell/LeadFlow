/**
 * Day and hour boundaries for platform analytics.
 *
 * Days are counted in ONE fixed timezone, Asia/Kolkata, because the platform
 * owner reads "today" in India and organizations span timezones. Hours are
 * stored as UTC instants (timezone-free). Both are documented on the dashboard.
 */
export const ANALYTICS_TIMEZONE = 'Asia/Kolkata';

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: ANALYTICS_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The calendar day (in ANALYTICS_TIMEZONE) as a DATE value: midnight UTC of that date. */
export function analyticsDay(at: Date): Date {
  return new Date(`${dayFormat.format(at)}T00:00:00.000Z`);
}

/** The start of the UTC hour containing `at`. */
export function hourStart(at: Date): Date {
  const d = new Date(at);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

/** `days` calendar days before today's analytics day (0 = today). */
export function daysAgo(now: Date, days: number): Date {
  const today = analyticsDay(now);
  return new Date(today.getTime() - days * 86_400_000);
}

/** Latency histogram upper bounds (ms); the last bucket is everything above. */
export const LATENCY_BOUNDS_MS = [25, 50, 100, 250, 500, 1000, 2500, 5000] as const;

export function latencyBucket(ms: number): number {
  const index = LATENCY_BOUNDS_MS.findIndex((bound) => ms <= bound);
  return index === -1 ? LATENCY_BOUNDS_MS.length : index;
}

/**
 * The p-th percentile from a histogram, as the UPPER BOUND of the bucket it
 * falls in (null above the last bound: "over 5 s"). An estimate, labelled as
 * such on the dashboard -- exact percentiles would need every request stored.
 */
export function histogramPercentile(buckets: number[], p: number): number | null {
  const total = buckets.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const target = Math.ceil((p / 100) * total);
  let seen = 0;
  for (let i = 0; i < buckets.length; i++) {
    seen += buckets[i] ?? 0;
    if (seen >= target)
      return i < LATENCY_BOUNDS_MS.length ? (LATENCY_BOUNDS_MS[i] as number) : null;
  }
  return null;
}
