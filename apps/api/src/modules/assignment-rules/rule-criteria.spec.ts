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
    expect(criteriaKey({})).toBe('source=*|product=*');
  });
});

describe('hasNoCriteria', () => {
  it('recognises a rule that constrains nothing', () => {
    // Only a fallback may do this. A specific rule with no criteria silently
    // becomes a second catch-all that outranks the real one.
    expect(hasNoCriteria({})).toBe(true);
    expect(hasNoCriteria({ sourceKey: 'website' })).toBe(false);
    expect(hasNoCriteria({ productId: 'p-1' })).toBe(false);
  });
});
