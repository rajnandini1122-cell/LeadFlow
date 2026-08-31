import {
  ESCALATION_MULTIPLE,
  monthStamp,
  nextStatus,
  notificationKey,
  repeatSignalKey,
  shouldEscalate,
  shouldNotifyOverdue,
  shouldRemind,
} from './follow-up-lifecycle';

/**
 * The follow-up state machine.
 *
 * The tests that matter are the ones proving this NEVER NOTIFIES TWICE and
 * never moves backwards. A CRM that double-reminds is one people mute, and a
 * muted reminder system is worse than none — the team stops trusting the one
 * signal the product exists to provide.
 */

const at = (iso: string): Date => new Date(iso);
const scheduledAt = at('2026-09-01T10:00:00Z');

describe('nextStatus', () => {
  it('leaves an upcoming follow-up alone before its time', () => {
    expect(
      nextStatus({
        status: 'UPCOMING',
        scheduledAt,
        overdueMinutes: 120,
        now: at('2026-09-01T09:59:00Z'),
      }),
    ).toBeNull();
  });

  it('moves to DUE exactly at the scheduled moment', () => {
    // The boundary is inclusive. A follow-up due at 10:00 is due at 10:00.
    expect(
      nextStatus({
        status: 'UPCOMING',
        scheduledAt,
        overdueMinutes: 120,
        now: at('2026-09-01T10:00:00Z'),
      }),
    ).toBe('DUE');
  });

  it('moves to OVERDUE once the tenant threshold has passed', () => {
    expect(
      nextStatus({
        status: 'DUE',
        scheduledAt,
        overdueMinutes: 120,
        now: at('2026-09-01T12:00:00Z'),
      }),
    ).toBe('OVERDUE');
  });

  it('goes STRAIGHT to overdue for something left for a week', () => {
    /*
     * A follow-up nobody touched for seven days must not walk through DUE
     * first — that would send a "due now" reminder about something a week old.
     */
    expect(
      nextStatus({
        status: 'UPCOMING',
        scheduledAt,
        overdueMinutes: 120,
        now: at('2026-09-08T10:00:00Z'),
      }),
    ).toBe('OVERDUE');
  });

  it('NEVER moves backwards', () => {
    /*
     * The most important property. If a rep saw "overdue" and acted, watching
     * it silently become "upcoming" again would destroy any trust in the
     * status. One-way only.
     */
    expect(
      nextStatus({
        status: 'OVERDUE',
        scheduledAt,
        overdueMinutes: 120,
        now: at('2026-09-01T12:30:00Z'),
      }),
    ).toBeNull();

    expect(
      nextStatus({
        status: 'DUE',
        scheduledAt,
        overdueMinutes: 120,
        now: at('2026-09-01T10:30:00Z'),
      }),
    ).toBeNull();
  });

  it('is a no-op when the sweep re-runs on the same row', () => {
    // The sweep runs every minute. Most rows are not at a boundary, and
    // returning null is what makes a repeated sweep cost nothing.
    for (const status of ['UPCOMING', 'DUE', 'OVERDUE'] as const) {
      const first = nextStatus({
        status,
        scheduledAt,
        overdueMinutes: 120,
        now: at('2026-09-01T12:00:00Z'),
      });

      if (first === null) continue;

      // Applying the result, the second pass must change nothing.
      expect(
        nextStatus({
          status: first,
          scheduledAt,
          overdueMinutes: 120,
          now: at('2026-09-01T12:00:00Z'),
        }),
      ).toBeNull();
    }
  });

  it('honours a tenant overdue threshold of a different length', () => {
    const now = at('2026-09-01T10:45:00Z');

    // 30-minute tenant: already overdue.
    expect(nextStatus({ status: 'DUE', scheduledAt, overdueMinutes: 30, now })).toBe('OVERDUE');
    // Two-day tenant: not yet.
    expect(nextStatus({ status: 'DUE', scheduledAt, overdueMinutes: 2880, now })).toBeNull();
  });
});

describe('shouldRemind', () => {
  it('reminds inside the window before the follow-up is due', () => {
    expect(
      shouldRemind({
        scheduledAt,
        reminderSentAt: null,
        reminderMinutes: 30,
        now: at('2026-09-01T09:40:00Z'),
      }),
    ).toBe(true);
  });

  it('does NOT remind before the window opens', () => {
    expect(
      shouldRemind({
        scheduledAt,
        reminderSentAt: null,
        reminderMinutes: 30,
        now: at('2026-09-01T09:00:00Z'),
      }),
    ).toBe(false);
  });

  it('does NOT remind once the thing is already due', () => {
    /*
     * A reminder sent after something is due is not a reminder — it is a
     * second overdue alert wearing the wrong label.
     */
    expect(
      shouldRemind({
        scheduledAt,
        reminderSentAt: null,
        reminderMinutes: 30,
        now: at('2026-09-01T10:01:00Z'),
      }),
    ).toBe(false);
  });

  it('NEVER reminds twice, however often the sweep runs', () => {
    // The marker is the guarantee. This is the retry case.
    expect(
      shouldRemind({
        scheduledAt,
        reminderSentAt: at('2026-09-01T09:35:00Z'),
        reminderMinutes: 30,
        now: at('2026-09-01T09:45:00Z'),
      }),
    ).toBe(false);
  });
});

