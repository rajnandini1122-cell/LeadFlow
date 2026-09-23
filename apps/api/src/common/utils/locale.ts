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
  /*
   * ICU membership is necessary but NOT sufficient.
   *
   * It also accepts the old abbreviations, and resolves them to things nobody
   * means: "IST" becomes Asia/Calcutta, and "EST" becomes America/Panama —
   * which is not US Eastern, keeps no daylight saving, and would quietly move
   * every follow-up in that tenant by an hour for half the year. It is
   * case-insensitive too, so "asia/kolkata" passes while being nobody's idea
   * of an identifier.
   *
   * So the identifier must also be SHAPED like one: Region/City, spelled as
   * the tz database spells it, with UTC as the one accepted bare name. That is
   * a check on form rather than a list of zones, so it cannot go stale when
   * the database changes.
   */
  if (timezone !== 'UTC' && !IANA_IDENTIFIER.test(timezone)) return false;

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Region/City, or Region/Group/City — each part capitalised, as every zone in
 * the tz database is. `Etc/GMT+5` and `America/Port-au-Prince` are real
 * identifiers and pass; `IST` and `asia/kolkata` are not and do not.
 */
const IANA_IDENTIFIER = /^[A-Z][A-Za-z_-]*(?:\/[A-Z][A-Za-z0-9_+-]*){1,2}$/;

/**
 * Canonical forms for the tenant identity settings.
 *
 * Each returns undefined for something it cannot vouch for, so a caller must
 * decide what to do rather than receiving a plausible-looking value it never
 * checked. Case is the common difference — "in" and "inr" are what people
 * type — and it is corrected here rather than at each call site, so a value
 * cannot be stored in one case and compared in another.
 *
 * Country deliberately uses ICU rather than libphonenumber's list. ICU is
 * already the source behind organization settings and the public enquiry form,
 * and two region lists that disagree would mean a country a tenant can save
 * and then cannot use, or the reverse. Phone parsing keeps its own question —
 * "is there a numbering plan for this region" — and answers it separately.
 */
export function normalizeCountry(raw: string | null | undefined): string | undefined {
  const code = raw?.trim().toUpperCase();

  return code && isValidCountry(code) ? code : undefined;
}

/** ISO 4217, upper-cased: "inr" becomes INR. */
export function normalizeCurrency(raw: string | null | undefined): string | undefined {
  const code = raw?.trim().toUpperCase();

  return code && isValidCurrency(code) ? code : undefined;
}

/** BCP 47, in ICU's canonical casing: "en-in" becomes en-IN. */
export function normalizeLocale(raw: string | null | undefined): string | undefined {
  const tag = raw?.trim();
  if (!tag || !isValidLocale(tag)) return undefined;

  return Intl.getCanonicalLocales(tag)[0];
}

/**
 * An IANA zone, exactly as given.
 *
 * NOT case-corrected: zone identifiers are case-sensitive and there is no
 * reliable way to repair one, so "asia/kolkata" is rejected rather than
 * guessed at.
 */
export function normalizeTimezone(raw: string | null | undefined): string | undefined {
  const zone = raw?.trim();

  return zone && isValidTimezone(zone) ? zone : undefined;
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
