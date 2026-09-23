import { parsePhoneNumberFromString, isSupportedCountry } from 'libphonenumber-js';

/**
 * Phone numbers in E.164.
 *
 * Storing a bare national number only works while every tenant is in one
 * country. As soon as two organizations are in different countries,
 * "9820011001" is ambiguous and duplicate detection breaks — two different
 * people in two countries can hold the same national number.
 *
 * E.164 (`+<country><national>`, max 15 digits) is unambiguous worldwide, so it
 * is the canonical stored form and the basis for duplicate comparison.
 *
 * WHY A LIBRARY. This file used to carry a table of twenty dialling codes and
 * a rule that read: if a national number starts with its own country's code,
 * assume the user pasted an international number and cut the prefix off. That
 * rule silently corrupted real numbers. The Indian mobile 9187654321 begins
 * with "91"; the heuristic removed it and stored +9187654321 — a different
 * number, ten digits long, belonging to nobody, and two records for the same
 * customer entered two ways. Prefixes cannot be identified by looking at
 * leading digits; they can only be identified by knowing each country's number
 * plan, which is what libphonenumber is. The same input now resolves to
 * +919187654321, and "919820011001" still resolves to +919820011001, because
 * the library knows which of those national numbers is valid and which is not.
 */

/** Thrown for input a person supplied and must correct. */
export class PhoneParseError extends Error {
  override readonly name = 'PhoneParseError';
}

/**
 * The three outcomes a caller must tell apart.
 *
 * ABSENT is not INVALID. An optional field nobody filled in is a normal state;
 * silently turning a value somebody DID type into null because it could not be
 * parsed is how bad data gets in quietly.
 */
export type PhoneParseResult =
  | { status: 'VALID'; e164: string }
  | { status: 'ABSENT' }
  | { status: 'INVALID'; reason: string };

/**
 * Parses user input against a country context.
 *
 * `country` is the region a number with no international prefix belongs to —
 * an explicit country on the request, else the organization's, else the
 * configured default. A number that carries its own `+` ignores it entirely,
 * so a UK number entered by an Indian tenant stays a UK number.
 */
export function parsePhone(
  input: string | null | undefined,
  options: { country?: string | null | undefined } = {},
): PhoneParseResult {
  if (input === null || input === undefined) return { status: 'ABSENT' };

  const trimmed = input.trim();
  if (trimmed === '') return { status: 'ABSENT' };

  const country = options.country?.trim().toUpperCase();
  const region = country && isSupportedCountry(country) ? country : undefined;

  // `00` is the international prefix across much of Europe and Asia and is not
  // universally recognised by the parser, so it is spelled as `+` first.
  const normalized = trimmed.replace(/^00(?=\d)/, '+');

  if (!region && !normalized.startsWith('+')) {
    return {
      status: 'INVALID',
      reason:
        'Include the country code, for example +91 98200 11001 — there is no ' +
        'country to interpret a local number against.',
    };
  }

  const parsed = region
    ? parsePhoneNumberFromString(normalized, region)
    : parsePhoneNumberFromString(normalized);

  if (!parsed || !parsed.isValid()) {
    return { status: 'INVALID', reason: 'Not a valid phone number.' };
  }

  return { status: 'VALID', e164: parsed.number };
}

/**
 * Converts user input to E.164, or throws.
 *
 * The form every CRM write path uses: invalid input a person typed is a
 * validation error they can fix, never a silent null.
 */
export function toE164(input: string, country: string): string {
  const result = parsePhone(input, { country });

  if (result.status === 'ABSENT') throw new PhoneParseError('Phone number is required.');
  if (result.status === 'INVALID') throw new PhoneParseError(result.reason);

  return result.e164;
}

/**
 * Canonicalises a number a PROVIDER gave us, never one a person typed.
 *
 * Meta delivers the sender as international digits with no plus —
 * "919820011001" — which is a complete number, not a local one. Parsing it
 * against the organization's country would be wrong twice over: it invites the
 * parser to read a foreign customer's number as a local one, and it makes the
 * result depend on a tenant setting that has nothing to do with the provider.
 *
 * Returns undefined rather than throwing: an unparseable sender means we
 * cannot use the number as a matching key, not that the message should be
 * rejected.
 *
 * ONLY for fields that genuinely hold a telephone number. A WhatsApp
 * phone-number-id, a Facebook page id and an Instagram business id all look
 * like digits and are not phone numbers; they are opaque identifiers and must
 * never be passed through here.
 */
export function normalizeProviderPhone(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;

  const digits = raw.replace(/\D/g, '');
  if (digits === '') return undefined;

  const parsed = parsePhoneNumberFromString(`+${digits}`);

  return parsed?.isValid() ? parsed.number : undefined;
}

/** Readable form for display. Falls back to E.164, which is always valid. */
export function formatPhone(e164: string): string {
  const parsed = parsePhoneNumberFromString(e164);

  return parsed?.isValid() ? parsed.formatInternational() : e164;
}
