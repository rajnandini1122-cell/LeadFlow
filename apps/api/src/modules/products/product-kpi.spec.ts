import {
  averageDaysToClose,
  averageWonValue,
  demandShare,
  demandTrend,
  forecastAccuracy,
  rateIsReliable,
  toNumber,
  winRate,
} from './product-kpi';

/**
 * Product KPI arithmetic.
 *
 * The valuable cases are the REFUSALS. Every one of these figures is easy to
 * compute wrongly in a way that looks plausible on a dashboard: a 0% win rate
 * for a product nothing has closed on, a 100% rate off a single deal, "+50%"
 * growth from one extra enquiry. Management acts on these numbers, so a
 * confident wrong answer costs more than a missing one.
 */

describe('winRate', () => {
  it('counts only closed deals', () => {
    // 3 won, 1 lost. Open leads are excluded from the denominator entirely.
    expect(winRate(3, 1)).toBe(0.75);
  });

  it('is null when nothing has closed', () => {
    /*
     * NOT zero. "We have won none of them" and "nothing has finished yet" are
     * different facts, and showing 0% makes a healthy new product look failed.
     */
    expect(winRate(0, 0)).toBeNull();
  });

  it('is 0 when everything closed was lost', () => {
    // Genuinely zero, and worth saying so.
    expect(winRate(0, 4)).toBe(0);
  });

  it('is 1 when everything closed was won', () => {
    expect(winRate(5, 0)).toBe(1);
  });
});

describe('rateIsReliable', () => {
  it('refuses a rate built on one deal', () => {
    // "100% win rate" off a single sale tells nobody anything.
    expect(rateIsReliable(1, 0)).toBe(false);
  });

  it('accepts a rate once enough has closed', () => {
    expect(rateIsReliable(2, 1)).toBe(true);
  });

  it('counts losses towards the sample too', () => {
    expect(rateIsReliable(0, 3)).toBe(true);
  });
});

describe('averageWonValue', () => {
  it('divides by WON deals, not by all leads', () => {
    /*
     * The question is what a sale is worth. Dividing by leads that never closed
     * answers a different question, much less flatteringly.
     */
    expect(averageWonValue(30000, 3)).toBe(10000);
  });

  it('is null when nothing has been won', () => {
    expect(averageWonValue(null, 0)).toBeNull();
    expect(averageWonValue(0, 0)).toBeNull();
  });

  it('is null when the wins carry no recorded value', () => {
    // Won, but nobody entered what for. Zero would understate the product.
    expect(averageWonValue(null, 4)).toBeNull();
  });
});

describe('averageDaysToClose', () => {
  const day = 86_400_000;
  const created = new Date('2026-01-01T00:00:00Z');

  it('averages creation to won', () => {
    const durations = [
      { createdAt: created, wonAt: new Date(created.getTime() + 10 * day) },
      { createdAt: created, wonAt: new Date(created.getTime() + 20 * day) },
    ];

    expect(averageDaysToClose(durations)).toBe(15);
  });

  it('is null for a product with no wins', () => {
    // Zero would rank an unsold product as the fastest to close.
    expect(averageDaysToClose([])).toBeNull();
    expect(averageDaysToClose([{ createdAt: created, wonAt: null }])).toBeNull();
  });

  it('ignores a negative interval rather than letting it drag the mean', () => {
    // A backdated import or clock skew. Dropping it beats a negative average.
    const durations = [
      { createdAt: created, wonAt: new Date(created.getTime() - 5 * day) },
      { createdAt: created, wonAt: new Date(created.getTime() + 10 * day) },
    ];

    expect(averageDaysToClose(durations)).toBe(10);
  });
});

describe('forecastAccuracy', () => {
  it('scores the estimate against what actually closed', () => {
    const result = forecastAccuracy(100000, 90000);

    expect(result.variance).toBe(-10000);
    // Out by 10% of the estimate, so 90% accurate.
    expect(result.accuracy).toBe(0.9);
  });

  it('treats a conservative estimate as equally inaccurate', () => {
    // Direction shows in the variance; accuracy is about magnitude.
    const under = forecastAccuracy(100000, 110000);
    expect(under.variance).toBe(10000);
    expect(under.accuracy).toBe(0.9);
  });

  it('floors accuracy at zero rather than going negative', () => {
    // Wrong by more than the estimate itself. "-150% accurate" means nothing.
    const result = forecastAccuracy(10000, 35000);
    expect(result.accuracy).toBe(0);
  });

  it('is null when there is nothing to compare', () => {
    expect(forecastAccuracy(null, 5000).accuracy).toBeNull();
    expect(forecastAccuracy(5000, null).accuracy).toBeNull();
    // Dividing by a zero estimate is undefined, not 0% accurate.
    expect(forecastAccuracy(0, 5000).accuracy).toBeNull();
  });
});

describe('demandTrend', () => {
  it('reports growth against the previous period', () => {
    const trend = demandTrend(30, 20);

    expect(trend.change).toBe(0.5);
    expect(trend.direction).toBe('rising');
  });

  it('reports decline', () => {
    expect(demandTrend(8, 20).direction).toBe('falling');
  });

  it('calls a few percent either way stable', () => {
    // Keeps the rising/falling lists to things actually worth looking at.
    expect(demandTrend(101, 100).direction).toBe('stable');
  });

  it('never divides by zero — a product with no history is NEW', () => {
    /*
     * The previous period had none. That is not infinite growth; it is a
     * product that has just started selling, and it needs its own label.
     */
    const trend = demandTrend(12, 0);

    expect(trend.change).toBeNull();
    expect(trend.direction).toBe('new');
  });

  it('withholds a percentage when the numbers are too small', () => {
    /*
     * Two leads becoming three is "+50%", which reads as a trend and is noise.
     * The direction is still useful; the percentage is not, so the caller shows
     * the counts instead.
     */
    const trend = demandTrend(3, 2);

    expect(trend.change).toBeNull();
    expect(trend.direction).toBe('rising');
    expect(trend.current).toBe(3);
    expect(trend.previous).toBe(2);
  });

  it('is stable when nothing happened in either period', () => {
    expect(demandTrend(0, 0).direction).toBe('stable');
  });
});

describe('demandShare', () => {
  it('is the product’s fraction of product demand', () => {
    expect(demandShare(25, 100)).toBe(0.25);
  });

  it('is null when nothing has a product yet', () => {
    // Not 0 — with an empty catalogue "0% of demand" is untrue of everything.
    expect(demandShare(0, 0)).toBeNull();
  });
});

describe('toNumber', () => {
  it('converts a Decimal', () => {
    expect(toNumber({ toString: () => '1234.56' })).toBe(1234.56);
  });

  it('passes null through rather than inventing a zero', () => {
    expect(toNumber(null)).toBeNull();
    expect(toNumber(undefined)).toBeNull();
  });

  it('refuses a value that is not a number', () => {
    expect(toNumber({ toString: () => 'not a number' })).toBeNull();
  });
});
