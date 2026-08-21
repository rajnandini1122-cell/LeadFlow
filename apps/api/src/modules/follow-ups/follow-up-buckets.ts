import type { FollowUpStatus } from '../../generated/prisma/enums';

/**
 * The four views a salesperson actually works from.
 *
 * Buckets are derived from `scheduledAt` against the ORGANIZATION's timezone,
 * not the server's and not the browser's. "Today" for a team in Chicago is a
 * different window from "today" in London, and a UTC server would roll the day
 * over mid-afternoon for one of them.
 */
export type Bucket = 'today' | 'upcoming' | 'overdue' | 'completed';

export const OPEN_STATUSES: FollowUpStatus[] = ['UPCOMING', 'DUE', 'OVERDUE'];

/**
 * Start of the current day in a given IANA timezone, as an absolute instant.
 *
 * Uses Intl rather than date arithmetic because only the tz database knows
 * about daylight saving and historical offset changes; subtracting a fixed
 * offset is wrong twice a year.
 */
export function startOfDayInZone(timezone: string, reference = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(reference);

  const get = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  // How far the tenant's local wall clock is into its own day.
  const elapsedMs =
    (get('hour') % 24) * 3_600_000 + get('minute') * 60_000 + get('second') * 1000;

  return new Date(reference.getTime() - elapsedMs - (reference.getMilliseconds() % 1000));
}

export interface BucketWindow {
  statuses: FollowUpStatus[];
  from?: Date | undefined;
  to?: Date | undefined;
}

export function windowFor(bucket: Bucket, timezone: string, now = new Date()): BucketWindow {
  const startOfToday = startOfDayInZone(timezone, now);
  const startOfTomorrow = new Date(startOfToday.getTime() + 86_400_000);

  switch (bucket) {
    case 'overdue':
      // Anything still open whose moment has passed — including earlier today,
      // because a follow-up scheduled for 09:00 is late by 11:00.
      return { statuses: OPEN_STATUSES, to: now };

    case 'today':
      // Scheduled later today. Earlier-today items belong to `overdue`, or they
      // would appear twice and the overdue count would understate the problem.
      return { statuses: OPEN_STATUSES, from: now, to: startOfTomorrow };

    case 'upcoming':
      return { statuses: OPEN_STATUSES, from: startOfTomorrow };

    case 'completed':
      return { statuses: ['COMPLETED'] };
  }
}
