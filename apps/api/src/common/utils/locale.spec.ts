import {
  isValidCountry,
  isValidCurrency,
  isValidLocale,
  isValidTimezone,
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
