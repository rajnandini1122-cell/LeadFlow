import {
  addZonedDays,
  addZonedMonths,
  formatZonedDate,
  parseZonedDate,
  startOfZonedDay,
  startOfZonedMonth,
  startOfZonedWeek,
  zonedDate,
  type ZonedDate,
} from '../../common/utils/zoned-time';

export const RANGE_PRESETS = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  /*
   * Rolling windows, added for product demand trends.
   *
   * A trend needs a period it can be compared against one of equal length. A
   * calendar month cannot do that — February against January compares 28 days
   * with 31, and demand appears to fall for reasons nobody caused.
   */
  'last_7_days',
  'last_30_days',
  'last_90_days',
  'custom',
] as const;

export type RangePreset = (typeof RANGE_PRESETS)[number];

export interface DateRange {
  preset: RangePreset;
  /** Inclusive lower bound, as an absolute instant. */
  from: Date;
  /**
   * EXCLUSIVE upper bound.
   *
   * Half-open on purpose: `createdAt >= from AND createdAt < to` cannot
   * double-count a row that lands exactly on a boundary, and needs no
   * "23:59:59.999" fudge that silently drops the last millisecond of a day.
   */
  to: Date;
  /** The wall-clock days the range covers, for display. `toDate` is inclusive. */
  fromDate: string;
  toDate: string;
  timezone: string;
}

export class DateRangeError extends Error {}

/** How many days a custom range may span, so one request cannot scan years. */
export const MAX_RANGE_DAYS = 366;

/**
 * Resolves a preset or a custom pair into absolute instants.
 *
 * Every boundary is a wall-clock boundary in the ORGANIZATION's timezone. A
 * server in UTC computing "today" for a team in Chicago rolls the day over at
 * 6pm the previous evening, which moves deals between reporting periods
 * without anyone touching them.
 */
export function resolveDateRange(
  input: { preset?: string | undefined; from?: string | undefined; to?: string | undefined },
  timezone: string,
  now = new Date(),
): DateRange {
  const today = zonedDate(now, timezone);
  const preset = (input.preset ?? (input.from || input.to ? 'custom' : 'today')) as RangePreset;

  if (!RANGE_PRESETS.includes(preset)) {
    throw new DateRangeError(`Unknown range: ${String(input.preset)}`);
  }

  const span = spanFor(preset, today, input);

  const days = daysBetween(span.first, span.last);
  if (days > MAX_RANGE_DAYS) {
    throw new DateRangeError(`Range covers ${days} days; the maximum is ${MAX_RANGE_DAYS}.`);
  }

  return {
    preset,
    from: startOfZonedDay(span.first, timezone),
    // Start of the day AFTER the last one, giving a half-open interval.
    to: startOfZonedDay(addZonedDays(span.last, 1), timezone),
    fromDate: formatZonedDate(span.first),
    toDate: formatZonedDate(span.last),
    timezone,
  };
}

function spanFor(
  preset: RangePreset,
  today: ZonedDate,
  input: { from?: string | undefined; to?: string | undefined },
): { first: ZonedDate; last: ZonedDate } {
  switch (preset) {
    case 'today':
      return { first: today, last: today };

    case 'yesterday': {
      const yesterday = addZonedDays(today, -1);
      return { first: yesterday, last: yesterday };
    }

    case 'this_week': {
      const monday = startOfZonedWeek(today);
      // Ends today, not next Sunday: a week-to-date figure should not be
      // diluted by days that have not happened yet.
      return { first: monday, last: today };
    }

    case 'last_week': {
      const monday = addZonedDays(startOfZonedWeek(today), -7);
      return { first: monday, last: addZonedDays(monday, 6) };
    }

    case 'this_month':
      return { first: startOfZonedMonth(today), last: today };

    case 'last_month': {
      const first = startOfZonedMonth(addZonedMonths(startOfZonedMonth(today), -1));
      const last = addZonedDays(startOfZonedMonth(today), -1);
      return { first, last };
    }

    /*
     * Ends YESTERDAY, not today.
     *
     * Including a partial day would make the most recent bucket smaller than
     * the rest for no reason other than the hour somebody looked, which is
     * exactly the artefact a trend must not show.
     */
    case 'last_7_days':
      return { first: addZonedDays(today, -7), last: addZonedDays(today, -1) };

    case 'last_30_days':
      return { first: addZonedDays(today, -30), last: addZonedDays(today, -1) };

    case 'last_90_days':
      return { first: addZonedDays(today, -90), last: addZonedDays(today, -1) };

    case 'custom': {
      if (!input.from || !input.to) {
        throw new DateRangeError('A custom range needs both from and to.');
      }

      const first = parseZonedDate(input.from);
      const last = parseZonedDate(input.to);

      if (!first || !last) {
        throw new DateRangeError('Dates must be real calendar dates in YYYY-MM-DD form.');
      }
      if (formatZonedDate(first) > formatZonedDate(last)) {
        throw new DateRangeError('The start date must not be after the end date.');
      }

      return { first, last };
    }
  }
}

function daysBetween(first: ZonedDate, last: ZonedDate): number {
  const a = Date.UTC(first.year, first.month - 1, first.day);
  const b = Date.UTC(last.year, last.month - 1, last.day);
  return Math.round((b - a) / 86_400_000) + 1;
}

/**
 * Which timestamp each metric is measured against.
 *
 * Published with every report because the answer changes the number. "Won
 * leads this month" counted by creation date and by close date are different
 * figures, and a report that does not say which it used is not a report.
 */
export const METRIC_BASIS = {
  totalLeads: 'snapshot — every lead in the organization that is not archived',
  newLeads: 'lead created date',
  activeLeads: 'snapshot — current status is not WON or LOST',
  wonLeads: 'lead won date',
  lostLeads: 'lead lost date',
  archivedLeads: 'lead archived date',
  statusDistribution: 'current status of leads created in the range',
  sourceDistribution: 'lead created date',
  wonValue: 'lead won date',
  pipelineValue: 'snapshot — estimated value of currently active leads',
  conversionRate: 'won and lost dates within the range',
  lostReasons: 'lead lost date',
  followUpsDueToday: 'follow-up scheduled date, today in the organization timezone',
  overdueFollowUps: 'snapshot — open follow-ups scheduled before now',
  completedFollowUps: 'follow-up completed date',
  followUpCompletionRate: 'follow-ups scheduled within the range, by their current state',
} as const;
