/**
 * The comparison form of a territory name.
 *
 * Case and spacing are the differences nobody means: "Pune / PCMC", "pune /
 * pcmc" and "Pune  /  PCMC" are one territory, and letting all three exist at
 * once would give an administrator three rows to reason about where they meant
 * one. Stored as a column rather than applied in a functional index, so the
 * lookup and the constraint apply exactly one rule.
 */
export function territoryNameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}
