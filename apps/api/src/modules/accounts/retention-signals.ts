/**
 * Why a salesperson should contact a customer today.
 *
 * Pure functions, no database — so the rules that put a customer in front of a
 * human are readable in one place rather than inferred from a query.
 *
 * The governing rule is that a signal is an OBSERVATION, never an instruction
 * and never an action. Nothing here creates an opportunity, schedules a
 * follow-up, sends a message or changes a status. It says "this customer bought
 * garlic powder three times and the last was 35 days ago", and a person decides
 * whether that means anything. A CRM that acts on its own guesses fills the
 * pipeline with work nobody asked for, and the salesperson learns to ignore it.
 */

export type SignalKind =
  /** A scheduled action is due or overdue. Uses the existing follow-up system. */
  | 'FOLLOW_UP_DUE'
  /** Bought this before, and enough time has passed to ask again. */
  | 'REPEAT_CANDIDATE'
  /** A customer with an active enquiry. Shown so nobody double-works it. */
  | 'OPEN_OPPORTUNITY'
  /** Quiet for longer than the tenant's configured threshold. */
  | 'DORMANT'
  /** Buys one thing, has never asked about another. */
  | 'EXPANSION_CANDIDATE';

export interface RetentionSignal {
  kind: SignalKind;
  /** Sort key. Higher comes first in the queue. */
  priority: number;
  /** What to tell the salesperson. Always states the evidence. */
  reason: string;
}

/**
 * Ordering, and the reasoning behind it.
 *
 * A promise already made outranks an opportunity we spotted: a follow-up the
 * customer is expecting is a commitment, and missing it costs more than a
 * missed cross-sell. Dormancy sits above repeat because a customer going quiet
 * is a problem, whereas a repeat candidate is merely an opportunity. Expansion
 * is last: it is the most speculative thing here.
 */
const PRIORITY: Record<SignalKind, number> = {
  FOLLOW_UP_DUE: 100,
  DORMANT: 80,
  REPEAT_CANDIDATE: 60,
  OPEN_OPPORTUNITY: 40,
  EXPANSION_CANDIDATE: 20,
};

/**
 * How long after a purchase it is reasonable to ask again.
 *
 * A default, not a truth. Nobody knows the reorder cycle of every product a
 * tenant sells, and pretending to would put customers in front of a
 * salesperson at the wrong moment. Thirty days is a starting point that a
 * tenant setting can later replace; until then the signal states the elapsed
 * time so the human can judge it.
 */
export const DEFAULT_REPEAT_AFTER_DAYS = 30;

export interface AccountSignalInput {
  status: string;
  /** Won opportunities to date. More than one is what makes a repeat customer. */
  wonCount: number;
  lastWonAt: Date | null;
  lastActivityAt: Date | null;
  openOpportunities: number;
  /** Open follow-ups already scheduled, and the soonest of them. */
  openFollowUps: number;
  nextFollowUpAt: Date | null;
  /** Active catalogue products this customer has never enquired about. */
  neverEnquiredProducts: number;
  /** The product they have bought most, for the repeat suggestion. */
  topProductName: string | null;
  dormantAfterDays: number;
  repeatAfterDays: number;
  now: Date;
}

