import {
  isValidCountry,
  isValidCurrency,
  isValidLocale,
  isValidTimezone,
  normalizeCountry,
  normalizeCurrency,
  normalizeLocale,
  normalizeTimezone,
  supportedCurrencies,
  supportedTimezones,
} from './locale';

describe('isValidCurrency', () => {
  it.each(['USD', 'GBP', 'INR', 'EUR', 'JPY', 'AED'])('accepts %s', (code) => {
    expect(isValidCurrency(code)).toBe(true);
  });

  it.each(['usd', 'US', 'USDD', '123', '', 'ZZZ'])('rejects %s', (code) => {
    expect(isValidCurrency(code)).toBe(false);
  });
});

describe('isValidLocale', () => {
  it.each(['en-US', 'en-GB', 'de-DE', 'hi-IN', 'ja-JP', 'en'])('accepts %s', (tag) => {
    expect(isValidLocale(tag)).toBe(true);
  });

  it.each(['en_US', 'not a locale', '', '@@'])('rejects %s', (tag) => {
    expect(isValidLocale(tag)).toBe(false);
  });
});

describe('isValidCountry', () => {
  it.each(['US', 'GB', 'IN', 'AE', 'DE'])('accepts %s', (code) => {
    expect(isValidCountry(code)).toBe(true);
  });

  it.each(['us', 'USA', 'ZZ', '', '12'])('rejects %s', (code) => {
    expect(isValidCountry(code)).toBe(false);
  });
});

describe('isValidTimezone', () => {
  it.each(['UTC', 'America/Chicago', 'Europe/London', 'Asia/Kolkata'])(
    'accepts %s',
    (zone) => {
      expect(isValidTimezone(zone)).toBe(true);
    },
  );

  it('accepts a zone with no slash', () => {
    // The regex this replaced required one, so a tenant on UTC could not save
    // their own settings.
    expect(isValidTimezone('UTC')).toBe(true);
  });

  it('accepts a zone with two slashes', () => {
    // Same bug, other end: the regex allowed exactly one separator.
    expect(isValidTimezone('America/Argentina/Buenos_Aires')).toBe(true);
    expect(isValidTimezone('America/Indiana/Indianapolis')).toBe(true);
  });

  it.each(['Mars/Olympus_Mons', 'Not/AZone', '', 'GMT+5'])('rejects %s', (zone) => {
    expect(isValidTimezone(zone)).toBe(false);
  });

  it.each(['IST', 'EST', 'PST', 'CET'])('rejects the abbreviation %s', (abbreviation) => {
    /*
     * ICU accepts these and resolves them to somewhere nobody meant. "IST"
     * becomes Asia/Calcutta, which is at least the right country — but "EST"
     * becomes America/Panama, which is NOT US Eastern: it keeps no daylight
     * saving, so a tenant who typed the abbreviation everybody uses would find
     * every follow-up an hour out for half the year, with nothing to show for
     * it but a setting that looked accepted.
     */
    expect(isValidTimezone(abbreviation)).toBe(false);
  });

  it('rejects an identifier in the wrong case', () => {
    // ICU is case-insensitive here; the tz database is not, and a stored value
    // that does not match any identifier is a value no other tool will read.
    expect(isValidTimezone('asia/kolkata')).toBe(false);
    expect(isValidTimezone('Asia/Kolkata')).toBe(true);
  });

  it('accepts every zone this runtime itself lists', () => {
    // The property that keeps the tightened shape rule honest: it must not
    // reject a single real zone.
    expect(supportedTimezones().filter((zone) => !isValidTimezone(zone))).toEqual([]);
  });
});

describe('canonical forms', () => {
  describe('normalizeCountry', () => {
    it('upper-cases what a person typed', () => {
      // "in" is what somebody types; IN is what everything else compares
      // against. Correcting it here is what stops the same country being
      // stored two ways and then read as two different places.
      expect(normalizeCountry('in')).toBe('IN');
      expect(normalizeCountry(' In ')).toBe('IN');
      expect(normalizeCountry('IN')).toBe('IN');
    });

    it.each(['ZZ', 'IND', 'India', '1', 'XX', '', '  ', null, undefined])(
      'refuses %p rather than storing it',
      (value) => {
        // ZZ is ISO's own code for "unknown region" — ICU will happily name it,
        // which is exactly why it has to be excluded deliberately.
        expect(normalizeCountry(value)).toBeUndefined();
      },
    );
  });

  describe('normalizeCurrency', () => {
    it('upper-cases a real code', () => {
      expect(normalizeCurrency('inr')).toBe('INR');
      expect(normalizeCurrency(' eur ')).toBe('EUR');
    });

    it.each(['ZZZ', 'RUPEES', '12', '', null])('refuses %p', (value) => {
      expect(normalizeCurrency(value)).toBeUndefined();
    });
  });

  describe('normalizeLocale', () => {
    it('returns the canonical casing', () => {
      expect(normalizeLocale('en-in')).toBe('en-IN');
      expect(normalizeLocale('DE-de')).toBe('de-DE');
      expect(normalizeLocale('fr-FR')).toBe('fr-FR');
    });

    it.each(['en_US', 'not a locale', '', '@@', null])('refuses %p', (value) => {
      expect(normalizeLocale(value)).toBeUndefined();
    });
  });

  describe('normalizeTimezone', () => {
    it('trims but never re-cases', () => {
      expect(normalizeTimezone(' Asia/Kolkata ')).toBe('Asia/Kolkata');
    });

    it('refuses a zone in the wrong case rather than guessing', () => {
      // Zone identifiers are case-sensitive and there is no reliable repair:
      // "asia/kolkata" could only be fixed by guessing, and a guess that lands
      // on the wrong zone moves every follow-up in the tenant by hours.
      expect(normalizeTimezone('asia/kolkata')).toBeUndefined();
    });

    it.each(['IST', 'India', 'GMT+5:30', 'xyz', '', null])('refuses %p', (value) => {
      expect(normalizeTimezone(value)).toBeUndefined();
    });
  });
});

describe('supported value lists', () => {
  it('offers real timezones', () => {
    const zones = supportedTimezones();
    expect(zones.length).toBeGreaterThan(100);
    expect(zones).toContain('America/Chicago');
    expect(zones).toContain('Europe/London');
    expect(zones).toContain('UTC');
  });

  it('includes the tenant current zone even when it is a legacy alias', () => {
    // Intl lists CANONICAL names only: it has Asia/Calcutta, not Asia/Kolkata.
    // Both are valid zones, and a tenant stored under the alias must still
    // find their own value in the list rather than be offered a silent change.
    expect(supportedTimezones()).not.toContain('Asia/Kolkata');
    expect(supportedTimezones('Asia/Kolkata')).toContain('Asia/Kolkata');
  });

  it('ignores a current zone that is not real', () => {
    expect(supportedTimezones('Mars/Olympus_Mons')).not.toContain('Mars/Olympus_Mons');
  });

  it('offers real currencies', () => {
    const currencies = supportedCurrencies();
    expect(currencies).toContain('USD');
    expect(currencies).toContain('GBP');
    expect(currencies).toContain('INR');
  });

  it('every offered value validates', () => {
    // The property that matters: the settings screen cannot present an option
    // the API would then refuse.
    for (const zone of supportedTimezones().slice(0, 50)) {
      expect(isValidTimezone(zone)).toBe(true);
    }
    for (const currency of supportedCurrencies().slice(0, 50)) {
      expect(isValidCurrency(currency)).toBe(true);
    }
  });
});
