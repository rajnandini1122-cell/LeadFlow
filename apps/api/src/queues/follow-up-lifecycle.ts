/**
 * When a follow-up becomes due, overdue, and escalated.
 *
 * Pure functions, no database and no clock of their own — every decision takes
 * `now` as an argument, so the boundaries can be tested exactly rather than
 * approximately. That matters here more than usual: the whole product promise
 * is that nothing is forgotten, and a lifecycle that is right except at
 * midnight is a lifecycle that loses leads at midnight.
 *
 * The transitions themselves are deliberately one-way. A follow-up moves
 * UPCOMING → DUE → OVERDUE and never back. Reversing would mean a reminder
 * already sent could be sent again, and worse, a rep who saw "overdue" and
 * acted would watch it silently become "upcoming" again.
 */

export type OpenStatus = 'UPCOMING' | 'DUE' | 'OVERDUE';

export interface LifecycleSettings {
  /** Minutes BEFORE the scheduled time at which a reminder is worth sending. */
  reminderMinutes: number;
  /** Minutes AFTER the scheduled time before it counts as overdue. */
  overdueMinutes: number;
  /** Whether this tenant wants a manager told about persistent overdue work. */
  escalateToManager: boolean;
}

/**
 * How long past overdue before a manager hears about it.
 *
 * Deliberately a MULTIPLE of the tenant's own overdue threshold rather than a
 * fixed number of hours. A tenant who considers work overdue after 30 minutes
 * and one who allows two days do not agree on what "persistently overdue"
 * means, and a constant would spam the first while never firing for the second.
 *
 * Three times is a judgement, not a discovery: it is long enough that the rep
 * has demonstrably had a chance, and short enough that a manager can still do
 * something about it the same day.
 */
export const ESCALATION_MULTIPLE = 3;

/**
 * What status a follow-up should have right now.
 *
 * Returns null when nothing should change, which is the common case — the sweep
 * runs every minute and most follow-ups are not at a boundary.
 */
export function nextStatus(input: {
  status: OpenStatus;
  scheduledAt: Date;
  overdueMinutes: number;
  now: Date;
}): OpenStatus | null {
  const overdueAt = new Date(
    input.scheduledAt.getTime() + input.overdueMinutes * 60_000,
  );

  // Ordered from latest state backwards, so a follow-up that has been sitting
  // for a week lands directly in OVERDUE rather than walking through DUE first.
  if (input.now >= overdueAt) {
    return input.status === 'OVERDUE' ? null : 'OVERDUE';
  }

  if (input.now >= input.scheduledAt) {
    return input.status === 'DUE' || input.status === 'OVERDUE' ? null : 'DUE';
  }

  return null;
}

/**
 * Whether an advance reminder is owed.
 *
 * Fires once, in the window between "reminder time" and "actually due". A
 * reminder sent after the thing is already due is not a reminder, it is a
 * second overdue alert wearing the wrong label.
 */
export function shouldRemind(input: {
  scheduledAt: Date;
  reminderSentAt: Date | null;
  reminderMinutes: number;
  now: Date;
}): boolean {
  if (input.reminderSentAt !== null) return false;

  const remindAt = new Date(
    input.scheduledAt.getTime() - input.reminderMinutes * 60_000,
  );

  return input.now >= remindAt && input.now < input.scheduledAt;
}

/** Whether the assignee should be told this has gone past its time. Once. */
export function shouldNotifyOverdue(input: {
  scheduledAt: Date;
  overdueNotifiedAt: Date | null;
  overdueMinutes: number;
  now: Date;
}): boolean {
  if (input.overdueNotifiedAt !== null) return false;

  const overdueAt = new Date(
    input.scheduledAt.getTime() + input.overdueMinutes * 60_000,
  );

  return input.now >= overdueAt;
}

/**
 * Whether a manager should be told. Once, and only if the tenant asked for it.
 *
 * Requires the assignee to have been notified first: escalating to a manager
 * before the person responsible has even been told is how automation destroys
 * trust in a team.
 */
export function shouldEscalate(input: {
  scheduledAt: Date;
  overdueNotifiedAt: Date | null;
  escalatedAt: Date | null;
  overdueMinutes: number;
  escalateToManager: boolean;
  now: Date;
}): boolean {
  if (!input.escalateToManager) return false;
  if (input.escalatedAt !== null) return false;
  // The rep gets told first, always.
  if (input.overdueNotifiedAt === null) return false;

  const escalateAt = new Date(
    input.scheduledAt.getTime() +
      input.overdueMinutes * ESCALATION_MULTIPLE * 60_000,
  );

  return input.now >= escalateAt;
}

/**
 * A deterministic notification key.
 *
 * Same follow-up plus same kind always produces the same key, which is what the
 * unique index turns into idempotency. Deliberately does NOT include a
 * timestamp — including one would make every retry unique and defeat the whole
 * mechanism, which is the single easiest way to accidentally build a system
 * that notifies twice.
 */
export function notificationKey(followUpId: string, kind: string): string {
  return `followup:${followUpId}:${kind}`;
}

/** The same, for a repeat-business signal about one customer and product. */
export function repeatSignalKey(
  accountId: string,
  productId: string | null,
  /** Bucketed so one customer cannot be re-signalled every day forever. */
  periodStamp: string,
): string {
  return `repeat:${accountId}:${productId ?? 'any'}:${periodStamp}`;
}

/**
 * The period stamp a repeat signal is bucketed into.
 *
 * Month granularity: a customer who was not ready in March may be ready in
 * April, but re-asking every single day is how a queue becomes noise people
 * stop reading. This is the suppression rule that keeps the retention engine
 * credible.
 */
export function monthStamp(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}
