import type { TenantPrincipal } from '../tenancy/tenant-context.service';

/**
 * Who is making a change, for the record.
 *
 * Domain services used to take a whole `TenantPrincipal` to perform a mutation,
 * and then read exactly one field off it: `userId`, for the audit row. That was
 * fine while every caller was a logged-in person. It stopped being fine the
 * moment a trusted server-to-server boundary needed to make the same change,
 * because there are only bad ways to satisfy a principal-shaped parameter from
 * one:
 *
 *   borrow a real user's id — which attributes an administrator's action to a
 *   colleague who was not involved;
 *
 *   invent a synthetic user — which either fails the foreign key on
 *   `audit_logs.actor_user_id` or, worse, succeeds and puts a fictional person
 *   in the audit trail;
 *
 *   pass null everywhere — which loses the attribution entirely, and makes an
 *   external administrator's change indistinguishable from the worker's.
 *
 * So the parameter says what it actually needs: who to attribute this to. Three
 * kinds, and the audit row can represent all three honestly.
 */
export type MutationActor =
  /** A signed-in person. `userId` is a real LeadFlow user. */
  | { kind: 'USER'; userId: string }
  /**
   * Automated work inside LeadFlow — the intake sweep, the follow-up worker.
   * Nobody typed it, and the audit row says so with a null actor.
   */
  | { kind: 'SYSTEM' }
  /**
   * An administrator acting through the control plane.
   *
   * `externalRef` is an OPAQUE reference supplied by the calling system. It is
   * not a LeadFlow user id, not an email, not a role and not a grant — it is
   * how that system names the person who asked, so the two trails can be lined
   * up later. It never reaches `actor_user_id`, which references real users.
   */
  | { kind: 'ADMIN_CONTROL'; externalRef: string };

/** The ordinary case: a request from a signed-in person. */
export function userActor(principal: TenantPrincipal): MutationActor {
  return { kind: 'USER', userId: principal.userId };
}

/** Automated work. */
export const SYSTEM_ACTOR: MutationActor = { kind: 'SYSTEM' };

/** An administrator, named by the system that authenticated them. */
export function adminControlActor(externalRef: string): MutationActor {
  return { kind: 'ADMIN_CONTROL', externalRef };
}

/**
 * The two audit columns that between them identify anybody.
 *
 * Both null is the system. A user id is a person here. An external ref is a
 * person somewhere else. There is no third column saying which — the pair is
 * already unambiguous, and a `kind` column would be a second source of truth
 * that could disagree with it.
 */
export function auditAttribution(actor: MutationActor): {
  actorUserId: string | null;
  externalActorRef: string | null;
} {
  switch (actor.kind) {
    case 'USER':
      return { actorUserId: actor.userId, externalActorRef: null };
    case 'ADMIN_CONTROL':
      return { actorUserId: null, externalActorRef: actor.externalRef };
    case 'SYSTEM':
      return { actorUserId: null, externalActorRef: null };
  }
}
