import {
  extractDomain,
  findDuplicateCandidates,
  groupByNormalizedName,
  normalizeCompanyName,
  suggestAccountsForCompanyName,
  type ExistingAccount,
} from './account-identity';

/**
 * Deciding whether two companies are the same company.
 *
 * The tests that matter most here are the ones proving this NEVER MERGES
 * ANYTHING. Fusing two customers' histories has no undo, so every case below
 * checks that the output is a suggestion carrying its own evidence — and that
 * the loose matches a naive implementation would make are refused.
 */

function account(overrides: Partial<ExistingAccount> = {}): ExistingAccount {
  return {
    id: 'a-1',
    name: 'ABC Foods',
    normalizedName: 'abc foods',
    domain: null,
    phone: null,
    status: 'PROSPECT',
    ...overrides,
  };
}

describe('normalizeCompanyName', () => {
  it('treats a legal suffix as noise', () => {
    // The single most common reason one customer becomes two records.
    expect(normalizeCompanyName('ABC Foods Pvt Ltd')).toBe('abc foods');
    expect(normalizeCompanyName('ABC Foods Private Limited')).toBe('abc foods');
    expect(normalizeCompanyName('ABC Foods')).toBe('abc foods');
    expect(normalizeCompanyName('ABC FOODS LLP')).toBe('abc foods');
  });

  it('normalises punctuation, case and spacing', () => {
    expect(normalizeCompanyName('  A.B.C.  Foods!  ')).toBe('a b c foods');
    expect(normalizeCompanyName('Café Bombay')).toBe('cafe bombay');
  });

  it('treats & and "and" as the same word', () => {
    expect(normalizeCompanyName('Shah & Sons')).toBe(normalizeCompanyName('Shah and Sons'));
  });

  it('does NOT strip a suffix that is part of a real word', () => {
    /*
     * "co" is a legal suffix, and "Cocoa" ends in it. Stripping inside a word
     * would turn Bombay Cocoa into "bombay coa" and match nothing correctly.
     */
    expect(normalizeCompanyName('Bombay Cocoa')).toBe('bombay cocoa');
    expect(normalizeCompanyName('Incorporated Systems')).toBe('incorporated systems');
  });

  it('never reduces a name to nothing', () => {
    /*
     * A company genuinely called "Limited" must not normalise to the empty
     * string — every other degenerate name would then match it.
     */
    expect(normalizeCompanyName('Limited')).not.toBe('');
    expect(normalizeCompanyName('Ltd')).not.toBe('');
  });

  it('keeps genuinely different companies different', () => {
    // The failure that matters: these are two businesses, not one.
    expect(normalizeCompanyName('Sun Foods')).not.toBe(normalizeCompanyName('Sen Foods'));
    expect(normalizeCompanyName('ABC Foods')).not.toBe(
      normalizeCompanyName('ABC Foods and Beverages'),
    );
  });
});

describe('extractDomain', () => {
  it('reads a host from a URL, with or without a scheme', () => {
    expect(extractDomain('https://www.abcfoods.com/about')).toBe('abcfoods.com');
    expect(extractDomain('abcfoods.com')).toBe('abcfoods.com');
    expect(extractDomain('HTTP://ABCFOODS.COM')).toBe('abcfoods.com');
  });

  it('reads a host from an email address', () => {
    expect(extractDomain('rajesh@abcfoods.com')).toBe('abcfoods.com');
  });

  it('REFUSES free mail providers', () => {
    /*
     * The most important case in this file. Half a city shares gmail.com, so
     * matching on it would propose merging every small customer into one.
     */
    expect(extractDomain('rajesh@gmail.com')).toBeNull();
    expect(extractDomain('someone@yahoo.co.in')).toBeNull();
    expect(extractDomain('a@outlook.com')).toBeNull();
  });

  it('returns null rather than guessing at junk', () => {
    expect(extractDomain('not a url')).toBeNull();
    expect(extractDomain('localhost')).toBeNull();
    expect(extractDomain('')).toBeNull();
    expect(extractDomain(null)).toBeNull();
    expect(extractDomain(undefined)).toBeNull();
  });
});

