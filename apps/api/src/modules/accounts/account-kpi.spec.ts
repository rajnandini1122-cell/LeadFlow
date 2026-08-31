import {
  averageCustomerValue,
  averageWinsPerCustomer,
  crossSellGaps,
  everBoughtCount,
  existingCustomerShare,
  isDormancyCandidate,
  MIN_ACCOUNTS_FOR_CONVERSION,
  MIN_CUSTOMERS_FOR_RATE,
  prospectConversionRate,
  repeatCustomerRate,
  repeatRevenueShare,
  totalAccounts,
  totalDemand,
  type CustomerCounts,
} from './account-kpi';

/**
 * Customer KPI formulas.
 *
 * The tests that matter are the ones proving these REFUSE to state something
 * they cannot support. A dashboard reporting "0% repeat rate" for an
 * organization with three customers and no history describes a retention
 * problem that does not exist — and someone will act on it.
 */

function counts(overrides: Partial<CustomerCounts> = {}): CustomerCounts {
  return { prospects: 0, customers: 0, dormant: 0, formerCustomers: 0, ...overrides };
}

describe('counting relationships', () => {
  it('counts every kind of account in the total', () => {
    // A total that counted only customers would make the customer base look
    // like the whole database.
    expect(
      totalAccounts(counts({ prospects: 10, customers: 4, dormant: 2, formerCustomers: 1 })),
    ).toBe(17);
  });

  it('counts dormant and former customers as having bought', () => {
    /*
     * They did buy. A lifetime figure that quietly drops churned customers
     * overstates how well the business converts.
     */
    expect(everBoughtCount(counts({ customers: 4, dormant: 2, formerCustomers: 1 }))).toBe(7);
  });
});

describe('prospectConversionRate', () => {
  it('is NULL for an organization with no accounts', () => {
    // 0% conversion for a business that has recorded nothing is a statement
    // about a business that has not started yet.
    expect(prospectConversionRate(counts())).toBeNull();
  });

  it('is NULL below the sample floor', () => {
    const small = counts({ prospects: MIN_ACCOUNTS_FOR_CONVERSION - 2, customers: 1 });
    expect(prospectConversionRate(small)).toBeNull();
  });

  it('computes over every account once the sample supports it', () => {
    expect(prospectConversionRate(counts({ prospects: 6, customers: 4 }))).toBeCloseTo(0.4);
  });

  it('reports a real zero when nobody has converted', () => {
    // Genuinely none, from a sample big enough to say so.
    expect(prospectConversionRate(counts({ prospects: 10 }))).toBe(0);
  });
});

describe('repeatCustomerRate', () => {
  it('is NULL when nobody has bought', () => {
    expect(
      repeatCustomerRate({ customersWithAnyWin: 0, customersWithMultipleWins: 0 }),
    ).toBeNull();
  });

  it('is NULL below the sample floor', () => {
    /*
     * Two customers where one bought twice is "50% repeat rate", which reads
     * as a finding and is a coin toss.
     */
    expect(
      repeatCustomerRate({ customersWithAnyWin: 2, customersWithMultipleWins: 1 }),
    ).toBeNull();
    expect(
      repeatCustomerRate({
        customersWithAnyWin: MIN_CUSTOMERS_FOR_RATE - 1,
        customersWithMultipleWins: 1,
      }),
    ).toBeNull();
  });

  it('computes over paying customers, not over all accounts', () => {
    // A prospect cannot repeat, so including them would report a retention
    // problem that is really a young pipeline.
    expect(
      repeatCustomerRate({ customersWithAnyWin: 10, customersWithMultipleWins: 3 }),
    ).toBeCloseTo(0.3);
  });

  it('reports a real zero once the sample is big enough', () => {
    expect(repeatCustomerRate({ customersWithAnyWin: 10, customersWithMultipleWins: 0 })).toBe(0);
  });
});

describe('customer value', () => {
  it('is NULL when nobody has bought', () => {
    // No revenue yet is not an average of nothing.
    expect(averageCustomerValue({ totalWonValue: 0, customersWithAnyWin: 0 })).toBeNull();
    expect(averageWinsPerCustomer({ totalWins: 0, customersWithAnyWin: 0 })).toBeNull();
  });

  it('averages over paying customers', () => {
    expect(averageCustomerValue({ totalWonValue: 500000, customersWithAnyWin: 5 })).toBe(100000);
    expect(averageWinsPerCustomer({ totalWins: 12, customersWithAnyWin: 5 })).toBeCloseTo(2.4);
  });
});

