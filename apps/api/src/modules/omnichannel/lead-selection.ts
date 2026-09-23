import { isTerminal } from '../leads/lead-status';
import type { LeadStatus } from '@leadflow/api-types';

/**
 * Choosing which existing lead an incoming message belongs to.
 *
 * Pure and deterministic on purpose: this is the decision that can attach a
 * customer's message to the wrong deal, and a wrong attachment is worse than no
 * attachment. Wrong means a rep reads a stranger's pricing question inside
 * someone else's negotiation, and the real enquiry is never answered.
 *
 * Kept free of Prisma so the rules can be tested exhaustively without a
 * database, and so the rules are readable in one screen.
 */

export interface LeadCandidate {
  id: string;
  leadNumber: string;
  status: LeadStatus;
  assignedToId: string | null;
  companyName: string | null;
  createdAt: Date;
}

export type LeadSelection =
  /** Exactly one lead this conversation belongs to. */
  | { outcome: 'MATCHED'; lead: LeadCandidate }
  /** Nobody to attach to. The conversation stays unlinked. */
  | { outcome: 'NONE' }
  /** Several plausible leads. A human decides; nothing is attached meanwhile. */
  | { outcome: 'AMBIGUOUS'; candidates: LeadCandidate[] };

/**
 * @param candidates every non-archived lead for the resolved contact, in this
 *   organization. The caller is responsible for that scoping — this function
 *   trusts what it is given and does no tenant checking of its own.
 * @param alreadyLinkedLeadId the lead this conversation is already attached to,
 *   if any.
 */
export function selectLead(
  candidates: readonly LeadCandidate[],
  alreadyLinkedLeadId?: string | null,
): LeadSelection {
  /*
   * Priority 1: the conversation already belongs somewhere.
   *
   * This is what makes redelivery safe. A provider replaying yesterday's
   * message must land back on the same lead, not be re-evaluated against a
   * pipeline that has moved on since — otherwise a lead that was won in the
   * meantime would push the replay into the ambiguous branch and raise a
   * review nobody asked for.
   */
  if (alreadyLinkedLeadId) {
    const linked = candidates.find((lead) => lead.id === alreadyLinkedLeadId);
    if (linked) return { outcome: 'MATCHED', lead: linked };
  }

  /*
   * Priority 2: active leads only.
   *
   * A WON deal is finished and a LOST one was walked away from; a new message
   * about either is new business, and the existing flow already says so — the
   * status machine refuses to reopen WON precisely so that closed revenue
   * stays closed.
   */
  const active = candidates.filter((lead) => !isTerminal(lead.status));

  if (active.length === 0) return { outcome: 'NONE' };
  if (active.length === 1) return { outcome: 'MATCHED', lead: active[0] as LeadCandidate };

  /*
   * Priority 3: more than one active lead for the same person.
   *
   * The brief offers "most recent active lead" as a tie-breaker, and it is
   * genuinely deterministic — but applying it would mean the review path never
   * runs, because two leads almost never share a creation timestamp. Between a
   * rule that always guesses and a rule that never guesses, this takes the
   * second: the instruction that opens the section is "do NOT blindly attach a
   * conversation when multiple possible active leads exist", and one customer
   * with two live enquiries is exactly when the newest is not obviously the
   * one they are writing about.
   *
   * The candidates go back to the caller newest-first so the review screen can
   * lead with the most likely answer without the system having committed to it.
   */
  return {
    outcome: 'AMBIGUOUS',
    candidates: [...active].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
  };
}
