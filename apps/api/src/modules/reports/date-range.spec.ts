import { DateRangeError, MAX_RANGE_DAYS, resolveDateRange } from './date-range';

describe('resolveDateRange', () => {
  // A Wednesday. 18:00 UTC is already Thursday in Auckland and still
  // Wednesday afternoon in Chicago, which is the point of using it.
  const now = new Date('2026-06-17T18:00:00Z');

  describe('presets in a UTC organization', () => {
    const resolve = (preset: string) => resolveDateRange({ preset }, 'UTC', now);

    it('today covers exactly one day, half-open', () => {
      const range = resolve('today');

      expect(range.from.toISOString()).toBe('2026-06-17T00:00:00.000Z');
      expect(range.to.toISOString()).toBe('2026-06-18T00:00:00.000Z');
      expect(range.fromDate).toBe('2026-06-17');
      expect(range.toDate).toBe('2026-06-17');
    });

    it('yesterday covers the previous day only', () => {
      const range = resolve('yesterday');

      expect(range.from.toISOString()).toBe('2026-06-16T00:00:00.000Z');
      expect(range.to.toISOString()).toBe('2026-06-17T00:00:00.000Z');
    });

    it('this_week starts on Monday and ends today', () => {
      const range = resolve('this_week');

      // Week-to-date. Running to Sunday would dilute the figure with days
      // that have not happened yet.
      expect(range.fromDate).toBe('2026-06-15');
      expect(range.toDate).toBe('2026-06-17');
    });

    it('last_week is the full Monday-to-Sunday week before', () => {
      const range = resolve('last_week');

      expect(range.fromDate).toBe('2026-06-08');
      expect(range.toDate).toBe('2026-06-14');
      expect(range.to.toISOString()).toBe('2026-06-15T00:00:00.000Z');
    });

    it('this_month starts on the 1st and ends today', () => {
      const range = resolve('this_month');

      expect(range.fromDate).toBe('2026-06-01');
      expect(range.toDate).toBe('2026-06-17');
    });

    it('last_month is the whole previous calendar month', () => {
      const range = resolve('last_month');

      expect(range.fromDate).toBe('2026-05-01');
      expect(range.toDate).toBe('2026-05-31');
      expect(range.to.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    });
  });

  describe('last_month across awkward month lengths', () => {
    it('reports February correctly when run in March', () => {
      const range = resolveDateRange(
        { preset: 'last_month' },
        'UTC',
        new Date('2026-03-31T12:00:00Z'),
      );

      // The clamp in addZonedMonths matters here: without it, one month before
      // 31 March rolls forward and "last month" reports March.
      expect(range.fromDate).toBe('2026-02-01');
      expect(range.toDate).toBe('2026-02-28');
    });

    it('crosses the year boundary from January', () => {
      const range = resolveDateRange(
        { preset: 'last_month' },
        'UTC',
        new Date('2026-01-10T12:00:00Z'),
      );

      expect(range.fromDate).toBe('2025-12-01');
      expect(range.toDate).toBe('2025-12-31');
    });
  });

  describe('the organization timezone decides the boundary', () => {
    it('gives different days to zones on either side of the instant', () => {
      const chicago = resolveDateRange({ preset: 'today' }, 'America/Chicago', now);
      const auckland = resolveDateRange({ preset: 'today' }, 'Pacific/Auckland', now);

      // Same instant, three different "todays". A UTC-only implementation
      // silently reports one of these to all three teams.
      expect(chicago.fromDate).toBe('2026-06-17');
      expect(auckland.fromDate).toBe('2026-06-18');
      expect(chicago.from.toISOString()).toBe('2026-06-17T05:00:00.000Z');
      expect(auckland.from.toISOString()).toBe('2026-06-17T12:00:00.000Z');
    });

    it('shifts the week boundary with the zone', () => {
      // Just after midnight Monday in Auckland is still Sunday in Chicago, so
      // the two are in different ISO weeks.
      const instant = new Date('2026-06-14T12:30:00Z');

      expect(resolveDateRange({ preset: 'this_week' }, 'Pacific/Auckland', instant).fromDate).toBe(
        '2026-06-15',
      );
      expect(resolveDateRange({ preset: 'this_week' }, 'America/Chicago', instant).fromDate).toBe(
        '2026-06-08',
      );
    });

    it('produces a 25-hour day when the zone falls back', () => {
      const range = resolveDateRange(
        { preset: 'today' },
        'America/Chicago',
        new Date('2026-11-01T12:00:00Z'),
      );

      const hours = (range.to.getTime() - range.from.getTime()) / 3_600_000;
      expect(hours).toBe(25);
    });

    it('produces a 23-hour day when the zone springs forward', () => {
      const range = resolveDateRange(
        { preset: 'today' },
        'America/Chicago',
        new Date('2026-03-08T12:00:00Z'),
      );

      const hours = (range.to.getTime() - range.from.getTime()) / 3_600_000;
      expect(hours).toBe(23);
    });
  });

  describe('custom ranges', () => {
    it('covers both endpoints inclusively', () => {
      const range = resolveDateRange(
        { preset: 'custom', from: '2026-06-01', to: '2026-06-03' },
        'UTC',
        now,
      );

      expect(range.from.toISOString()).toBe('2026-06-01T00:00:00.000Z');
      // Exclusive upper bound, so the whole of the 3rd is included.
      expect(range.to.toISOString()).toBe('2026-06-04T00:00:00.000Z');
    });

    it('is inferred when from and to are given without a preset', () => {
      const range = resolveDateRange({ from: '2026-06-01', to: '2026-06-03' }, 'UTC', now);
      expect(range.preset).toBe('custom');
    });

    it('allows a single-day custom range', () => {
      const range = resolveDateRange(
        { preset: 'custom', from: '2026-06-01', to: '2026-06-01' },
        'UTC',
        now,
      );

      expect(range.to.getTime() - range.from.getTime()).toBe(86_400_000);
    });

    it('rejects a reversed range', () => {
      expect(() =>
        resolveDateRange({ preset: 'custom', from: '2026-06-10', to: '2026-06-01' }, 'UTC', now),
      ).toThrow(DateRangeError);
    });

    it('rejects a custom range missing an endpoint', () => {
      expect(() => resolveDateRange({ preset: 'custom', from: '2026-06-10' }, 'UTC', now)).toThrow(
        /both from and to/,
      );
    });

    it('rejects an impossible date', () => {
      expect(() =>
        resolveDateRange({ preset: 'custom', from: '2026-02-30', to: '2026-03-01' }, 'UTC', now),
      ).toThrow(/real calendar dates/);
    });

    it('refuses a range long enough to scan years of data', () => {
      expect(() =>
        resolveDateRange({ preset: 'custom', from: '2020-01-01', to: '2026-01-01' }, 'UTC', now),
      ).toThrow(new RegExp(`maximum is ${MAX_RANGE_DAYS}`));
    });

    it('allows a range exactly at the cap', () => {
      // 2026 is not a leap year, so this is exactly 366 days inclusive.
      const range = resolveDateRange(
        { preset: 'custom', from: '2026-01-01', to: '2027-01-01' },
        'UTC',
        now,
      );

      expect(range.fromDate).toBe('2026-01-01');
    });
  });

  it('defaults to today when nothing is asked for', () => {
    expect(resolveDateRange({}, 'UTC', now).preset).toBe('today');
  });

  it('rejects an unknown preset rather than silently defaulting', () => {
    expect(() => resolveDateRange({ preset: 'last_quarter' }, 'UTC', now)).toThrow(DateRangeError);
  });
});
