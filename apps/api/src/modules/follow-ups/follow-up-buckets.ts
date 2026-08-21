import type { FollowUpStatus } from '../../generated/prisma/enums';
import { addZonedDays, startOfDay, startOfZonedDay, zonedDate } from '../../common/utils/zoned-time';

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
 * Delegates to the shared calendar helpers so bucketing and reporting cannot
 * disagree about where a day begins — two implementations of "midnight" is
 * exactly how a dashboard ends up contradicting the screen it links to.
 */
export function startOfDayInZone(timezone: string, reference = new Date()): Date {
  return startOfDay(reference, timezone);
}

export interface BucketWindow {
  statuses: FollowUpStatus[];
  from?: Date | undefined;
  to?: Date | undefined;
}

export function windowFor(bucket: Bucket, timezone: string, now = new Date()): BucketWindow {
  // Calendar arithmetic, not +86,400,000ms: a day on which the zone changes
  // offset is 23 or 25 hours long, so a fixed millisecond step puts the
  // boundary an hour out and leaks one hour of work into the wrong bucket.
  const startOfTomorrow = startOfZonedDay(addZonedDays(zonedDate(now, timezone), 1), timezone);

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