describe('findDuplicateCandidates', () => {
  it('rates a shared domain HIGH', () => {
    // Two companies cannot both own one domain.
    const candidates = findDuplicateCandidates(
      { name: 'Something Else Entirely', website: 'abcfoods.com' },
      [account({ domain: 'abcfoods.com', normalizedName: 'something different' })],
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.confidence).toBe('HIGH');
    expect(candidates[0]?.matchedOn).toContain('domain');
  });

  it('rates a name match alone MEDIUM, not HIGH', () => {
    /*
     * "ABC Foods" as a franchise name is exactly how a name match is wrong,
     * so it must not carry the same weight as a domain.
     */
    const candidates = findDuplicateCandidates({ name: 'ABC Foods Pvt Ltd' }, [account()]);

    expect(candidates[0]?.confidence).toBe('MEDIUM');
    expect(candidates[0]?.matchedOn).toEqual(['name']);
  });

  it('rates a phone match alone LOW', () => {
    // A shared switchboard, or an agent buying for several clients.
    const candidates = findDuplicateCandidates(
      { name: 'Totally Different', phone: '+910000000001' },
      [account({ phone: '+910000000001', normalizedName: 'totally different co ltd x' })],
    );

    expect(candidates[0]?.confidence).toBe('LOW');
    expect(candidates[0]?.matchedOn).toEqual(['phone']);
  });

  it('promotes name AND phone together to HIGH', () => {
    const candidates = findDuplicateCandidates(
      { name: 'ABC Foods', phone: '+910000000001' },
      [account({ phone: '+910000000001' })],
    );

    expect(candidates[0]?.confidence).toBe('HIGH');
    expect(candidates[0]?.matchedOn).toEqual(['name', 'phone']);
  });

  it('returns NOTHING when only a similar name is offered', () => {
    /*
     * The rule that keeps two businesses apart. No edit distance, no
     * phonetics — "Sun Foods" and "Sen Foods" are different customers and any
     * fuzzy rule would eventually merge them.
     */
    expect(findDuplicateCandidates({ name: 'Sen Foods' }, [account({ normalizedName: 'sun foods' })]))
      .toHaveLength(0);

    expect(
      findDuplicateCandidates({ name: 'ABC' }, [account({ normalizedName: 'abc foods' })]),
    ).toHaveLength(0);
  });

  it('does not match on a free mail address', () => {
    const candidates = findDuplicateCandidates(
      { name: 'Unrelated Company', email: 'someone@gmail.com' },
      [account({ domain: null, normalizedName: 'unrelated business' })],
    );

    expect(candidates).toHaveLength(0);
  });

  it('orders the strongest evidence first', () => {
    const candidates = findDuplicateCandidates(
      { name: 'ABC Foods', website: 'abcfoods.com', phone: '+91982' },
      [
        account({ id: 'weak', normalizedName: 'other', phone: '+91982' }),
        account({ id: 'strong', normalizedName: 'other two', domain: 'abcfoods.com' }),
        account({ id: 'medium', normalizedName: 'abc foods' }),
      ],
    );

    expect(candidates.map((candidate) => candidate.accountId)).toEqual([
      'strong',
      'medium',
      'weak',
    ]);
  });

  it('always reports WHICH fields matched', () => {
    // A suggestion without its evidence is indistinguishable from a guess.
    const candidates = findDuplicateCandidates(
      { name: 'ABC Foods', website: 'abcfoods.com' },
      [account({ domain: 'abcfoods.com' })],
    );

    expect(candidates[0]?.matchedOn.sort()).toEqual(['domain', 'name']);
  });
});

describe('suggestAccountsForCompanyName', () => {
  it('matches only on an exact normalised name', () => {
    const existing = [account({ id: 'exact', normalizedName: 'abc foods' })];

    expect(suggestAccountsForCompanyName('ABC Foods Pvt Ltd', existing)).toHaveLength(1);
    // Substring would file this under ABC Foods and nobody would see it happen.
    expect(suggestAccountsForCompanyName('ABC Foods and Beverages', existing)).toHaveLength(0);
  });

  it('returns EVERY match rather than picking one', () => {
    /*
     * Two accounts normalising the same way is precisely the case a person
     * must resolve, so choosing silently would hide it.
     */
    const existing = [
      account({ id: 'a', normalizedName: 'abc foods' }),
      account({ id: 'b', normalizedName: 'abc foods' }),
    ];

    expect(suggestAccountsForCompanyName('ABC Foods', existing)).toHaveLength(2);
  });

  it('suggests nothing without a company name', () => {
    expect(suggestAccountsForCompanyName(null, [account()])).toHaveLength(0);
    expect(suggestAccountsForCompanyName('', [account()])).toHaveLength(0);
  });
});

describe('groupByNormalizedName', () => {
  it('groups spellings of one company and keeps every variant', () => {
    const groups = groupByNormalizedName([
      { companyName: 'ABC Foods' },
      { companyName: 'ABC Foods Pvt Ltd' },
      { companyName: 'abc foods' },
      { companyName: 'Bombay Cocoa' },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.normalizedName).toBe('abc foods');
    expect(groups[0]?.rows).toHaveLength(3);
    // The evidence a reviewer judges the grouping by.
    expect(groups[0]?.variants).toEqual(['ABC Foods', 'ABC Foods Pvt Ltd', 'abc foods']);
  });

  it('puts the biggest group first', () => {
    const groups = groupByNormalizedName([
      { companyName: 'Solo Trader' },
      { companyName: 'ABC Foods' },
      { companyName: 'ABC Foods Ltd' },
    ]);

    expect(groups[0]?.normalizedName).toBe('abc foods');
  });

  it('drops rows with no company name rather than grouping them together', () => {
    /*
     * Grouping every nameless row into one bucket would propose merging
     * unrelated strangers into a single company. They are counted separately
     * by the service instead.
     */
    const groups = groupByNormalizedName([
      { companyName: null },
      { companyName: null },
      { companyName: 'ABC Foods' },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.rows).toHaveLength(1);
  });
});
