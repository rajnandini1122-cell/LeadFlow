import { getCountryCallingCode, isSupportedCountry } from 'libphonenumber-js';

/**
 * Which market a lead belongs to: the organization's home country, or abroad.
 *
 * For CRAVION (home country India) this separates domestic Indian buyers from
 * international importers. Derived, never stored: there is no new column to
 * keep in step, nothing to backfill, and correcting a lead's country or number
 * re-classifies it immediately.
 *
 *   DOMESTIC       country is the home country; or no country and the mobile
 *                  carries the home dialling code (+91 for India).
 *   INTERNATIONAL  country is any other; or no country and a foreign mobile.
 *   UNKNOWN        neither a country nor a mobile — nothing to classify by.
 *
 * Country wins over the phone when both exist: an importer's local agent may
 * call from an Indian number, but the address on the enquiry says where the
 * goods are going.
 */
export const MARKETS = ['DOMESTIC', 'INTERNATIONAL', 'UNKNOWN'] as const;
export type Market = (typeof MARKETS)[number];

/** "+91" for "IN". Null when the country has no known dialling code. */
export function homeDialPrefix(homeCountry: string): string | null {
  const code = homeCountry.toUpperCase();
  return isSupportedCountry(code) ? `+${getCountryCallingCode(code)}` : null;
}

export function leadMarket(
  lead: { country: string | null; mobile: string | null },
  homeCountry: string,
): Market {
  const home = homeCountry.toUpperCase();
  if (lead.country) return lead.country.toUpperCase() === home ? 'DOMESTIC' : 'INTERNATIONAL';
  if (lead.mobile) {
    const prefix = homeDialPrefix(home);
    if (!prefix) return 'UNKNOWN';
    return lead.mobile.startsWith(prefix) ? 'DOMESTIC' : 'INTERNATIONAL';
  }
  return 'UNKNOWN';
}

/**
 * The same rule as a Prisma WHERE on `leads`, so a filtered list, its total
 * and every count agree with the badge each row shows.
 */
export function marketWhere(market: Market, homeCountry: string): Record<string, unknown> {
  const home = homeCountry.toUpperCase();
  const prefix = homeDialPrefix(home) ?? '\u0000no-prefix';
  const homeCodes = [home, home.toLowerCase()];

  switch (market) {
    case 'DOMESTIC':
      return {
        OR: [{ country: { in: homeCodes } }, { country: null, mobile: { startsWith: prefix } }],
      };
    case 'INTERNATIONAL':
      return {
        OR: [
          { AND: [{ country: { not: null } }, { country: { notIn: homeCodes } }] },
          { country: null, mobile: { not: null }, NOT: { mobile: { startsWith: prefix } } },
        ],
      };
    case 'UNKNOWN':
      return { country: null, mobile: null };
  }
}
