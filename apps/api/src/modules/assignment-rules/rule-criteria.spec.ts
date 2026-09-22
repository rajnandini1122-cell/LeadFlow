import {
  criteriaKey,
  criteriaMatch,
  hasNoCriteria,
  normalizeSourceKey,
} from './rule-criteria';

/**
 * What a rule matches, decided once.
 *
 * These are the semantics the whole routing table rests on, so they are tested
 * where they live rather than only through HTTP: AND across stated criteria,
 * "unset means any", and a missing FACT never counting as a match.
 */
describe('normalizeSourceKey', () => {
  it('treats case and spacing as the same source', () => {
    const spellings = ['Website', 'website', '  WEBSITE  ', 'Web  site'];
    const keys = spellings.map(normalizeSourceKey);

    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toBe(keys[2]);
    // "Web site" is genuinely a different source, not a spelling of one.
    expect(keys[3]).not.toBe(keys[0]);
  });

  it('lets a website intake meet a tenant’s own vocabulary', () => {
    // J1 records WEBSITE; a tenant configures "Website". One key, so a rule
    // written by hand routes the integration too.
    expect(normalizeSourceKey('WEBSITE')).toBe(normalizeSourceKey('Website'));
  });

  it('treats nothing as nothing', () => {
    expect(normalizeSourceKey(undefined)).toBeUndefined();
    expect(normalizeSourceKey(null)).toBeUndefined();
    expect(normalizeSourceKey('   ')).toBeUndefined();
  });
});

describe('criteriaMatch', () => {
  const websiteRule = { sourceKey: 'website', productId: undefined };
  const productRule = { sourceKey: undefined, productId: 'p-1' };
  const bothRule = { sourceKey: 'website', productId: 'p-1' };

  it('matches on source', () => {
    expect(criteriaMatch(websiteRule, { source: 'Website' })).toBe(true);
    expect(criteriaMatch(websiteRule, { source: 'Referral' })).toBe(false);
  });

  it('matches on canonical product', () => {
    expect(criteriaMatch(productRule, { productId: 'p-1' })).toBe(true);
    expect(criteriaMatch(productRule, { productId: 'p-2' })).toBe(false);
  });

  it('requires EVERY stated criterion', () => {
    // AND, not OR. A rule for "website enquiries about onion powder" must not
    // catch a trade-show enquiry about onion powder.
    expect(criteriaMatch(bothRule, { source: 'Website', productId: 'p-1' })).toBe(true);
    expect(criteriaMatch(bothRule, { source: 'Website', productId: 'p-2' })).toBe(false);
    expect(criteriaMatch(bothRule, { source: 'Referral', productId: 'p-1' })).toBe(false);
  });

  it('ignores dimensions it does not state', () => {
    expect(criteriaMatch(websiteRule, { source: 'Website', productId: 'anything' })).toBe(true);
  });

  describe('territory, as one more dimension', () => {
    const territoryRule = { territoryId: 't-pune' };

    it('matches on a RESOLVED territory id', () => {
      expect(criteriaMatch(territoryRule, { territoryId: 't-pune' })).toBe(true);
      expect(criteriaMatch(territoryRule, { territoryId: 't-mumbai' })).toBe(false);
    });

    it('ANDs with source and product exactly as they AND with each other', () => {
      const everything = { sourceKey: 'website', productId: 'p-1', territoryId: 't-pune' };

      expect(
        criteriaMatch(everything, { source: 'Website', productId: 'p-1', territoryId: 't-pune' }),
      ).toBe(true);
      expect(
        criteriaMatch(everything, { source: 'Website', productId: 'p-1', territoryId: 't-mumbai' }),
      ).toBe(false);
      expect(
        criteriaMatch(everything, { source: 'Referral', productId: 'p-1', territoryId: 't-pune' }),
      ).toBe(false);
    });

    it('does NOT match work whose location resolved to nothing', () => {
      // An enquiry outside every configured territory is not "anywhere". A
      // rule for Pune must not take work from a place nobody has mapped.
      expect(criteriaMatch(territoryRule, { source: 'Website' })).toBe(false);
      expect(criteriaMatch(territoryRule, { territoryId: null })).toBe(false);
    });

    it('leaves a rule without a territory matching work from anywhere', () => {
      // The compatibility guarantee for every rule written before J5.
      expect(criteriaMatch(websiteRule, { source: 'Website', territoryId: 't-pune' })).toBe(true);
      expect(criteriaMatch(websiteRule, { source: 'Website' })).toBe(true);
    });
  });

  it('does NOT match when the work lacks the fact the rule needs', () => {
    /*
     * An enquiry with no product is not "any product" — it is a fact we do
     * not have. Treating absence as a wildcard would route a productless
     * website enquiry by a product rule, which is a guess wearing the clothes
     * of a decision.
     */
    expect(criteriaMatch(productRule, { source: 'Website' })).toBe(false);
    expect(criteriaMatch(websiteRule, { productId: 'p-1' })).toBe(false);
  });
});

describe('criteriaKey', () => {
  it('is the same for two spellings of one rule', () => {
    // What the database compares to refuse two active rules that match
    // identical input and disagree about the answer.
    expect(criteriaKey({ sourceKey: normalizeSourceKey('Website') })).toBe(
      criteriaKey({ sourceKey: normalizeSourceKey('  WEBSITE ') }),
    );
  });

  it('distinguishes an unset dimension from a set one', () => {
    expect(criteriaKey({ sourceKey: 'website' })).not.toBe(
      criteriaKey({ sourceKey: 'website', productId: 'p-1' }),
    );
    expect(criteriaKey({ productId: 'p-1' })).not.toBe(
      criteriaKey({ sourceKey: 'website', productId: 'p-1' }),
    );
  });

  it('names every dimension, so adding one cannot collide with old keys', () => {
    expect(criteriaKey({})).toBe('source=*|product=*|territory=*');
  });

  /**
   * The exact guarantee the territories migration relies on.
   *
   * Every key written before territories existed was the first two segments;
   * the migration turns each into itself plus one constant suffix. That is only
   * safe if the generator agrees — if territory were inserted in the MIDDLE of
   * the dimensions, or written differently when unset, the migrated rows would
   * no longer match what the application produces, and the active-criteria
   * unique index would read one rule as two.
   */
  it('appends territory, so an old key plus one suffix is still the right key', () => {
    expect(criteriaKey({ sourceKey: 'website', productId: 'p-1' })).toBe(
      'source=website|product=p-1' + '|territory=*',
    );
    expect(criteriaKey({})).toBe('source=*|product=*' + '|territory=*');
  });

  it('distinguishes two territories, and a territory from none', () => {
    expect(criteriaKey({ sourceKey: 'website', territoryId: 't-1' })).not.toBe(
      criteriaKey({ sourceKey: 'website', territoryId: 't-2' }),
    );
    expect(criteriaKey({ sourceKey: 'website' })).not.toBe(
      criteriaKey({ sourceKey: 'website', territoryId: 't-1' }),
    );
  });
});

describe('hasNoCriteria', () => {
  it('recognises a rule that constrains nothing', () => {
    // Only a fallback may do this. A specific rule with no criteria silently
    // becomes a second catch-all that outranks the real one.
    expect(hasNoCriteria({})).toBe(true);
    expect(hasNoCriteria({ sourceKey: 'website' })).toBe(false);
    expect(hasNoCriteria({ productId: 'p-1' })).toBe(false);
    // A territory alone is a criterion too — "everything from Pune" is a real
    // rule, not a half-finished one.
    expect(hasNoCriteria({ territoryId: 't-1' })).toBe(false);
  });
});
