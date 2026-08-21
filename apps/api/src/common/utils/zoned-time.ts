/**
 * Calendar arithmetic in a named IANA timezone.
 *
 * Every reporting boundary in the product — "today", "this week", "last month"
 * — is a wall-clock boundary in the ORGANIZATION's timezone, not the server's
 * and not the viewer's. A UTC server computing "today" for a team in Chicago
 * rolls the day over at 6pm the previous evening, which silently moves deals
 * between reporting periods.
 *
 * Everything here goes through Intl, because only the tz database knows about
 * daylight saving and historical offset changes. Subtracting a fixed offset is
 * wrong twice a year, and wrong in a way nobody notices until a month-end
 * figure disagrees with the one from last month.
 */

export interface ZonedDate {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let existing = cache.get(timezone);
  if (!existing) {
    existing = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    cache.set(timezone, existing);
  }
  return existing;
}

function partsOf(instant: Date, timezone: string): Record<string, number> {
  const parts = formatter(timezone).formatToParts(instant);
  const result: Record<string, number> = {};

  for (const part of parts) {
    if (part.type !== 'literal') result[part.type] = Number(part.value);
  }

  // `hour12: false` still renders midnight as 24 in some ICU versions.
  if (result['hour'] === 24) result['hour'] = 0;
  return result;
}

/** The zone's UTC offset in milliseconds at a given instant. */
function offsetAt(instant: Date, timezone: string): number {
  const parts = partsOf(instant, timezone);
  const asIfUtc = Date.UTC(
    parts['year'] as number,
    (parts['month'] as number) - 1,
    parts['day'] as number,
    parts['hour'] as number,
    parts['minute'] as number,
    parts['second'] as number,
  );

  return asIfUtc - instant.getTime();
}

/** The wall-clock calendar date in `timezone` at a given instant. */
export function zonedDate(instant: Date, timezone: string): ZonedDate {
  const parts = partsOf(instant, timezone);
  return {
    year: parts['year'] as number,
    month: parts['month'] as number,
    day: parts['day'] as number,
  };
}

/**
 * The instant at which a wall-clock midnight occurs in `timezone`.
 *
 * Resolved in two passes. The first guess uses the offset in force at the
 * naive UTC instant, which is the wrong side of a DST transition roughly twice
 * a year; the second pass re-reads the offset at the corrected instant and
 * uses it if it changed. Without the second pass, the day after a spring-
 * forward starts an hour late and every "today" count is off.
 */
export function startOfZonedDay(date: ZonedDate, timezone: string): Date {
  const naive = Date.UTC(date.year, date.month - 1, date.day, 0, 0, 0);

  const firstGuess = naive - offsetAt(new Date(naive), timezone);
  const secondGuess = naive - offsetAt(new Date(firstGuess), timezone);

  /*
   * Neither guess is reliable on its own, and they fail in OPPOSITE directions.
   *
   * A single pass uses the offset in force at the naive UTC instant, which is
   * the wrong side of a transition roughly twice a year: in Pacific/Chatham on
   * 27 September 2026 it lands at 23:00 the previous day.
   *
   * Correcting with a second pass fixes that but breaks the case where local
   * midnight does not EXIST — America/Santiago springs forward at 24:00, so on
   * 6 September 2026 the day begins at 01:00, and the second pass overshoots to
   * 23:00 on the 5th. Same for Havana and São Paulo.
   *
   * So neither is chosen by rule. Both are computed and the one that actually
   * lands on the requested calendar date wins; when both do, the earlier is
   * taken, which is the first occurrence of a midnight that happens twice after
   * a fall-back.
   */
  const candidates = [firstGuess, secondGuess]
    .map((instant) => new Date(instant))
    .filter((instant) => {
      const landed = zonedDate(instant, timezone);
      return (
        landed.year === date.year && landed.month === date.month && landed.day === date.day
      );
    })
    .sort((a, b) => a.getTime() - b.getTime());

  // Nothing matched: the whole day is skipped by the zone, which no real
  // timezone does. Falling back to the corrected guess beats returning
  // undefined and turning a date bug into a crash.
  return candidates[0] ?? new Date(secondGuess);
}

/** Start of the day containing `instant`, in `timezone`. */
export function startOfDay(instant: Date, timezone: string): Date {
  return startOfZonedDay(zonedDate(instant, timezone), timezone);
}

/**
 * Adds calendar days.
 *
 * Deliberately calendar arithmetic rather than adding 86,400,000ms: a DST day
 * is 23 or 25 hours long, so "tomorrow" is not always a fixed number of
 * milliseconds away.
 */
export function addZonedDays(date: ZonedDate, days: number): ZonedDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

export function addZonedMonths(date: ZonedDate, months: number): ZonedDate {
  const targetMonth = date.month - 1 + months;
  const year = date.year + Math.floor(targetMonth / 12);
  const month = ((targetMonth % 12) + 12) % 12;

  // Clamped, so "one month before 31 March" is 28 February rather than
  // rolling forward into March again.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  return { year, month: month + 1, day: Math.min(date.day, lastDay) };
}

/** 0 = Sunday … 6 = Saturday, for a wall-clock date. */
export function zonedWeekday(date: ZonedDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/**
 * Start of the ISO week (Monday) containing `date`.
 *
 * Monday rather than Sunday because ISO-8601 says so and because a sales week
 * that starts on Sunday splits the weekend across two reports. Made a constant
 * here rather than a per-tenant setting until someone actually asks.
 */
export function startOfZonedWeek(date: ZonedDate): ZonedDate {
  const weekday = zonedWeekday(date);
  const daysSinceMonday = (weekday + 6) % 7;
  return addZonedDays(date, -daysSinceMonday);
}

export function startOfZonedMonth(date: ZonedDate): ZonedDate {
  return { year: date.year, month: date.month, day: 1 };
}

/** `YYYY-MM-DD` for a wall-clock date — the form the API speaks. */
export function formatZonedDate(date: ZonedDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

/** Parses `YYYY-MM-DD`, rejecting anything that is not a real calendar date. */
export function parseZonedDate(input: string): ZonedDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // Round-trips through UTC to reject 2026-02-30, which naive range checks let
  // through and which Postgres would then refuse mid-query.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() + 1 !== month ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

/** True when `timezone` is a zone Intl recognises. */
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
