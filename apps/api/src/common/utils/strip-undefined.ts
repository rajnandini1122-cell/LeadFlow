/** Optional properties with `undefined` removed from their value types. */
export type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/**
 * Drops keys whose value is `undefined`.
 *
 * This exists to reconcile two things that are individually correct but
 * disagree at the boundary:
 *
 *   * `exactOptionalPropertyTypes` makes our own DTOs distinguish "field
 *     absent" from "field explicitly undefined" — which is exactly the
 *     distinction PATCH semantics depend on;
 *   * Prisma's generated input types declare `field?: number`, so passing
 *     `{ field: undefined }` is a type error even though Prisma ignores it.
 *
 * Rather than weaken the compiler flag across the whole project, partial
 * updates are funnelled through here on the way into Prisma. The returned type
 * reflects what actually happened, so no cast is needed at the call site.
 */
export function stripUndefined<T extends object>(input: T): Defined<T> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) result[key] = value;
  }

  return result as Defined<T>;
}