describe('shouldNotifyOverdue', () => {
  it('notifies once the threshold passes', () => {
    expect(
      shouldNotifyOverdue({
        scheduledAt,
        overdueNotifiedAt: null,
        overdueMinutes: 120,
        now: at('2026-09-01T12:00:00Z'),
      }),
    ).toBe(true);
  });

  it('does not notify before the threshold', () => {
    expect(
      shouldNotifyOverdue({
        scheduledAt,
        overdueNotifiedAt: null,
        overdueMinutes: 120,
        now: at('2026-09-01T11:59:00Z'),
      }),
    ).toBe(false);
  });

  it('NEVER notifies twice', () => {
    expect(
      shouldNotifyOverdue({
        scheduledAt,
        overdueNotifiedAt: at('2026-09-01T12:00:00Z'),
        overdueMinutes: 120,
        now: at('2026-09-02T12:00:00Z'),
      }),
    ).toBe(false);
  });
});

describe('shouldEscalate', () => {
  const base = {
    scheduledAt,
    overdueNotifiedAt: at('2026-09-01T12:00:00Z'),
    escalatedAt: null,
    overdueMinutes: 120,
    escalateToManager: true,
  };

  it('escalates after the overdue threshold times the multiple', () => {
    expect(shouldEscalate({ ...base, now: at('2026-09-01T16:00:00Z') })).toBe(true);
  });

  it('does not escalate before that', () => {
    expect(shouldEscalate({ ...base, now: at('2026-09-01T14:00:00Z') })).toBe(false);
  });

  it('does NOT escalate before the rep has been told', () => {
    /*
     * Telling a manager before the person responsible has even heard is how
     * automation destroys trust in a team. The rep is always first.
     */
    expect(
      shouldEscalate({
        ...base,
        overdueNotifiedAt: null,
        now: at('2026-09-02T00:00:00Z'),
      }),
    ).toBe(false);
  });

  it('does NOT escalate when the tenant has not asked for it', () => {
    expect(
      shouldEscalate({
        ...base,
        escalateToManager: false,
        now: at('2026-09-02T00:00:00Z'),
      }),
    ).toBe(false);
  });

  it('NEVER escalates twice', () => {
    expect(
      shouldEscalate({
        ...base,
        escalatedAt: at('2026-09-01T16:00:00Z'),
        now: at('2026-09-05T00:00:00Z'),
      }),
    ).toBe(false);
  });

  it('scales with the tenant threshold rather than a fixed delay', () => {
    // A 30-minute tenant and a two-day tenant do not agree on "persistently
    // overdue", and a constant would spam one and never fire for the other.
    const quick = { ...base, overdueMinutes: 30 };
    expect(shouldEscalate({ ...quick, now: at('2026-09-01T11:30:00Z') })).toBe(true);

    const slow = { ...base, overdueMinutes: 2880 };
    expect(shouldEscalate({ ...slow, now: at('2026-09-03T00:00:00Z') })).toBe(false);
    expect(ESCALATION_MULTIPLE).toBe(3);
  });
});

describe('notification keys', () => {
  it('is deterministic for the same follow-up and kind', () => {
    /*
     * This is what the unique index turns into idempotency. If the key varied
     * between runs the constraint would never fire and every retry would
     * notify again.
     */
    expect(notificationKey('f-1', 'DUE')).toBe(notificationKey('f-1', 'DUE'));
    expect(notificationKey('f-1', 'DUE')).not.toBe(notificationKey('f-1', 'OVERDUE'));
    expect(notificationKey('f-1', 'DUE')).not.toBe(notificationKey('f-2', 'DUE'));
  });

  it('contains NO timestamp', () => {
    // Including one is the single easiest way to accidentally build a system
    // that notifies twice.
    const key = notificationKey('f-1', 'DUE');
    expect(key).toBe('followup:f-1:DUE');
    expect(key).not.toMatch(/\d{13}/);
  });

  it('buckets repeat signals by month so a customer is not re-asked daily', () => {
    const march = repeatSignalKey('a-1', 'p-1', monthStamp(at('2026-03-05T00:00:00Z')));
    const alsoMarch = repeatSignalKey('a-1', 'p-1', monthStamp(at('2026-03-28T00:00:00Z')));
    const april = repeatSignalKey('a-1', 'p-1', monthStamp(at('2026-04-02T00:00:00Z')));

    expect(march).toBe(alsoMarch);
    expect(march).not.toBe(april);
  });

  it('distinguishes a repeat signal with no product', () => {
    expect(repeatSignalKey('a-1', null, '2026-03')).toBe('repeat:a-1:any:2026-03');
  });
});
