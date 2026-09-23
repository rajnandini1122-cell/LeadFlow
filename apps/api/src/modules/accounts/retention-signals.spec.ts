import {
  classifyOpportunity,
  daysSince,
  headlineSignal,
  signalsFor,
  type AccountSignalInput,
} from './retention-signals';

/**
 * Retention signals.
 *
 * The tests that matter are the ones proving the engine STAYS QUIET when there
 * is nothing to say. A queue that always finds a reason is a queue nobody
 * trusts, and once a salesperson learns to ignore it the whole feature is worse
 * than not having it.
 */

const now = new Date('2026-09-01T00:00:00Z');

function input(overrides: Partial<AccountSignalInput> = {}): AccountSignalInput {
  return {
    status: 'CUSTOMER',
    wonCount: 0,
    lastWonAt: null,
    lastActivityAt: null,
    openOpportunities: 0,
    openFollowUps: 0,
    nextFollowUpAt: null,
    neverEnquiredProducts: 0,
    topProductName: null,
    dormantAfterDays: 180,
    repeatAfterDays: 30,
    now,
    ...overrides,
  };
}

const daysAgo = (days: number): Date =>
  new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

describe('signalsFor', () => {
  it('says NOTHING about a customer who needs nothing', () => {
    /*
     * The single most important case. A brand-new customer with an active
     * enquiry, nothing overdue and no unexplored products is being handled —
     * putting them in an action queue is noise.
     */
    expect(
      signalsFor(
        input({
          wonCount: 1,
          lastWonAt: daysAgo(3),
          lastActivityAt: daysAgo(3),
          openOpportunities: 0,
          neverEnquiredProducts: 0,
        }),
      ),
    ).toEqual([]);
  });

  it('flags an overdue follow-up above everything else', () => {
    // A promise already made outranks anything we merely spotted.
    const signals = signalsFor(
      input({
        openFollowUps: 1,
        nextFollowUpAt: daysAgo(4),
        wonCount: 2,
        lastWonAt: daysAgo(200),
        lastActivityAt: daysAgo(200),
        neverEnquiredProducts: 3,
      }),
    );

    expect(signals[0]?.kind).toBe('FOLLOW_UP_DUE');
    expect(signals[0]?.reason).toContain('4 days overdue');
  });

  it('does NOT flag a follow-up scheduled for the future', () => {
    /*
     * Next week's follow-up is not a reason to act today, and listing it would
     * bury the ones that are.
     */
    const signals = signalsFor(
      input({
        openFollowUps: 1,
        nextFollowUpAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      }),
    );

    expect(signals.map((signal) => signal.kind)).not.toContain('FOLLOW_UP_DUE');
  });

  it('flags a repeat candidate with the evidence behind it', () => {
    const signals = signalsFor(
      input({
        wonCount: 3,
        lastWonAt: daysAgo(35),
        lastActivityAt: daysAgo(35),
        topProductName: 'Garlic Powder',
      }),
    );

    const repeat = signals.find((signal) => signal.kind === 'REPEAT_CANDIDATE');
    expect(repeat).toBeDefined();
    // States what actually happened, so the human can judge it.
    expect(repeat?.reason).toContain('Garlic Powder');
    expect(repeat?.reason).toContain('3 times');
    expect(repeat?.reason).toContain('35 days ago');
  });

  it('does NOT suggest a repeat while an enquiry is already open', () => {
    /*
     * Suggesting they might want to buy something they are actively discussing
     * is how a rep ends up creating a second opportunity for a deal already in
     * progress.
     */
    const signals = signalsFor(
      input({
        wonCount: 3,
        lastWonAt: daysAgo(90),
        lastActivityAt: daysAgo(2),
        openOpportunities: 1,
      }),
    );

    expect(signals.map((signal) => signal.kind)).not.toContain('REPEAT_CANDIDATE');
    expect(signals.map((signal) => signal.kind)).toContain('OPEN_OPPORTUNITY');
  });

  it('does NOT suggest a repeat too soon after the last purchase', () => {
    expect(
      signalsFor(input({ wonCount: 2, lastWonAt: daysAgo(5), lastActivityAt: daysAgo(5) })).map(
        (signal) => signal.kind,
      ),
    ).not.toContain('REPEAT_CANDIDATE');
  });

  it('honours a tenant repeat window of a different length', () => {
    // Nobody knows the reorder cycle of every product a tenant sells.
    const base = { wonCount: 1, lastWonAt: daysAgo(45), lastActivityAt: daysAgo(45) };

    expect(
      signalsFor(input({ ...base, repeatAfterDays: 30 })).map((signal) => signal.kind),
    ).toContain('REPEAT_CANDIDATE');

    expect(
      signalsFor(input({ ...base, repeatAfterDays: 90 })).map((signal) => signal.kind),
    ).not.toContain('REPEAT_CANDIDATE');
  });

  it('flags dormancy only for a CUSTOMER', () => {
    // A prospect nobody has worked is a different problem needing a different
    // action.
    const quiet = { lastActivityAt: daysAgo(300), wonCount: 1, lastWonAt: daysAgo(300) };

    expect(
      signalsFor(input({ ...quiet, status: 'CUSTOMER' })).map((signal) => signal.kind),
    ).toContain('DORMANT');

    expect(
      signalsFor(input({ ...quiet, status: 'PROSPECT' })).map((signal) => signal.kind),
    ).not.toContain('DORMANT');
  });

  it('does NOT call an account with no recorded activity dormant', () => {
    /*
     * It has never been active, so it has not gone quiet. Saying otherwise
     * would put every untouched record in the retention queue.
     */
    expect(
      signalsFor(input({ status: 'CUSTOMER', lastActivityAt: null })).map(
        (signal) => signal.kind,
      ),
    ).not.toContain('DORMANT');
  });

  it('suggests expansion only for someone who has actually bought', () => {
    // A prospect has no buying pattern to expand from.
    expect(
      signalsFor(input({ wonCount: 1, lastWonAt: daysAgo(3), neverEnquiredProducts: 4 })).map(
        (signal) => signal.kind,
      ),
    ).toContain('EXPANSION_CANDIDATE');

    expect(
      signalsFor(input({ wonCount: 0, neverEnquiredProducts: 4 })).map((signal) => signal.kind),
    ).not.toContain('EXPANSION_CANDIDATE');
  });

  it('orders a commitment above an opportunity we merely spotted', () => {
    const signals = signalsFor(
      input({
        openFollowUps: 1,
        nextFollowUpAt: daysAgo(1),
        status: 'CUSTOMER',
        wonCount: 2,
        lastWonAt: daysAgo(400),
        lastActivityAt: daysAgo(400),
        neverEnquiredProducts: 2,
      }),
    );

    expect(signals.map((signal) => signal.kind)).toEqual([
      'FOLLOW_UP_DUE',
      'DORMANT',
      'REPEAT_CANDIDATE',
      'EXPANSION_CANDIDATE',
    ]);
  });
});

