/**
 * Phone numbers in E.164.
 *
 * Storing a bare national number only works while every tenant is in one
 * country. As soon as two organizations are in different countries, "9820011001"
 * is ambiguous and duplicate detection breaks — two different people in two
 * countries can hold the same national number.
 *
 * E.164 (`+<country><national>`, max 15 digits) is unambiguous worldwide, so it
 * is the canonical stored form and the basis for duplicate comparison.
 *
 * A full libphonenumber dependency (~500 KB) buys per-country length and prefix
 * validation. That is worth adding when the product actually sells
 * internationally; until then this does the canonicalisation correctly and
 * validates the parts of E.164 that are country-independent.
 */

/** Dialling codes for the countries we expect first. Extend as needed. */
const DIALLING_CODES: Record<string, string> = {
  IN: '91',
  US: '1',
  CA: '1',
  GB: '44',
  AE: '971',
  SG: '65',
  AU: '61',
  DE: '49',
  FR: '33',
  ZA: '27',
  NG: '234',
  KE: '254',
  BD: '880',
  PK: '92',
  LK: '94',
  NP: '977',
  MY: '60',
  ID: '62',
  PH: '63',
  BR: '55',
};

export function diallingCode(country: string): string | undefined {
  return DIALLING_CODES[country.toUpperCase()];
}

export class PhoneParseError extends Error {
  override readonly name = 'PhoneParseError';
}

/**
 * Converts user input to E.164 using the organization's country as the default
 * region.
 *
 * Accepts what people actually type: `+1 415 555 2671`, `00 44 20 7946 0958`,
 * `(415) 555-2671`, `98200 11001`.
 *
 * @param input   raw user input
 * @param country ISO 3166-1 alpha-2 of the organization, used when the input
 *                carries no international prefix
 */
export function toE164(input: string, country: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new PhoneParseError('Phone number is required.');

  // Strip framing punctuation first, so "( +65 ) 6123-4567" is still recognised
  // as international. Testing the raw input for a leading "+" misses it.
  const cleaned = trimmed.replace(/[()\s.\-/]/g, '');

  // `00` is the international prefix in much of the world; normalise it to `+`.
  const withPlus = cleaned.replace(/^00/, '+');
  const hasInternationalPrefix = withPlus.startsWith('+');
  const digits = withPlus.replace(/\D/g, '');

  if (digits.length === 0) throw new PhoneParseError('Phone number has no digits.');

  if (hasInternationalPrefix) {
    // E.164 allows at most 15 digits including the country code.
    if (digits.length < 8 || digits.length > 15) {
      throw new PhoneParseError('Phone number must be between 8 and 15 digits.');
    }
    return `+${digits}`;
  }

  const code = diallingCode(country);
  if (!code) {
    throw new PhoneParseError(
      `Include the country code (for example +1 415 555 2671) — ` +
        `no default dialling code is configured for ${country}.`,
    );
  }

  // Many countries prefix a trunk '0' for domestic dialling (09820011001,
  // 020 7946 0958). It is not part of the international number and must go, or
  // the same customer canonicalises two different ways.
  const withoutTrunk = digits.replace(/^0+/, '');

  // A national number that already begins with its own country code is a very
  // common paste; treat it as already international rather than doubling it.
  const national =
    withoutTrunk.startsWith(code) && withoutTrunk.length > code.length + 6
      ? withoutTrunk.slice(code.length)
      : withoutTrunk;

  const combined = `${code}${national}`;
  if (combined.length < 8 || combined.length > 15) {
    throw new PhoneParseError('Phone number must be between 8 and 15 digits.');
  }

  return `+${combined}`;
}

/** Best-effort readable form. Falls back to E.164, which is always valid. */
export function formatPhone(e164: string): string {
  if (!e164.startsWith('+')) return e164;

  const digits = e164.slice(1);
  for (const [, code] of Object.entries(DIALLING_CODES)) {
    if (digits.startsWith(code)) {
      const national = digits.slice(code.length);
      if (national.length >= 6) {
        const midpoint = Math.ceil(national.length / 2);
        return `+${code} ${national.slice(0, midpoint)} ${national.slice(midpoint)}`;
      }
    }
  }

  return e164;
}
