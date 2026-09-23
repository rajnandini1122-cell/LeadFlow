/**
 * Deciding whether two companies are the same company.
 *
 * Pure functions, no database, no I/O — so the rules that govern a merge can be
 * read and tested in one place rather than inferred from a query.
 *
 * The governing rule is the same one identity-resolution.service.ts already
 * applies to people: BEING WRONG IS WORSE THAN BEING UNSURE. Merging two
 * companies fuses their opportunities, their contacts, their conversations and
 * their revenue into one record, and there is no undo that separates them
 * again. So nothing here ever merges anything. It produces a SUGGESTION with
 * the fields that matched and how strong that match is, and a person who holds
 * `account.merge` decides.
 */

/** How much a candidate looks like a duplicate. Never an instruction. */
export type MatchConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface DuplicateCandidate {
  accountId: string;
  name: string;
  status: string;
  confidence: MatchConfidence;
  /** Exactly which fields agreed, so the suggestion can be judged not trusted. */
  matchedOn: string[];
}

/**
 * Legal-form suffixes stripped before comparing names.
 *
 * "ABC Foods" and "ABC Foods Pvt Ltd" are the same company written two ways,
 * and treating them as different is the single most common cause of a split
 * customer history. Ordered longest-first so "private limited" is removed
 * before "limited" can match part of it.
 */
const LEGAL_SUFFIXES = [
  'private limited',
  'public limited',
  'pvt limited',
  'pvt ltd',
  'private ltd',
  'p ltd',
  'limited',
  'incorporated',
  'corporation',
  'company',
  'llp',
  'llc',
  'ltd',
  'inc',
  'plc',
  'gmbh',
  'bv',
  'nv',
  'sa',
  'ag',
  'pte',
  'pty',
  'co',
];

/**
 * A company name reduced to something comparable.
 *
 * Lower-cased, accents folded, punctuation dropped, legal suffix removed,
 * whitespace collapsed. Deliberately NOT a fuzzy or phonetic algorithm:
 * soundex and edit distance both make "Sun Foods" and "Sen Foods" look alike,
 * and those are two different customers.
 *
 * Returns the ORIGINAL lower-cased text when stripping would leave nothing —
 * a company genuinely called "Limited" must not normalise to the empty string,
 * which would then match every other degenerate name.
 */
export function normalizeCompanyName(raw: string): string {
  const folded = raw
    .normalize('NFKD')
    // Combining marks left behind by NFKD: café -> cafe.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // Ampersand is written both ways by the same company.
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!folded) return '';

  let result = folded;
  for (const suffix of LEGAL_SUFFIXES) {
    // Only as a trailing word, so "Cocoa" never loses "co".
    const pattern = new RegExp(`\\s+${suffix}$`);
    if (pattern.test(result)) {
      result = result.replace(pattern, '').trim();
    }
  }

  return result || folded;
}

/**
 * The host part of a website or an email address, lower-cased.
 *
 * A shared domain is a much stronger signal than a shared name, because two
 * companies cannot both own one. Free mail providers are excluded for exactly
 * the opposite reason: half a city shares gmail.com, and matching on it would
 * propose merging every small customer into one.
 */
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.in',
  'yahoo.co.uk',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'protonmail.com',
  'proton.me',
  'zoho.com',
  'rediffmail.com',
  'mail.com',
  'gmx.com',
  'yandex.com',
]);

export function extractDomain(value: string | null | undefined): string | null {
  if (!value) return null;

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;

  let host: string | null = null;

  if (trimmed.includes('@')) {
    // An email address.
    const parts = trimmed.split('@');
    host = parts.length === 2 ? (parts[1] ?? null) : null;
  } else {
    // A URL, with or without a scheme.
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
      host = new URL(withScheme).hostname;
    } catch {
      // Not parseable as a URL. Not an error — it just yields no domain key.
      return null;
    }
  }

  if (!host) return null;

  host = host.replace(/^www\./, '').trim();

  // A bare label with no dot is not a domain; "localhost" and typos land here.
  if (!host.includes('.')) return null;
  if (FREE_MAIL_DOMAINS.has(host)) return null;

  return host;
}

export interface AccountMatchInput {
  name?: string | null | undefined;
  website?: string | null | undefined;
  email?: string | null | undefined;
  phone?: string | null | undefined;
}

