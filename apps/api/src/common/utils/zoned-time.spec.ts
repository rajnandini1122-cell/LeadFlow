import {
  addZonedDays,
  addZonedMonths,
  formatZonedDate,
  isValidTimezone,
  parseZonedDate,
  startOfDay,
  startOfZonedDay,
  startOfZonedMonth,
  startOfZonedWeek,
  zonedDate,
  zonedWeekday,
} from './zoned-time';

describe('zonedDate', () => {
  it('reads the wall-clock date in the target zone, not the server one', () => {
    // 03:00 UTC on 15 March is still the 14th in Chicago (UTC-5).
    const instant = new Date('2026-03-15T03:00:00Z');

    expect(zonedDate(instant, 'UTC')).toEqual({ year: 2026, month: 3, day: 15 });
    expect(zonedDate(instant, 'America/Chicago')).toEqual({ year: 2026, month: 3, day: 14 });
    expect(zonedDate(instant, 'Asia/Kolkata')).toEqual({ year: 2026, month: 3, day: 15 });
  });

  it('handles a zone whose offset crosses the date line forward', () => {
    // 20:00 UTC is already tomorrow in Auckland.
    const instant = new Date('2026-06-10T20:00:00Z');

    expect(zonedDate(instant, 'Pacific/Auckland')).toEqual({ year: 2026, month: 6, day: 11 });
  });
});

describe('startOfZonedDay', () => {
  it('returns the instant of local midnight', () => {
    const midnight = startOfZonedDay({ year: 2026, month: 6, day: 15 }, 'America/Chicago');

    // June is CDT, UTC-5, so local midnight is 05:00 UTC.
    expect(midnight.toISOString()).toBe('2026-06-15T05:00:00.000Z');
  });

  it('handles a half-hour offset zone', () => {
    const midnight = startOfZonedDay({ year: 2026, month: 6, day: 15 }, 'Asia/Kolkata');

    expect(midnight.toISOString()).toBe('2026-06-14T18:30:00.000Z');
  });

  it('is correct on the day a zone springs forward', () => {
    // US DST begins 08 March 2026 at 02:00 local; midnight is still CST (-6).
    const midnight = startOfZonedDay({ year: 2026, month: 3, day: 8 }, 'America/Chicago');

    expect(midnight.toISOString()).toBe('2026-03-08T06:00:00.000Z');
  });

  it('is correct on the day a zone falls back', () => {
    // DST ends 01 November 2026 at 02:00 local; midnight is still CDT (-5).
    const midnight = startOfZonedDay({ year: 2026, month: 11, day: 1 }, 'America/Chicago');

    expect(midnight.toISOString()).toBe('2026-11-01T05:00:00.000Z');
  });

  it('round-trips: the instant of local midnight reads back as that date', () => {
    // The property that actually matters — a boundary must not land on the
    // wrong side of itself, or a lead created at 00:05 falls out of "today".
    const zones = ['UTC', 'America/Chicago', 'Asia/Kolkata', 'Pacific/Auckland', 'Europe/London'];

    for (const zone of zones) {
      for (const day of [1, 8, 15, 28]) {
        for (const month of [1, 3, 6, 11]) {
          const date = { year: 2026, month, day };
          expect(zonedDate(startOfZonedDay(date, zone), zone)).toEqual(date);
        }
      }
    }
  });
});

describe('startOfDay', () => {
  it('finds the start of the day containing an instant', () => {
    const instant = new Date('2026-06-15T23:30:00Z');

    // Late-evening UTC is already the 16th in Auckland, so its day started
    // earlier in UTC terms than the instant itself.
    expect(startOfDay(instant, 'Pacific/Auckland').toISOString()).toBe(
      '2026-06-15T12:00:00.000Z',
    );
  });
});

describe('addZonedDays', () => {
  it('crosses a month boundary', () => {
    expect(addZonedDays({ year: 2026, month: 1, day: 31 }, 1)).toEqual({
      year: 2026,
      month: 2,
      day: 1,
    });
  });

  it('goes backwards across a year boundary', () => {
    expect(addZonedDays({ year: 2026, month: 1, day: 1 }, -1)).toEqual({
      year: 2025,
      month: 12,
      day: 31,
    });
  });

  it('handles a leap day', () => {
    expect(addZonedDays({ year: 2028, month: 2, day: 28 }, 1)).toEqual({
      year: 2028,
      month: 2,
      day: 29,
    });
  });
});

describe('addZonedMonths', () => {
  it('clamps to the last day of a shorter month', () => {
    // Otherwise "one month before 31 March" rolls forward into March again and
    // "last month" reports the wrong month entirely.
    expect(addZonedMonths({ year: 2026, month: 3, day: 31 }, -1)).toEqual({
      year: 2026,
      month: 2,
      day: 28,
    });
  });

  it('crosses a year boundary backwards', () => {
    expect(addZonedMonths({ year: 2026, month: 1, day: 15 }, -1)).toEqual({
      year: 2025,
      month: 12,
      day: 15,
    });
  });

  it('crosses a year boundary forwards', () => {
    expect(addZonedMonths({ year: 2026, month: 12, day: 15 }, 1)).toEqual({
      year: 2027,
      month: 1,
      day: 15,
    });
  });
});

describe('startOfZonedWeek', () => {
  it('returns the Monday of that week', () => {
    // 2026-06-17 is a Wednesday.
    expect(zonedWeekday({ year: 2026, month: 6, day: 17 })).toBe(3);
    expect(startOfZonedWeek({ year: 2026, month: 6, day: 17 })).toEqual({
      year: 2026,
      month: 6,
      day: 15,
    });
  });

  it('treats Sunday as the END of its week, not the start', () => {
    // ISO-8601. A sales week starting Sunday splits the weekend across two
    // reports, which makes weekly comparisons meaningless.
    expect(zonedWeekday({ year: 2026, month: 6, day: 21 })).toBe(0);
    expect(startOfZonedWeek({ year: 2026, month: 6, day: 21 })).toEqual({
      year: 2026,
      month: 6,
      day: 15,
    });
  });

  it('returns the same day when given a Monday', () => {
    expect(startOfZonedWeek({ year: 2026, month: 6, day: 15 })).toEqual({
      year: 2026,
      month: 6,
      day: 15,
    });
  });
});

describe('startOfZonedMonth', () => {
  it('returns the first of the month', () => {
    expect(startOfZonedMonth({ year: 2026, month: 6, day: 17 })).toEqual({
      year: 2026,
      month: 6,
      day: 1,
    });
  });
});

describe('parseZonedDate', () => {
  it('accepts a real date', () => {
    expect(parseZonedDate('2026-06-15')).toEqual({ year: 2026, month: 6, day: 15 });
  });

  it.each(['2026-02-30', '2026-13-01', '2026-00-10', '2026-06-32'])(
    'rejects the impossible date %s',
    (input) => {
      expect(parseZonedDate(input)).toBeNull();
    },
  );

  it.each(['15/06/2026', '2026-6-15', 'yesterday', '', '2026-06-15T00:00:00Z'])(
    'rejects the malformed input %s',
    (input) => {
      expect(parseZonedDate(input)).toBeNull();
    },
  );

  it('round-trips through formatZonedDate', () => {
    expect(formatZonedDate(parseZonedDate('2026-01-05') as never)).toBe('2026-01-05');
  });
});

describe('isValidTimezone', () => {
  it('accepts real zones', () => {
    expect(isValidTimezone('Asia/Kolkata')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
  });

  it('rejects a made-up zone', () => {
    expect(isValidTimezone('Mars/Olympus_Mons')).toBe(false);
  });
});
