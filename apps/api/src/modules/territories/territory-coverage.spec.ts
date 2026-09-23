import {
  COVERAGE_SPECIFICITY,
  coverageCandidates,
  coverageKey,
  isPostalCodeShape,
  normalizeLocation,
  normalizePlaceKey,
  normalizePlaceName,
  normalizePostalKey,
} from './territory-coverage';

/**
 * The rules that decide where a place belongs.
 *
 * Tested at this level rather than only through the API because these are the
 * functions the database's uniqueness depends on: if two spellings of Pune
 * produce two different keys, two territories can own Pune and the resolver
 * stops being deterministic — and no amount of index will catch it, because
 * the index only ever sees the keys these functions produce.
 */
describe('territory coverage', () => {
  describe('place normalisation', () => {
    it('is case-insensitive', () => {
      expect(normalizePlaceKey('Maharashtra')).toBe('maharashtra');
      expect(normalizePlaceKey('MAHARASHTRA')).toBe('maharashtra');
      expect(normalizePlaceKey('maharashtra')).toBe('maharashtra');
    });

    it('trims and collapses whitespace', () => {
      expect(normalizePlaceKey('  Navi   Mumbai  ')).toBe('navi mumbai');
    });

    it('treats blank as absent rather than as an empty place', () => {
      expect(normalizePlaceKey('   ')).toBeUndefined();
      expect(normalizePlaceKey('')).toBeUndefined();
      expect(normalizePlaceKey(null)).toBeUndefined();
      expect(normalizePlaceKey(undefined)).toBeUndefined();
    });

    it('keeps the display spelling an administrator typed', () => {
      // Only the accidents are corrected. "Navi Mumbai" stays capitalised,
      // because the table on screen should read like the table they wrote.
      expect(normalizePlaceName('  Navi   Mumbai ')).toBe('Navi Mumbai');
    });
  });

  describe('postal normalisation', () => {
    it('ignores case and spacing', () => {
      expect(normalizePostalKey('SW1A 1AA')).toBe('SW1A1AA');
      expect(normalizePostalKey('sw1a1aa')).toBe('SW1A1AA');
      expect(normalizePostalKey(' SW1A  1AA ')).toBe('SW1A1AA');
    });

    it('keeps leading zeros, because a postal code is not a number', () => {
      expect(normalizePostalKey('08540')).toBe('08540');
    });

    it('keeps hyphens, which separate meaningful parts', () => {
      // ZIP+4: 10001-1234 is not the same delivery area as 10001.
      expect(normalizePostalKey('10001-1234')).toBe('10001-1234');
      expect(normalizePostalKey('10001-1234')).not.toBe(normalizePostalKey('10001'));
    });

    it('accepts the shapes real postal codes take', () => {
      for (const code of ['411019', 'SW1A1AA', '10001', '08540', '10001-1234', 'D02AF30']) {
        expect(isPostalCodeShape(code)).toBe(true);
      }
    });

    it('refuses things that are not postal codes', () => {
      // A shape check, and nothing more: there is no claim here that 999999
      // exists, only that a sentence is not a pincode.
      for (const code of ['', 'A', 'PLEASECALLMEBACKSOON', 'PUNE MAHARASHTRA']) {
        expect(isPostalCodeShape(normalizePostalKey(code) ?? '')).toBe(false);
      }
    });

    it('refuses a message typed into the postal code box', () => {
      /*
       * The mistake people actually make, and the reason the shape rule asks
       * for a digit. "call me back" loses its spaces on the way in and arrives
       * as CALLMEBACK, which is ten characters of letters — indistinguishable
       * from a postal code by length and alphabet alone. Every national postal
       * system in use has digits in it, so requiring one costs nothing real.
       */
      expect(isPostalCodeShape(normalizePostalKey('call me back') ?? '')).toBe(false);
      expect(isPostalCodeShape(normalizePostalKey('ASAP') ?? '')).toBe(false);
    });
  });

  describe('canonical keys', () => {
    it('writes one key per selector shape', () => {
      expect(coverageKey({ type: 'COUNTRY', countryCode: 'IN' })).toBe('COUNTRY|IN');

      expect(
        coverageKey({
          type: 'STATE',
          countryCode: 'IN',
          stateKey: 'maharashtra',
          stateName: 'Maharashtra',
        }),
      ).toBe('STATE|IN|maharashtra');

      expect(
        coverageKey({
          type: 'CITY',
          countryCode: 'IN',
          stateKey: 'maharashtra',
          stateName: 'Maharashtra',
          cityKey: 'pune',
          cityName: 'Pune',
        }),
      ).toBe('CITY|IN|maharashtra|pune');

      expect(
        coverageKey({
          type: 'POSTAL_CODE',
          countryCode: 'IN',
          postalCodeKey: '411019',
          postalCode: '411019',
        }),
      ).toBe('POSTAL|IN|411019');
    });

    it('marks a city configured without a state, rather than omitting it', () => {
      expect(
        coverageKey({ type: 'CITY', countryCode: 'IN', cityKey: 'pune', cityName: 'Pune' }),
      ).toBe('CITY|IN|*|pune');
    });

    it('keeps the same city name in two states apart', () => {
      const illinois = coverageKey({
        type: 'CITY',
        countryCode: 'US',
        stateKey: 'illinois',
        stateName: 'Illinois',
        cityKey: 'springfield',
        cityName: 'Springfield',
      });
      const missouri = coverageKey({
        type: 'CITY',
        countryCode: 'US',
        stateKey: 'missouri',
        stateName: 'Missouri',
        cityKey: 'springfield',
        cityName: 'Springfield',
      });
      const unqualified = coverageKey({
        type: 'CITY',
        countryCode: 'US',
        cityKey: 'springfield',
        cityName: 'Springfield',
      });

      // Three distinct selectors, which is why two territories may each own a
      // Springfield without the unique index objecting.
      expect(new Set([illinois, missouri, unqualified]).size).toBe(3);
    });

    it('keeps the same state name in two countries apart', () => {
      const georgiaUs = coverageKey({
        type: 'STATE',
        countryCode: 'US',
        stateKey: 'georgia',
        stateName: 'Georgia',
      });
      const georgiaIn = coverageKey({
        type: 'STATE',
        countryCode: 'IN',
        stateKey: 'georgia',
        stateName: 'Georgia',
      });

      expect(georgiaUs).not.toBe(georgiaIn);
    });
  });

  describe('location normalisation', () => {
    it('upper-cases a country through the shared ICU check', () => {
      expect(normalizeLocation({ country: 'in' }).countryCode).toBe('IN');
      expect(normalizeLocation({ country: ' de ' }).countryCode).toBe('DE');
    });

    it('drops a country that is not a real region', () => {
      // B3 already refuses ZZ — "unknown or invalid region" — and this uses the
      // same function rather than a second opinion about what a country is.
      expect(normalizeLocation({ country: 'ZZ' }).countryCode).toBeUndefined();
      expect(normalizeLocation({ country: 'XX' }).countryCode).toBeUndefined();
    });

    it('drops a postal code that is not shaped like one, keeping the rest', () => {
      const location = normalizeLocation({
        country: 'IN',
        city: 'Pune',
        postalCode: 'call me back',
      });

      expect(location.postalCodeKey).toBeUndefined();
      expect(location.cityKey).toBe('pune');
    });
  });

  describe('candidate order', () => {
    it('runs most specific first', () => {
      const candidates = coverageCandidates(
        normalizeLocation({
          country: 'IN',
          state: 'Maharashtra',
          city: 'Pune',
          postalCode: '411019',
        }),
      );

      expect(candidates.map((candidate) => candidate.key)).toEqual([
        'POSTAL|IN|411019',
        'CITY|IN|maharashtra|pune',
        'CITY|IN|*|pune',
        'STATE|IN|maharashtra',
        'COUNTRY|IN',
      ]);
    });

    it('states the specificity order once, and follows it', () => {
      const candidates = coverageCandidates(
        normalizeLocation({ country: 'IN', state: 'X', city: 'Y', postalCode: '111111' }),
      );
      const seen = candidates.map((candidate) => candidate.type);

      // Each type appears in the declared order, and never out of it.
      const positions = seen.map((type) => COVERAGE_SPECIFICITY.indexOf(type));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    });

    it('prefers the city qualified by its state', () => {
      const candidates = coverageCandidates(
        normalizeLocation({ country: 'IN', state: 'Maharashtra', city: 'Pune' }),
      );

      expect(candidates[0]?.key).toBe('CITY|IN|maharashtra|pune');
      expect(candidates[1]?.key).toBe('CITY|IN|*|pune');
    });

    it('never invents a fact that was not supplied', () => {
      const candidates = coverageCandidates(normalizeLocation({ country: 'IN', city: 'Pune' }));

      // No state was given, so no state-qualified city and no state selector
      // is tried. Guessing Maharashtra from Pune would be right often enough
      // to be trusted and wrong often enough to misroute.
      expect(candidates.map((candidate) => candidate.key)).toEqual([
        'CITY|IN|*|pune',
        'COUNTRY|IN',
      ]);
    });

    it('produces nothing without a country', () => {
      // A state or a pincode with no country is a fragment: 411019 exists in
      // India, and something spelled the same may exist elsewhere. Defaulting
      // to the tenant's own country is the kind of assumption that works until
      // the first export enquiry.
      expect(coverageCandidates(normalizeLocation({ state: 'Maharashtra' }))).toEqual([]);
      expect(coverageCandidates(normalizeLocation({ postalCode: '411019' }))).toEqual([]);
      expect(coverageCandidates(normalizeLocation({}))).toEqual([]);
    });

    it('is deterministic — the same facts give the same list every time', () => {
      const facts = { country: 'IN', state: ' maharashtra ', city: 'PUNE', postalCode: '41 10 19' };
      const first = coverageCandidates(normalizeLocation(facts));
      const second = coverageCandidates(normalizeLocation(facts));

      expect(first).toEqual(second);
      expect(first[0]?.key).toBe('POSTAL|IN|411019');
    });
  });
});