export interface ExistingAccount {
  id: string;
  name: string;
  normalizedName: string;
  domain: string | null;
  phone: string | null;
  status: string;
}

/**
 * Scores existing accounts against a candidate, strongest first.
 *
 * Confidence, and what each level means to the person reading it:
 *
 *   HIGH   — the domain matches, or the normalised name matches AND a second
 *            field (domain or phone) agrees. Two companies do not share a
 *            domain, so this is about as certain as this system gets.
 *   MEDIUM — the normalised name matches exactly and nothing contradicts it.
 *            Usually right, and "ABC Foods" as a franchise name is exactly how
 *            it is wrong, which is why it is not HIGH.
 *   LOW    — only a phone number matches. A shared switchboard, a shared
 *            reception, or an agent buying for several clients all produce
 *            this.
 *
 * There is no threshold above which this function merges anything. Even HIGH
 * is a suggestion.
 */
export function findDuplicateCandidates(
  input: AccountMatchInput,
  existing: ExistingAccount[],
): DuplicateCandidate[] {
  const normalizedName = input.name ? normalizeCompanyName(input.name) : '';
  const domain = extractDomain(input.website) ?? extractDomain(input.email);
  const phone = input.phone?.trim() || null;

  const candidates: DuplicateCandidate[] = [];

  for (const account of existing) {
    const matchedOn: string[] = [];

    const nameMatches = normalizedName !== '' && account.normalizedName === normalizedName;
    const domainMatches = domain !== null && account.domain === domain;
    const phoneMatches = phone !== null && account.phone === phone;

    if (nameMatches) matchedOn.push('name');
    if (domainMatches) matchedOn.push('domain');
    if (phoneMatches) matchedOn.push('phone');

    if (matchedOn.length === 0) continue;

    let confidence: MatchConfidence;
    if (domainMatches) {
      confidence = 'HIGH';
    } else if (nameMatches && phoneMatches) {
      confidence = 'HIGH';
    } else if (nameMatches) {
      confidence = 'MEDIUM';
    } else {
      confidence = 'LOW';
    }

    candidates.push({
      accountId: account.id,
      name: account.name,
      status: account.status,
      confidence,
      matchedOn,
    });
  }

  const order: Record<MatchConfidence, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  return candidates.sort((a, b) => {
    const byConfidence = order[a.confidence] - order[b.confidence];
    if (byConfidence !== 0) return byConfidence;
    return b.matchedOn.length - a.matchedOn.length;
  });
}

/**
 * Suggests which existing account a historical lead or contact belongs to.
 *
 * Used by the backfill screen, where the only evidence is the free-text
 * `companyName` that was typed at the time. An EXACT normalised match, and
 * nothing looser — a substring rule would file "ABC Foods" under
 * "ABC Foods and Beverages", and the person reviewing would have no way to see
 * that it had happened.
 *
 * Returns every exact match rather than picking one, because two accounts
 * normalising the same way is precisely the case a human must resolve.
 */
export function suggestAccountsForCompanyName(
  companyName: string | null | undefined,
  existing: ExistingAccount[],
): ExistingAccount[] {
  if (!companyName) return [];

  const normalized = normalizeCompanyName(companyName);
  if (!normalized) return [];

  return existing.filter((account) => account.normalizedName === normalized);
}

/**
 * Groups unmapped free-text company names so a person can create one account
 * per real company instead of one per spelling.
 *
 * Grouping is a PROPOSAL. It says "these seven leads all wrote something that
 * normalises to abc foods"; it does not say they are the same customer, and
 * the screen shows every original spelling so the reviewer can see what is
 * actually being grouped.
 */
export function groupByNormalizedName<T extends { companyName: string | null }>(
  rows: T[],
): { normalizedName: string; variants: string[]; rows: T[] }[] {
  const groups = new Map<string, { variants: Set<string>; rows: T[] }>();

  for (const row of rows) {
    if (!row.companyName) continue;
    const key = normalizeCompanyName(row.companyName);
    if (!key) continue;

    const group = groups.get(key) ?? { variants: new Set<string>(), rows: [] };
    group.variants.add(row.companyName);
    group.rows.push(row);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([normalizedName, group]) => ({
      normalizedName,
      variants: [...group.variants].sort(),
      rows: group.rows,
    }))
    .sort((a, b) => b.rows.length - a.rows.length);
}