describe('classifyOpportunity', () => {
  it('is NULL without an account', () => {
    /*
     * Unknown is a different answer from FIRST. Recording an unattributed lead
     * as first business would invent an acquisition that never happened.
     */
    expect(
      classifyOpportunity({ accountId: null, accountWonCount: 0, productWonBefore: false }),
    ).toBeNull();
  });

  it('is FIRST when the customer has never bought', () => {
    expect(
      classifyOpportunity({ accountId: 'a-1', accountWonCount: 0, productWonBefore: false }),
    ).toBe('FIRST');
  });

  it('is REPEAT_PRODUCT when they have bought this product before', () => {
    expect(
      classifyOpportunity({ accountId: 'a-1', accountWonCount: 3, productWonBefore: true }),
    ).toBe('REPEAT_PRODUCT');
  });

  it('is EXPANSION when they are a customer but this product is new to them', () => {
    // The distinction that tells acquisition from retention from growth.
    expect(
      classifyOpportunity({ accountId: 'a-1', accountWonCount: 3, productWonBefore: false }),
    ).toBe('EXPANSION');
  });

  it('is FIRST even if the product flag is somehow set, when nothing was won', () => {
    // Won nothing means the relationship is starting, whatever else is true.
    expect(
      classifyOpportunity({ accountId: 'a-1', accountWonCount: 0, productWonBefore: true }),
    ).toBe('FIRST');
  });
});

describe('daysSince', () => {
  it('is null for a date that was never recorded', () => {
    expect(daysSince(null, now)).toBeNull();
  });

  it('counts whole elapsed days', () => {
    expect(daysSince(daysAgo(35), now)).toBe(35);
  });
});

describe('headlineSignal', () => {
  it('is null when there is nothing to say', () => {
    expect(headlineSignal([])).toBeNull();
  });

  it('is the strongest reason', () => {
    const signals = signalsFor(
      input({ openFollowUps: 1, nextFollowUpAt: daysAgo(2), openOpportunities: 1 }),
    );

    expect(headlineSignal(signals)?.kind).toBe('FOLLOW_UP_DUE');
  });
});