export function daysSince(date: Date | null, now: Date): number | null {
  if (!date) return null;
  return Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Every reason to contact this customer, strongest first.
 *
 * Returns an empty array when there is nothing to say. That matters: a queue
 * that always finds a reason is a queue nobody trusts, and "no action needed"
 * is a legitimate and useful answer.
 */
export function signalsFor(input: AccountSignalInput): RetentionSignal[] {
  const signals: RetentionSignal[] = [];

  /*
   * A promise already made. Only DUE or OVERDUE — a follow-up scheduled for
   * next week is not a reason to act today, and listing it would bury the ones
   * that are.
   */
  const followUpDays = daysSince(input.nextFollowUpAt, input.now);
  if (input.openFollowUps > 0 && followUpDays !== null && followUpDays >= 0) {
    signals.push({
      kind: 'FOLLOW_UP_DUE',
      priority: PRIORITY.FOLLOW_UP_DUE,
      reason:
        followUpDays === 0
          ? 'A follow-up is due today.'
          : `A follow-up is ${followUpDays} day${followUpDays === 1 ? '' : 's'} overdue.`,
    });
  }

  /*
   * Gone quiet. Only for an existing CUSTOMER: a prospect nobody has worked is
   * a different problem needing a different action, and an account with no
   * recorded activity at all has never been active rather than having gone
   * quiet.
   */
  const quietDays = daysSince(input.lastActivityAt, input.now);
  if (
    input.status === 'CUSTOMER' &&
    quietDays !== null &&
    quietDays >= input.dormantAfterDays
  ) {
    signals.push({
      kind: 'DORMANT',
      priority: PRIORITY.DORMANT,
      reason: `No recorded activity for ${quietDays} days.`,
    });
  }

  /*
   * Bought before, and enough time has passed to ask again.
   *
   * Suppressed while they already have an open enquiry: suggesting they might
   * want to buy something they are actively discussing is noise, and it is how
   * a rep ends up creating a second opportunity for a deal already in progress.
   */
  const sinceLastWon = daysSince(input.lastWonAt, input.now);
  if (
    input.wonCount > 0 &&
    sinceLastWon !== null &&
    sinceLastWon >= input.repeatAfterDays &&
    input.openOpportunities === 0
  ) {
    signals.push({
      kind: 'REPEAT_CANDIDATE',
      priority: PRIORITY.REPEAT_CANDIDATE,
      reason: input.topProductName
        ? `Bought ${input.topProductName} ${input.wonCount} time${
            input.wonCount === 1 ? '' : 's'
          }. Last business ${sinceLastWon} days ago.`
        : `Last business ${sinceLastWon} days ago.`,
    });
  }

  /*
   * Already being worked. Not a reason to act, but a reason NOT to start
   * something separate — which is why it appears in the queue rather than
   * being filtered out of it.
   */
  if (input.openOpportunities > 0) {
    signals.push({
      kind: 'OPEN_OPPORTUNITY',
      priority: PRIORITY.OPEN_OPPORTUNITY,
      reason: `${input.openOpportunities} open opportunit${
        input.openOpportunities === 1 ? 'y' : 'ies'
      } already in progress.`,
    });
  }

  /*
   * Buys one thing, has never asked about another.
   *
   * Only for customers who have actually bought — a prospect has no buying
   * pattern to expand from, and "they have never enquired about anything" is
   * not a cross-sell insight.
   */
  if (input.wonCount > 0 && input.neverEnquiredProducts > 0) {
    signals.push({
      kind: 'EXPANSION_CANDIDATE',
      priority: PRIORITY.EXPANSION_CANDIDATE,
      reason: `Never enquired about ${input.neverEnquiredProducts} product${
        input.neverEnquiredProducts === 1 ? '' : 's'
      } you sell.`,
    });
  }

  return signals.sort((a, b) => b.priority - a.priority);
}

/**
 * Classifies a new opportunity against the customer's history.
 *
 * Called once, at creation. The result is stored, because it is a fact about
 * the moment the enquiry was captured — correcting an old deal months later
 * must not silently turn last quarter's acquisition into retention.
 *
 * Returns null when there is no account: unknown is a different answer from
 * FIRST, and recording it as first business would invent an acquisition.
 */
export function classifyOpportunity(input: {
  accountId: string | null;
  /** Won opportunities this account already had. */
  accountWonCount: number;
  /** Whether THIS product has been won for this account before. */
  productWonBefore: boolean;
}): 'FIRST' | 'REPEAT_PRODUCT' | 'EXPANSION' | null {
  if (!input.accountId) return null;

  // Nothing bought yet: this is the relationship starting, whatever else is
  // true about it.
  if (input.accountWonCount === 0) return 'FIRST';

  return input.productWonBefore ? 'REPEAT_PRODUCT' : 'EXPANSION';
}

/**
 * A queue entry's headline signal.
 *
 * One customer can carry several reasons; the queue shows the strongest as the
 * label and keeps the rest as detail, so the list stays readable without
 * throwing anything away.
 */
export function headlineSignal(signals: RetentionSignal[]): RetentionSignal | null {
  return signals[0] ?? null;
}
