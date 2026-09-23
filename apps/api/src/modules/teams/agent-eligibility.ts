import type { RoleKey } from '@leadflow/api-types';

/**
 * Who may receive automatically assigned work.
 *
 * ONE definition, deliberately. The moment this judgement is repeated in a
 * controller, a service and a screen, the three copies start disagreeing —
 * and the symptom is a salesperson who appears in a picker and never receives
 * anything, or a manager on leave who does.
 *
 * There is no Agent table and there will not be one. An agent is an existing
 * organization membership doing sales work: the identity model is User plus
 * OrganizationUser, and a second copy of a person would immediately start
 * drifting from the first.
 */

/**
 * Roles eligible for AUTOMATIC assignment.
 *
 * SALES_REP only, and that is a decision rather than an oversight.
 *
 * MANUAL assignment is unchanged and deliberately wider: LeadsService accepts
 * any ACTIVE member, so an owner, an admin or a manager can be handed a lead
 * by a person today exactly as before — that behaviour predates teams and this
 * phase does not touch it.
 *
 * Automatic routing is a different question. Sending a share of every website
 * enquiry to whoever happens to hold an admin role would be a policy nobody
 * chose, and quietly making the founder a rep is harder to notice than it
 * sounds. A manager who genuinely carries their own pipeline can still be
 * added to a team — they simply are not an automatic-assignment candidate
 * until the assignment phase decides they should be.
 */
export const ASSIGNABLE_ROLES: readonly RoleKey[] = ['SALES_REP'];

export function isAssignableRole(role: RoleKey): boolean {
  return ASSIGNABLE_ROLES.includes(role);
}

/** Everything the decision depends on, gathered in one place. */
export interface AgentEligibilityInput {
  /** The ORGANIZATION membership status. Authoritative over everything else. */
  membershipStatus: string;
  role: RoleKey;
  /** The team-level operational pause. */
  assignmentEnabled: boolean;
  /** An archived team routes nothing. */
  teamStatus: 'ACTIVE' | 'ARCHIVED';
}

/**
 * Whether future automatic assignment may route work to this team member.
 *
 * Evaluated live, never stored. Organization membership status changes without
 * anything telling the teams module about it — somebody is suspended on a
 * Friday — and a stored flag would keep saying "eligible" until a job
 * remembered to recompute it. The stored fields are the INPUTS; this is the
 * answer.
 *
 * Note what it does NOT do: revoke, rewrite or tidy away the team membership
 * of somebody who has been suspended. Their history stays exactly as it was,
 * and becomes eligible again on its own if they come back.
 */
export function isEligibleForAssignment(input: AgentEligibilityInput): boolean {
  if (input.teamStatus !== 'ACTIVE') return false;
  if (input.membershipStatus !== 'ACTIVE') return false;
  if (!isAssignableRole(input.role)) return false;

  return input.assignmentEnabled;
}
