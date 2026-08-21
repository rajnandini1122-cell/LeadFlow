/**
 * Validation for tenant locale settings.
 *
 * Every check asks the runtime's own ICU data rather than a hand-maintained
 * list. A list of currencies or countries in source is wrong the moment one
 * changes, and nobody notices until a tenant cannot save their own settings.
 */

/** ISO 4217, e.g. USD, GBP, INR. */
export function isValidCurrency(code: string): boolean {
  if (!/^[A-Z]{3}$/.test(code)) return false;

  // Membership in the ISO 4217 list, not "does it format": Intl.NumberFormat
  // happily accepts any well-formed three-letter code and renders it as its
  // own symbol, so ZZZ would format fine and be stored as a real currency.
  return supportedCurrencies().includes(code);
}

/** BCP 47, e.g. en-US, en-GB, de-DE. */
export function isValidLocale(tag: string): boolean {
  try {
    const [canonical] = Intl.getCanonicalLocales(tag);
    if (!canonical) return false;
    // getCanonicalLocales accepts structurally valid tags for languages ICU has
    // no data for; formatting with it is the check that it is actually usable.
    new Intl.NumberFormat(canonical).format(0);
    return true;
  } catch {
    return false;
  }
}

/** ISO 3166-1 alpha-2, e.g. US, GB, IN. */
export function isValidCountry(code: string): boolean {
  if (!/^[A-Z]{2}$/.test(code)) return false;

  try {
    // ZZ is the ISO-assigned code for "unknown or invalid region". ICU knows
    // it and returns a name, so it passes every other check — it has to be
    // excluded by name or it becomes a valid country to store.
    if (code === 'ZZ') return false;

    const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(code);
    // An unrecognised region echoes the code straight back rather than throwing.
    return typeof name === 'string' && name !== code && name !== 'Unknown Region';
  } catch {
    return false;
  }
}

/**
 * IANA timezone.
 *
 * Deliberately NOT a regex. The obvious `^[A-Za-z]+/[A-Za-z_+-]+$` rejects
 * `UTC`, which has no slash, and `America/Argentina/Buenos_Aires`, which has
 * two — both of which are real zones a real tenant might be in.
 */
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Zones, currencies and locales this runtime can offer.
 *
 * `Intl.supportedValuesOf` is Node 18+. The fallbacks keep the settings screen
 * usable rather than empty if it is ever missing.
 */
export function supportedTimezones(current?: string): string[] {
  let zones: string[];
  try {
    zones = [...Intl.supportedValuesOf('timeZone')];
  } catch {
    zones = ['UTC'];
  }

  // supportedValuesOf returns CANONICAL names only, so a tenant stored under a
  // legacy alias — Asia/Kolkata rather than Asia/Calcutta, both perfectly
  // valid — would not find their own value in the list, and opening the
  // settings screen would silently offer to change it.
  if (current && isValidTimezone(current) && !zones.includes(current)) {
    zones = [current, ...zones];
  }
  if (!zones.includes('UTC')) zones = ['UTC', ...zones];

  return zones;
}

export function supportedCurrencies(): string[] {
  try {
    return Intl.supportedValuesOf('currency');
  } catch {
    return ['USD', 'EUR', 'GBP', 'INR'];
  }
}
