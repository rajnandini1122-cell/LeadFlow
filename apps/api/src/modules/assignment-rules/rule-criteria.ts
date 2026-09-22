/**
 * What a rule matches on, and how a piece of work is described to it.
 *
 * Three dimensions — source, canonical product and resolved territory —
 * combined with AND, an unset dimension meaning "any". Typed functions rather
 * than a condition language: an administrator has to be able to read a routing
 * table, and a rule expressed as user-supplied logic is a rule nobody can audit
 * and a different product's threat model.
 *
 * Territory arrived exactly as the seam promised it would: one field on
 * `AssignmentContext`, one entry in `DIMENSIONS`, one more segment in the
 * criteria key. The evaluator below was not touched, because it does not know
 * what the dimensions are — it asks each one whether it is satisfied. That is
 * the whole reason this file is a list rather than a chain of if-statements,
 * and it is why there is no geography in it: a territory reaches here already
 * RESOLVED, as an id. Matching a city string here would make every rule its own
 * private geography database.
 */

/**
 * The comparison form of a lead source.
 *
 * Source is free text in this product by design: every organization keeps its
 * own list in OrganizationSettings.leadSources, so an enum here would be a
 * second taxonomy disagreeing with theirs. Case and spacing are the
 * differences nobody means — "Website", "website" and " Web site " are not
 * three sources, though the last is genuinely a different one.
 *
 * It is also what lets a website intake meet a tenant's own vocabulary: J1
 * records `WEBSITE`, a tenant configures `Website`, and both normalise here to
 * the same key.
 */
export function normalizeSourceKey(source: string | null | undefined): string | undefined {
  const trimmed = source?.trim().replace(/\s+/g, ' ').toLowerCase();

  return trimmed ? trimmed : undefined;
}

/** The facts about one piece of work, as the evaluator understands them. */
export interface AssignmentContext {
  /** The lead source, in whatever spelling it arrived. Normalised here. */
  source?: string | null | undefined;
  /** A CANONICAL product id. Never free text a customer typed. */
  productId?: string | null | undefined;
  /**
   * A RESOLVED territory id. Never a country, state, city or pincode.
   *
   * TerritoriesService turns geography into this before the evaluator sees it,
   * so the routing table holds one fact per dimension and the coverage table
   * stays the single place a place is described.
   */
  territoryId?: string | null | undefined;
}

/** The criteria of one rule, already normalised. */
export interface RuleCriteria {
  sourceKey?: string | null | undefined;
  productId?: string | null | undefined;
  territoryId?: string | null | undefined;
}

/**
 * One dimension of matching.
 *
 * `key` names it in the criteria key; `of` reads it from a rule; `from` reads
 * the same fact from the work being routed.
 */
interface Dimension {
  key: string;
  of: (criteria: RuleCriteria) => string | undefined;
  from: (context: AssignmentContext) => string | undefined;
}

const DIMENSIONS: readonly Dimension[] = [
  {
    key: 'source',
    of: (criteria) => criteria.sourceKey ?? undefined,
    from: (context) => normalizeSourceKey(context.source),
  },
  {
    key: 'product',
    of: (criteria) => criteria.productId ?? undefined,
    from: (context) => context.productId ?? undefined,
  },
  /*
   * Appended rather than inserted, and that is load-bearing.
   *
   * The criteria key is the concatenation of these entries in order, so every
   * key written before territories existed becomes itself plus `|territory=*`
   * — one constant suffix, which the migration applies to every row. Put
   * territory in the middle and the migration would have to rebuild each key
   * from columns instead, and a rule whose stored source spelling differed
   * from what the generator produces today would silently change identity.
   */
  {
    key: 'territory',
    of: (criteria) => criteria.territoryId ?? undefined,
    from: (context) => context.territoryId ?? undefined,
  },
];

/**
 * Whether every criterion this rule states is satisfied.
 *
 * AND across the dimensions a rule sets; a dimension it leaves unset matches
 * anything. A rule that states a criterion the work does not carry does NOT
 * match — an enquiry with no product is not "any product", it is a fact we do
 * not have, and routing it by a product rule would be a guess.
 */
export function criteriaMatch(criteria: RuleCriteria, context: AssignmentContext): boolean {
  return DIMENSIONS.every((dimension) => {
    const required = dimension.of(criteria);
    if (required === undefined) return true;

    return dimension.from(context) === required;
  });
}

/**
 * The normalised criteria as one comparable string.
 *
 * Server-generated, never accepted from a caller: it is what the database uses
 * to refuse two ACTIVE rules that match identical input and disagree about the
 * answer. `*` marks a dimension the rule does not constrain, so "any source,
 * product X" and "source Y, product X" are different keys while two spellings
 * of the same source are one.
 */
export function criteriaKey(criteria: RuleCriteria): string {
  return DIMENSIONS.map((dimension) => `${dimension.key}=${dimension.of(criteria) ?? '*'}`).join(
    '|',
  );
}

/** True when a rule constrains nothing — which only a fallback may do. */
export function hasNoCriteria(criteria: RuleCriteria): boolean {
  return DIMENSIONS.every((dimension) => dimension.of(criteria) === undefined);
}
