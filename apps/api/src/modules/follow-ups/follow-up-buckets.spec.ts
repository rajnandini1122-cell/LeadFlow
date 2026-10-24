import { bucketWhere, startOfDayInZone, windowFor } from './follow-up-buckets';

describe('startOfDayInZone', () => {
  it('returns an instant at or before the reference', () => {
    const now = new Date('2026-08-21T15:30:00.000Z');
    expect(startOfDayInZone('UTC', now).getTime()).toBeLessThanOrEqual(now.getTime());
  });

  it('resolves midnight UTC exactly', () => {
    const now = new Date('2026-08-21T00:00:00.000Z');
    expect(startOfDayInZone('UTC', now).toISOString()).toBe('2026-08-21T00:00:00.000Z');
  });

  it('gives DIFFERENT day boundaries to tenants in different zones', () => {
    // The whole point. At 02:00 UTC, Chicago is still on the previous day, so
    // computing "today" from the server clock would be wrong for one of them.
    const now = new Date('2026-08-21T02:00:00.000Z');

    const utc = startOfDayInZone('UTC', now);
    const chicago = startOfDayInZone('America/Chicago', now);

    expect(chicago.getTime()).toBeLessThan(utc.getTime());
  });

  it('handles a zone ahead of UTC', () => {
    const now = new Date('2026-08-21T23:00:00.000Z');

    // Tokyo is already on the 22nd, so its day started AFTER UTC's did.
    const tokyo = startOfDayInZone('Asia/Tokyo', now);
    const utc = startOfDayInZone('UTC', now);

    expect(tokyo.getTime()).toBeGreaterThan(utc.getTime());
  });

  it('handles a half-hour offset zone', () => {
    // India is UTC+05:30 — a whole-hour assumption would be half an hour out.
    const now = new Date('2026-08-21T12:00:00.000Z');
    const kolkata = startOfDayInZone('Asia/Kolkata', now);

    const elapsed = now.getTime() - kolkata.getTime();
    expect(elapsed % 3_600_000).toBe(1_800_000);
  });
});

describe('windowFor', () => {
  const now = new Date('2026-08-21T12:00:00.000Z');

  it('treats anything open and past as overdue', () => {
    const window = windowFor('overdue', 'UTC', now);

    expect(window.to).toEqual(now);
    expect(window.from).toBeUndefined();
    expect(window.statuses).toEqual(['UPCOMING', 'DUE', 'OVERDUE']);
  });

  it('starts "today" at NOW, not at midnight', () => {
    const window = windowFor('today', 'UTC', now);

    // Earlier-today items belong to `overdue`. Starting at midnight would list
    // them in both, and the overdue count would understate the problem.
    expect(window.from).toEqual(now);
    expect(window.to?.toISOString()).toBe('2026-08-22T00:00:00.000Z');
  });

  it('starts "upcoming" at tomorrow', () => {
    const window = windowFor('upcoming', 'UTC', now);

    expect(window.from?.toISOString()).toBe('2026-08-22T00:00:00.000Z');
    expect(window.to).toBeUndefined();
  });

  it('leaves today and upcoming non-overlapping', () => {
    const today = windowFor('today', 'UTC', now);
    const upcoming = windowFor('upcoming', 'UTC', now);

    expect(today.to?.getTime()).toBe(upcoming.from?.getTime());
  });

  it('asks only for completed rows in the completed bucket', () => {
    expect(windowFor('completed', 'UTC', now).statuses).toEqual(['COMPLETED']);
  });

  it('shifts the day boundary with the tenant timezone', () => {
    const utc = windowFor('upcoming', 'UTC', now);
    const chicago = windowFor('upcoming', 'America/Chicago', now);

    expect(chicago.from?.getTime()).not.toBe(utc.from?.getTime());
  });
});

/**
 * CRAVION runs on Asia/Kolkata (UTC+05:30, no daylight saving). These pin the
 * calendar edges the sales workspace depends on, with fixed clocks so the
 * result never depends on when or where the suite runs.
 */
