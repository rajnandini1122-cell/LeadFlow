/**
 * The countries this application will accept, named in the reader's language.
 *
 * Derived from the browser's own ICU data rather than kept as a list in
 * source. The server validates country codes against the same data, so a list
 * written here would eventually offer something the API refuses — or, worse,
 * quietly omit a country a real customer is in.
 *
 * There is no API for enumerating regions, so the two-letter space is walked
 * and ICU is asked about each one. That is 676 lookups, done once and
 * remembered: a few milliseconds at first use, against a list that can never
 * drift from what the server accepts.
 */

export interface CountryOption {
  code: string;
  name: string;
}

let cached: CountryOption[] | undefined;

export function countryOptions(): CountryOption[] {
  if (cached) return cached;

  const A = 'A'.charCodeAt(0);
  const options: CountryOption[] = [];

  try {
    const display = new Intl.DisplayNames(undefined, { type: 'region' });

    for (let first = 0; first < 26; first += 1) {
      for (let second = 0; second < 26; second += 1) {
        const code = String.fromCharCode(A + first, A + second);

        // ZZ is ISO's own code for "unknown region". ICU names it, so it has
        // to be excluded deliberately or it becomes a country somebody can
        // register in.
        if (code === 'ZZ') continue;

        const name = display.of(code);
        // An unrecognised region echoes the code back rather than throwing.
        if (typeof name === 'string' && name !== code && name !== 'Unknown Region') {
          options.push({ code, name });
        }
      }
    }
  } catch {
    // Intl.DisplayNames is unavailable. The field still has to work, so it
    // falls back to the one country this deployment opens in rather than
    // rendering an empty list.
    return [{ code: DEFAULT_COUNTRY, name: 'India' }];
  }

  cached = options.sort((left, right) => left.name.localeCompare(right.name));

  return cached;
}

/**
 * What the country field starts on.
 *
 * Matches the API's own DEFAULT_COUNTRY. A mismatch would be invisible: the
 * form would submit one country while a founder who never touched the field
 * expected the other.
 */
export const DEFAULT_COUNTRY = 'IN';
