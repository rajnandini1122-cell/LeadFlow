import { AppException } from '../../common/errors/app.exception';
import { PhoneParseError, toE164 } from '../../common/utils/phone';

/**
 * A lead's extra phone numbers, as stored: E.164 against the tenant's country
 * (the same rule as `mobile`, so "020-29512009" and "+91 20 2951 2009" are one
 * number), minus repeats and minus the primary mobile itself.
 *
 * A number that cannot be read is a 422 naming WHICH entry, rather than being
 * dropped: a salesperson who typed a landline should learn it did not save.
 */
export function normaliseAdditionalPhones(
  inputs: readonly string[],
  primary: string | null,
  country: string,
): string[] {
  const out: string[] = [];
  for (const [index, input] of inputs.entries()) {
    let e164: string;
    try {
      e164 = toE164(input, country);
    } catch (error) {
      if (error instanceof PhoneParseError) {
        throw AppException.validation(`Additional phone ${index + 1}: ${error.message}`, {
          additionalPhones: [`"${input}" — ${error.message}`],
        });
      }
      throw error;
    }
    if (e164 !== primary && !out.includes(e164)) out.push(e164);
  }
  return out;
}