describe('windowFor — IST calendar boundaries', () => {
  const IST = 'Asia/Kolkata';
  // Thursday 23 Oct 2026, 14:00 IST.
  const thursday2pm = new Date('2026-10-23T08:30:00.000Z');

  it('puts IST midnight at 18:30 UTC the evening before', () => {
    const today = windowFor('today', IST, thursday2pm);
    // Today ends at 00:00 IST on the 24th = 18:30 UTC on the 23rd.
    expect(today.to?.toISOString()).toBe('2026-10-23T18:30:00.000Z');
  });

  it('makes "tomorrow" exactly the next IST calendar day', () => {
    const tomorrow = windowFor('tomorrow', IST, thursday2pm);
    expect(tomorrow.from?.toISOString()).toBe('2026-10-23T18:30:00.000Z');
    expect(tomorrow.to?.toISOString()).toBe('2026-10-24T18:30:00.000Z');
  });

  it('runs "this week" from tomorrow to Monday 00:00 IST', () => {
    const week = windowFor('week', IST, thursday2pm);
    expect(week.from?.toISOString()).toBe('2026-10-23T18:30:00.000Z');
    // Monday 26 Oct 00:00 IST.
    expect(week.to?.toISOString()).toBe('2026-10-25T18:30:00.000Z');
  });

  it('leaves "this week" empty on a Sunday — next week is Upcoming', () => {
    const sunday = new Date('2026-10-25T06:30:00.000Z'); // Sun 12:00 IST
    const week = windowFor('week', IST, sunday);
    expect(week.from?.getTime()).toBe(week.to?.getTime());
  });

  it('follows the IST date, not the UTC date, just after IST midnight', () => {
    // 00:15 IST on Fri 24 Oct is still 23 Oct in UTC. "Tomorrow" must be the 25th IST.
    const justAfterMidnight = new Date('2026-10-23T18:45:00.000Z');
    const tomorrow = windowFor('tomorrow', IST, justAfterMidnight);
    expect(tomorrow.from?.toISOString()).toBe('2026-10-24T18:30:00.000Z');
  });

  it('moves a follow-up rescheduled from today 2 pm to tomorrow 11 am across buckets', () => {
    const due = new Date('2026-10-23T08:30:00.000Z'); // today 14:00 IST
    const moved = new Date('2026-10-24T05:30:00.000Z'); // tomorrow 11:00 IST
    const at = new Date('2026-10-23T06:30:00.000Z'); // checked at 12:00 IST
    const inWindow = (w: ReturnType<typeof windowFor>, d: Date) =>
      (!w.from || d >= w.from) && (!w.to || d < w.to);

    expect(inWindow(windowFor('today', IST, at), due)).toBe(true);
    expect(inWindow(windowFor('today', IST, at), moved)).toBe(false);
    expect(inWindow(windowFor('tomorrow', IST, at), moved)).toBe(true);
    expect(inWindow(windowFor('upcoming', IST, at), moved)).toBe(true);
    expect(inWindow(windowFor('overdue', IST, at), moved)).toBe(false);
  });

  it('counts completions on the IST day they happened', () => {
    const w = windowFor('completed_today', IST, thursday2pm);
    expect(w.completedFrom?.toISOString()).toBe('2026-10-22T18:30:00.000Z');
    expect(w.completedTo?.toISOString()).toBe('2026-10-23T18:30:00.000Z');
    expect(w.order).toBe('completed_desc');
  });

  it('reads awaiting-response from the lead, at any date', () => {
    const w = windowFor('awaiting', IST, thursday2pm);
    expect(w.from).toBeUndefined();
    expect(w.to).toBeUndefined();
    expect(JSON.stringify(w.lead)).toContain('AWAITING_RESPONSE');
    expect(JSON.stringify(w.lead)).toContain('QUOTATION_SENT');
  });
});

describe('bucketWhere', () => {
  it('lets the permission restriction win over a requested assignee', () => {
    const where = bucketWhere(windowFor('overdue', 'UTC'), {
      assignedUserId: 'someone-else',
      restrictToUserId: 'me',
    });
    expect(where['assignedUserId']).toBe('me');
  });

  it('filters completed-today on completedAt, not scheduledAt', () => {
    const where = bucketWhere(windowFor('completed_today', 'Asia/Kolkata'));
    expect(where['completedAt']).toBeDefined();
    expect(where['scheduledAt']).toBeUndefined();
  });
});
