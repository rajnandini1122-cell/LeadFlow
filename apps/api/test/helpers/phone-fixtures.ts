/**
 * Phone numbers for fixtures that are actually phone numbers.
 *
 * Every suite used to invent its own — `415` plus seven random digits, `4477`
 * plus nine — and roughly one in nine of those was not a number that could
 * exist. A US exchange cannot begin with 1, and +44 77 plus nine digits is one
 * digit too long for the United Kingdom. They passed only because nothing
 * validated them, and the moment the API started parsing properly they became
 * intermittent 400s with no obvious cause.
 *
 * Generating them in one place means a fixture number is valid by
 * construction, and that the next suite does not have to rediscover which
 * shapes are real.
 */

/** Distinct within a run, so a partial unique index never collides. */
let sequence = 0;

function nextSuffix(): string {
  sequence += 1;

  // Sequence keeps two numbers in one file apart; randomness keeps two spec
  // FILES apart, since each gets its own module registry and its own counter.
  const noise = Math.floor(Math.random() * 1000);
  return String((sequence * 1000 + noise) % 10_000).padStart(4, '0');
}

/**
 * A US number as a person would type it: ten digits, no country code.
 *
 * Area 415, and an exchange in 200–999 — the range that does not collide with
 * the N11 service codes or the 555 range reserved for fiction, both of which
 * libphonenumber correctly refuses.
 */
export function fixtureMobile(): string {
  const exchange = 200 + Math.floor(Math.random() * 800);

  return `415${exchange}${nextSuffix()}`;
}

/** The same number in the canonical stored form. */
export function toFixtureE164(national: string): string {
  return `+1${national}`;
}

/** A US number already in E.164, for fixtures that write one directly. */
export function fixtureMobileE164(): string {
  return toFixtureE164(fixtureMobile());
}

/**
 * What a provider sends: a complete international number, digits only.
 *
 * Meta's `from` field carries no plus sign, which is exactly why it must never
 * be read as a local number.
 */
export function fixtureProviderDigits(): string {
  return `1${fixtureMobile()}`;
}

/** A UK mobile in E.164, for fixtures that want a non-US customer. */
export function fixtureUkMobileE164(): string {
  // +44 79xx xxxxxx. Avoids 7700 900xxx, the range reserved for drama, which
  // libphonenumber refuses for the same reason 555-0100 is refused in the US.
  return `+4479${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`;
}
