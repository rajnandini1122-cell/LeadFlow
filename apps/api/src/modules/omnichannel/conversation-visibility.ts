import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { resolveLeadVisibility } from '../leads/lead-visibility';

/**
 * Who may see which conversation.
 *
 * ONE definition, used by the inbox, the review queue, every count badge and
 * every detail read. Two copies of a rule like this drift, and the way you find
 * out is a salesperson reading a customer enquiry they were never meant to see.
 *
 * The policy is derived entirely from the lead visibility the product already
 * has — no new roles, no omnichannel permission set. That is deliberate: a
 * conversation is correspondence about a deal, so whoever may see the deal may
 * see the correspondence, and nobody gains reach by going through the inbox
 * instead of the pipeline.
 *
 *   lead.view.all / lead.view.team   everything in the organization
 *   lead.view.own                    their own conversations, conversations on
 *                                    leads assigned to them, and — only if the
 *                                    organization switched the shared queue on
 *                                    — conversations nobody owns
 *
 * Phase C let anyone see every unowned conversation. That was too generous:
 * an unassigned enquiry is a customer's private message to the business, not a
 * shared noticeboard, and "nobody has picked it up yet" is not a reason to show
 * it to everyone. The shared queue setting makes it a decision the organization
 * makes rather than one the software makes for them.
 */

export type ConversationScope =
  /** No restriction inside the tenant. */
  | { kind: 'ALL' }
  /** Restricted to this user, with unowned threads included or not. */
  | { kind: 'OWN'; userId: string; includeUnassigned: boolean };

export function conversationScope(
  principal: TenantPrincipal,
  sharedUnassignedQueue: boolean,
): ConversationScope {
  const visibility = resolveLeadVisibility(principal);

  // TEAM and ALL are the same here for the same reason they are the same for
  // leads: there is no reporting hierarchy yet. Kept distinct at the source so
  // introducing one later is a change in lead-visibility.ts, not here.
  if (visibility !== 'OWN') return { kind: 'ALL' };

  return { kind: 'OWN', userId: principal.userId, includeUnassigned: sharedUnassignedQueue };
}

/**
 * The scope as a Prisma `where` fragment, or undefined for no restriction.
 *
 * Applied inside the query rather than filtered afterwards, so a conversation
 * the caller may not see is never loaded, never counted, and never leaks
 * through a total.
 */
export function conversationScopeFilter(
  scope: ConversationScope,
): Record<string, unknown> | undefined {
  if (scope.kind === 'ALL') return undefined;

  const clauses: Record<string, unknown>[] = [
    { ownerId: scope.userId },
    // Linked to a lead assigned to them. Without this, a rep would lose sight
    // of the conversation on their own deal the moment ownership of the thread
    // was not set explicitly.
    { lead: { assignedToId: scope.userId } },
  ];

  if (scope.includeUnassigned) {
    // Unowned AND unlinked. An unowned conversation attached to someone else's
    // lead is still that person's business, and the shared queue is about
    // enquiries nobody has picked up — not about a back door into linked ones.
    clauses.push({ ownerId: null, leadId: null });
  }

  return { OR: clauses };
}
