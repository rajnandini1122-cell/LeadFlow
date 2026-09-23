import { normalizeCountry } from '../../common/utils/locale';

/**
 * How a place is written down, compared, and looked up.
 *
 * Four explicit selector shapes — a country, a state, a city, a postal code —
 * and one canonical string per selector. No ranges, no wildcards, no patterns,
 * no coordinates: routing has to be something an administrator can read back
 * and a support call can explain, and "why did this enquiry go there" must have
 * an answer shorter than a regex.
 *
 * Normalisation here is IDENTITY normalisation only. There is no canonical
 * global list of states or cities to validate against, and a homemade one would
 * refuse places that exist while going stale the moment a border moves. What is
 * corrected is the difference nobody means: case, and spacing.
 *
 * Country is the exception, and deliberately: it has a real standard, and B3
 * already owns it. `normalizeCountry` is ICU-backed and is the same function
 * organization settings and the website intake use, so a country a tenant can
 * save is a country they can route on.
 */

export const COVERAGE_TYPES = ['COUNTRY', 'STATE', 'CITY', 'POSTAL_CODE'] as const;
export type CoverageType = (typeof COVERAGE_TYPES)[number];

/**
 * Specificity, most specific first.
 *
 * The whole order in one place, so "postal beats city beats state beats
 * country" is a value the resolver reads rather than a sequence of branches
 * somebody could reorder by accident.
 */
export const COVERAGE_SPECIFICITY: readonly CoverageType[] = [
  'POSTAL_CODE',
  'CITY',
  'STATE',
  'COUNTRY',
];

/**
 * A place name reduced to its comparison form.
 *
 * "Maharashtra", "maharashtra" and " MAHARASHTRA " are one state; "Navi
 * Mumbai" and "Navi  Mumbai" are one city. The display spelling is kept
 * separately, because an administrator should see the table they typed.
 */
export function normalizePlaceKey(raw: string | null | undefined): string | undefined {
  const trimmed = raw?.trim().replace(/\s+/g, ' ').toLowerCase();

  return trimmed ? trimmed : undefined;
}

/** The display spelling: trimmed and de-doubled, otherwise exactly as typed. */
export function normalizePlaceName(raw: string | null | undefined): string | undefined {
  const trimmed = raw?.trim().replace(/\s+/g, ' ');

  return trimmed ? trimmed : undefined;
}

/**
 * A postal code reduced to its comparison form.
 *
 * Case and internal spacing are the formatting differences people make without
 * meaning anything by them: "sw1a 1aa", "SW1A1AA" and "SW1A  1AA" are one
 * place. Hyphens are KEPT — in a US ZIP+4 and an Irish Eircode they separate
 * two meaningful parts, and stripping them would merge codes that are not the
 * same.
 *
 * A string throughout. As an integer, 08540 becomes 8540 and SW1A 1AA becomes
 * nothing at all.
 */
export function normalizePostalKey(raw: string | null | undefined): string | undefined {
  const compact = raw?.replace(/\s+/g, '').toUpperCase();

  return compact ? compact : undefined;
}

/**
 * Whether a postal code is SHAPED like one.
 *
 * A format check and nothing more. No country-specific database, and no claim
 * that the code EXISTS: this phase routes on codes an administrator explicitly
 * configured, so the only real question is whether the thing typed could be a
 * postal code at all rather than a sentence or an address.
 *
 * Three to ten characters of letters, digits and hyphens — and AT LEAST ONE
 * DIGIT. The digit is what separates 411019, SW1A 1AA and D02 AF30 from
 * "call me back", which survives whitespace removal as a perfectly
 * postal-code-shaped CALLMEBACK otherwise. Every national postal system in use
 * includes digits, so the rule costs nothing real and catches the mistake
 * people actually make: typing a message into the wrong box.
 */
const POSTAL_CODE_SHAPE = /^[A-Z0-9][A-Z0-9-]{1,8}[A-Z0-9]$/;

export function isPostalCodeShape(key: string): boolean {
  return POSTAL_CODE_SHAPE.test(key) && /\d/.test(key);
}

/** One configured selector, already normalised. */
export type CoverageSelector =
  | { type: 'COUNTRY'; countryCode: string }
  | { type: 'STATE'; countryCode: string; stateKey: string; stateName: string }
  | {
      type: 'CITY';
      countryCode: string;
      /** Optional: many countries have no province layer worth naming. */
      stateKey?: string | undefined;
      stateName?: string | undefined;
      cityKey: string;
      cityName: string;
    }
  | { type: 'POSTAL_CODE'; countryCode: string; postalCodeKey: string; postalCode: string };

