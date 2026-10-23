import type { FollowUpStatus } from '../../generated/prisma/enums';
import { AWAITING_RESPONSE_OUTCOMES } from '@leadflow/api-types';
import {
  addZonedDays,
  startOfDay,
  startOfZonedDay,
  startOfZonedWeek,
  zonedDate,
} from '../../common/utils/zoned-time';

/**
 * The views a salesperson works from.
 *
 * Buckets are derived from `scheduledAt` (or `completedAt`) against the
 * ORGANIZATION's timezone — Asia/Kolkata for CRAVION — never the server's and
 * never the browser's. "Today" for a team in Mumbai is a different window from
 * "today" on a UTC server, which would roll the day over at 05:30 IST.
 *
 * ONE definition, used by the lists, the counts and the workspace tiles alike,
 * so a tile can never claim a number its list does not show.
 *
 * Overdue and Today are DISJOINT on purpose: a follow-up due at 09:00 is late
 * by 11:00 and belongs to Overdue, not to both — counting it twice would
 * overstate the day's work and understate how much is late. Tomorrow and This
 * week are narrower views INSIDE Upcoming, offered as filters, not extra work.
 */
export type Bucket =
  | 'overdue'
  | 'today'
  | 'tomorrow'
  | 'week'
  | 'upcoming'
  | 'awaiting'
  | 'completed'
  | 'completed_today';

export const BUCKETS: readonly Bucket[] = [
  'overdue',
  'today',
  'tomorrow',
  'week',
  'upcoming',
  'awaiting',
  'completed',
  'completed_today',
];

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
  /** Range on scheduledAt. */
  from?: Date | undefined;
  to?: Date | undefined;
  /** Range on completedAt, for the completed views. */
  completedFrom?: Date | undefined;
  completedTo?: Date | undefined;
  /** A condition on the follow-up's LEAD (Prisma `where.lead`). */
  lead?: Record<string, unknown> | undefined;
  /**
   * Which end of the list matters. Open work is read soonest-first; finished
   * work newest-first — sorting completions by scheduled date ascending put the
   * OLDEST first, so past the page limit today's completions were not shown.
   */
  order: 'scheduled_asc' | 'completed_desc';
}

export function windowFor(bucket: Bucket, timezone: string, now = new Date()): BucketWindow {
  // Calendar arithmetic, not +86,400,000ms: a day on which the zone changes
  // offset is 23 or 25 hours long, so a fixed millisecond step puts the
  // boundary an hour out and leaks one hour of work into the wrong bucket.
  const today = zonedDate(now, timezone);
  const startOfToday = startOfZonedDay(today, timezone);
  const startOfTomorrow = startOfZonedDay(addZonedDays(today, 1), timezone);
  const startOfDayAfter = startOfZonedDay(addZonedDays(today, 2), timezone);
  // ISO weeks start on Monday (see startOfZonedWeek).
  const startOfNextWeek = startOfZonedDay(addZonedDays(startOfZonedWeek(today), 7), timezone);

  switch (bucket) {
    case 'overdue':
      // Anything still open whose moment has passed — including earlier today,
      // because a follow-up scheduled for 09:00 is late by 11:00.
      return { statuses: OPEN_STATUSES, to: now, order: 'scheduled_asc' };

    case 'today':
      // Scheduled later today. Earlier-today items belong to `overdue`, or they
      // would appear twice and the overdue count would understate the problem.
      return { statuses: OPEN_STATUSES, from: now, to: startOfTomorrow, order: 'scheduled_asc' };

    case 'tomorrow':
      return {
        statuses: OPEN_STATUSES,
        from: startOfTomorrow,
        to: startOfDayAfter,
        order: 'scheduled_asc',
      };

    case 'week':
      // The rest of this week after today. Empty on a Sunday, by design: the
      // next week's work is Upcoming, not "this week".
      return {
        statuses: OPEN_STATUSES,
        from: startOfTomorrow,
        to: startOfNextWeek > startOfTomorrow ? startOfNextWeek : startOfTomorrow,
        order: 'scheduled_asc',
      };

    case 'upcoming':
      return { statuses: OPEN_STATUSES, from: startOfTomorrow, order: 'scheduled_asc' };

    case 'awaiting':
      // Open follow-ups on leads waiting on the CUSTOMER: the last call left
      // them owing an answer, or a quotation is out with them. Any date —
      // waiting is a state, not a day.
      return {
        statuses: OPEN_STATUSES,
        lead: {
          status: { notIn: ['WON', 'LOST'] },
          OR: [{ lastOutcome: { in: [...AWAITING_RESPONSE_OUTCOMES] } }, { status: 'QUOTATION_SENT' }],
        },
        order: 'scheduled_asc',
      };

    case 'completed':
      return { statuses: ['COMPLETED'], order: 'completed_desc' };

    case 'completed_today':
      return {
        statuses: ['COMPLETED'],
        completedFrom: startOfToday,
        completedTo: startOfTomorrow,
        order: 'completed_desc',
      };
  }
}

/**
 * The Prisma WHERE for a bucket — the ONLY place one is built.
 *
 * The list, its count and every dashboard or workspace tile go through here,
 * so "6 overdue" on a tile and the six rows behind it come from one predicate.
 * `restrictToUserId` (from permissions) always wins over `assignedUserId`
 * (from the query string): it can narrow a view, never widen it.
 */
export function bucketWhere(
  window: BucketWindow,
  scope: { assignedUserId?: string | undefined; restrictToUserId?: string | undefined } = {},
): Record<string, unknown> {
  const where: Record<string, unknown> = { status: { in: window.statuses } };

  const owner = scope.restrictToUserId ?? scope.assignedUserId;
  if (owner) where['assignedUserId'] = owner;

  if (window.from || window.to) {
    where['scheduledAt'] = {
      ...(window.from ? { gte: window.from } : {}),
      ...(window.to ? { lt: window.to } : {}),
    };
  }
  if (window.completedFrom || window.completedTo) {
    where['completedAt'] = {
      ...(window.completedFrom ? { gte: window.completedFrom } : {}),
      ...(window.completedTo ? { lt: window.completedTo } : {}),
    };
  }
  if (window.lead) where['lead'] = window.lead;

  return where;
}

/** The ORDER BY that goes with a bucket's window. */
export function bucketOrder(window: BucketWindow): Record<string, 'asc' | 'desc'>[] {
  return window.order === 'completed_desc'
    ? [{ completedAt: 'desc' }, { id: 'desc' }]
    : [{ scheduledAt: 'asc' }, { id: 'asc' }];
}
