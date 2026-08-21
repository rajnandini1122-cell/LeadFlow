import { startOfDayInZone, windowFor } from './follow-up-buckets';

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
