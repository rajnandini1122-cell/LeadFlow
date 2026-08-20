/**
 * Organization slug generation.
 *
 * A slug appears in URLs and is a tenant's public handle, so it must be
 * lowercase, URL-safe, and unique — but a *collision must never fail the
 * registration*. Two unrelated businesses are entitled to the same trading
 * name, and rejecting the second one at signup would be a poor first
 * impression for a problem the system can solve itself.
 */

const MAX_LENGTH = 60;

/**
 * Best-effort slug from a display name.
 *
 * Accents are decomposed and stripped rather than dropped, so "Björk & Sons"
 * yields "bjork-sons" instead of "bj-rk-sons".
 */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_LENGTH)
    .replace(/-+$/g, '');
}

/** Slugs that would collide with a route or read as official. */
const RESERVED = new Set([
  'api',
  'admin',
  'app',
  'www',
  'auth',
  'login',
  'logout',
  'register',
  'invitations',
  'settings',
  'support',
  'help',
  'status',
  'billing',
  'new',
  'null',
  'undefined',
]);

export function isReserved(slug: string): boolean {
  return RESERVED.has(slug);
}

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSlug(slug: string): boolean {
  return slug.length >= 2 && slug.length <= MAX_LENGTH && SLUG_PATTERN.test(slug);
}

/**
 * Finds a free slug near `desired`.
 *
 * Suffixes with -2, -3, … and then falls back to a random suffix. `isTaken` is
 * supplied by the caller so this stays free of database concerns and directly
 * testable.
 *
 * This narrows the race window but does not close it: two simultaneous
 * registrations can still agree on the same free slug. The unique constraint on
 * organizations.slug is what actually decides, and the caller retries.
 */
export async function resolveAvailableSlug(
  desired: string,
  isTaken: (slug: string) => Promise<boolean>,
  attempts = 25,
): Promise<string> {
  const base = slugify(desired) || 'org';

  for (let index = 0; index < attempts; index += 1) {
    const candidate = index === 0 ? base : `${base}-${index + 1}`;
    if (isReserved(candidate)) continue;
    if (!(await isTaken(candidate))) return candidate;
  }

  // Sequential suffixes exhausted — extremely unlikely, but registration must
  // still succeed rather than dead-end the customer.
  for (let index = 0; index < 5; index += 1) {
    const candidate = `${base}-${Math.random().toString(36).slice(2, 8)}`;
    if (!(await isTaken(candidate))) return candidate;
  }

  throw new Error(`Could not allocate a slug for "${desired}"`);
}