describe('repeatRevenueShare', () => {
  it('is NULL when there is no revenue to divide', () => {
    expect(repeatRevenueShare({ totalWonValue: 0, repeatWonValue: 0 })).toBeNull();
  });

  it('reports the share that came from customers buying again', () => {
    expect(repeatRevenueShare({ totalWonValue: 1000000, repeatWonValue: 400000 })).toBeCloseTo(0.4);
  });

  it('reports a real zero when every deal was a first purchase', () => {
    // A genuine finding: this business grows only by acquisition.
    expect(repeatRevenueShare({ totalWonValue: 1000000, repeatWonValue: 0 })).toBe(0);
  });
});

describe('demand split by customer type', () => {
  it('counts unattributed demand without hiding it', () => {
    const split = { prospect: 10, existingCustomer: 5, unknown: 20 };
    expect(totalDemand(split)).toBe(35);
  });

  it('excludes unattributed leads from the SHARE rather than guessing a side', () => {
    /*
     * The important one. Counting unknowns as prospects would inflate
     * new-business demand with every row the backfill has not reached, and the
     * figure would improve on its own as classification progressed.
     */
    const split = { prospect: 10, existingCustomer: 10, unknown: 80 };
    expect(existingCustomerShare(split)).toBeCloseTo(0.5);
  });

  it('is NULL when nothing can be attributed at all', () => {
    expect(existingCustomerShare({ prospect: 0, existingCustomer: 0, unknown: 50 })).toBeNull();
  });
});

describe('isDormancyCandidate', () => {
  const now = new Date('2026-08-30T00:00:00Z');

  it('flags a customer quiet for longer than the threshold', () => {
    expect(
      isDormancyCandidate({
        status: 'CUSTOMER',
        lastActivityAt: new Date('2026-01-01T00:00:00Z'),
        thresholdDays: 180,
        now,
      }),
    ).toBe(true);
  });

  it('does NOT flag a customer inside the threshold', () => {
    expect(
      isDormancyCandidate({
        status: 'CUSTOMER',
        lastActivityAt: new Date('2026-08-01T00:00:00Z'),
        thresholdDays: 180,
        now,
      }),
    ).toBe(false);
  });

  it('does NOT flag an account that has never been active', () => {
    /*
     * It has not gone quiet — it has never spoken. That is a prospect nobody
     * has worked, which is a different problem needing a different action.
     */
    expect(
      isDormancyCandidate({ status: 'CUSTOMER', lastActivityAt: null, thresholdDays: 180, now }),
    ).toBe(false);
  });

  it('does NOT flag a prospect, however long it has been quiet', () => {
    // A prospect cannot go dormant; it was never a customer.
    expect(
      isDormancyCandidate({
        status: 'PROSPECT',
        lastActivityAt: new Date('2020-01-01T00:00:00Z'),
        thresholdDays: 180,
        now,
      }),
    ).toBe(false);
  });

  it('does NOT re-flag one already marked dormant or former', () => {
    for (const status of ['DORMANT', 'FORMER_CUSTOMER']) {
      expect(
        isDormancyCandidate({
          status,
          lastActivityAt: new Date('2020-01-01T00:00:00Z'),
          thresholdDays: 180,
          now,
        }),
      ).toBe(false);
    }
  });

  it('honours a tenant threshold of a different length', () => {
    // Configuration, not a constant: a business selling annually and one
    // selling weekly do not agree on what neglected means.
    const lastActivityAt = new Date('2026-07-01T00:00:00Z');

    expect(isDormancyCandidate({ status: 'CUSTOMER', lastActivityAt, thresholdDays: 30, now })).toBe(
      true,
    );
    expect(
      isDormancyCandidate({ status: 'CUSTOMER', lastActivityAt, thresholdDays: 365, now }),
    ).toBe(false);
  });
});

describe('crossSellGaps', () => {
  it('lists catalogue products the customer has never enquired about', () => {
    expect(
      crossSellGaps({
        catalogueProductIds: ['garlic-powder', 'garlic-flakes', 'onion-powder'],
        enquiredProductIds: ['garlic-powder'],
      }),
    ).toEqual(['garlic-flakes', 'onion-powder']);
  });

  it('returns nothing when they have enquired about everything', () => {
    expect(
      crossSellGaps({
        catalogueProductIds: ['a', 'b'],
        enquiredProductIds: ['a', 'b'],
      }),
    ).toEqual([]);
  });

  it('is a set difference and nothing more', () => {
    /*
     * Deliberately not a recommendation engine. No score, no ranking, no model
     * pretending to know what they want next — a rep can judge "they buy
     * garlic powder and have never asked about flakes" perfectly well.
     */
    expect(
      crossSellGaps({ catalogueProductIds: ['a', 'b', 'c'], enquiredProductIds: [] }),
    ).toEqual(['a', 'b', 'c']);
  });
});