/**
 * The selector as one comparable string.
 *
 * Server-generated, never accepted from a caller: it is what the database uses
 * to refuse two territories claiming the same place, and a caller that could
 * choose it could claim somebody else's.
 *
 * `*` in the city form marks a city configured WITHOUT a state. That is a
 * different selector from the same city name under a named state, not a
 * looser version of it — Springfield in Illinois and Springfield in Missouri
 * are two cities, and a bare "Springfield" is a third thing: the one somebody
 * configured without saying which.
 */
export function coverageKey(selector: CoverageSelector): string {
  switch (selector.type) {
    case 'COUNTRY':
      return `COUNTRY|${selector.countryCode}`;
    case 'STATE':
      return `STATE|${selector.countryCode}|${selector.stateKey}`;
    case 'CITY':
      return `CITY|${selector.countryCode}|${selector.stateKey ?? '*'}|${selector.cityKey}`;
    case 'POSTAL_CODE':
      return `POSTAL|${selector.countryCode}|${selector.postalCodeKey}`;
  }
}

/** The geographic facts a lookup carries, as they arrived. */
export interface LocationFacts {
  country?: string | null | undefined;
  state?: string | null | undefined;
  city?: string | null | undefined;
  postalCode?: string | null | undefined;
}

/** The same facts, normalised. Anything unusable is simply absent. */
export interface NormalizedLocation {
  countryCode?: string | undefined;
  stateKey?: string | undefined;
  cityKey?: string | undefined;
  postalCodeKey?: string | undefined;
}

export function normalizeLocation(facts: LocationFacts): NormalizedLocation {
  const postalCodeKey = normalizePostalKey(facts.postalCode);

  return {
    ...(normalizeCountry(facts.country) ? { countryCode: normalizeCountry(facts.country) } : {}),
    ...(normalizePlaceKey(facts.state) ? { stateKey: normalizePlaceKey(facts.state) } : {}),
    ...(normalizePlaceKey(facts.city) ? { cityKey: normalizePlaceKey(facts.city) } : {}),
    ...(postalCodeKey && isPostalCodeShape(postalCodeKey) ? { postalCodeKey } : {}),
  };
}

/** A selector worth looking up, and how specific it is. */
export interface CoverageCandidate {
  type: CoverageType;
  key: string;
}

/**
 * Every selector these facts could match, MOST SPECIFIC FIRST.
 *
 * The resolver walks this list and takes the first key a live coverage row
 * owns. Two properties make that deterministic rather than merely usually
 * right:
 *
 *   the order is fixed here, not decided by what the database returns; and
 *
 *   a fact that is missing produces no candidate. An enquiry with no pincode
 *   is not "pincode unknown, try the city's pincode" — it is a fact we do not
 *   have, and inventing one would route a customer on a guess.
 *
 * Everything needs a country. A state or a city with no country is ambiguous
 * across the world, and quietly assuming the tenant's own country would be the
 * kind of default that works until the first export enquiry.
 */
export function coverageCandidates(location: NormalizedLocation): CoverageCandidate[] {
  const { countryCode, stateKey, cityKey, postalCodeKey } = location;
  if (!countryCode) return [];

  const candidates: CoverageCandidate[] = [];

  if (postalCodeKey) {
    candidates.push({ type: 'POSTAL_CODE', key: coverageKey({ type: 'POSTAL_CODE', countryCode, postalCodeKey, postalCode: postalCodeKey }) });
  }

  if (cityKey) {
    // The city under its state first: a city configured WITH a state is the
    // more context-specific selector, and preferring it is what keeps two
    // Springfields apart. Only tried when the enquiry actually named a state —
    // the state is never guessed from the city.
    if (stateKey) {
      candidates.push({
        type: 'CITY',
        key: coverageKey({ type: 'CITY', countryCode, stateKey, cityKey, cityName: cityKey }),
      });
    }

    candidates.push({
      type: 'CITY',
      key: coverageKey({ type: 'CITY', countryCode, cityKey, cityName: cityKey }),
    });
  }

  if (stateKey) {
    candidates.push({ type: 'STATE', key: coverageKey({ type: 'STATE', countryCode, stateKey, stateName: stateKey }) });
  }

  candidates.push({ type: 'COUNTRY', key: coverageKey({ type: 'COUNTRY', countryCode }) });

  return candidates;
}
