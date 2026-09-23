/**
 * The comparison form of a team name.
 *
 * "Pune Sales", "pune sales" and "Pune  Sales " are one team as far as an
 * administrator is concerned, so they must be one team as far as the duplicate
 * check is concerned. Stored in its own column rather than computed in an
 * index expression, because the application has to apply exactly the same rule
 * when it looks a name up — and two statements of one rule drift.
 *
 * Deliberately NOT a slug: nothing routes by team name, so stripping
 * punctuation and accents would only make two genuinely different teams
 * collide. Case and whitespace are the differences people do not mean.
 */
export function teamNameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}
