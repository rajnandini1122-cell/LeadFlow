/**
 * Structured call outcomes — the ONE catalogue the API and the web app share.
 *
 * Before this, an outcome was free text picked from a five-item list ("Spoke to
 * customer", "No answer", …) on the COMPLETE dialog. Two things went wrong:
 *
 *   * "No answer" COMPLETED the follow-up. A call nobody answered dropped out
 *     of every queue and counted as work done, which is the opposite of what a
 *     missed call means.
 *   * Nothing downstream could act on free text — no "awaiting response" view,
 *     no "last outcome" on a lead, no way to tell a reached customer from a
 *     missed one.
 *
 * Each outcome now declares how it behaves. The server enforces it; the web app
 * reads the same table to decide which fields to show.
 */

export const CALL_OUTCOMES = [
  'CONNECTED_REQUIREMENT',
  'CONNECTED_NO_REQUIREMENT',
  'CONNECTED_CALL_BACK',
  'NOT_ANSWERED',
  'BUSY',
  'UNREACHABLE',
  'WRONG_NUMBER',
  'SAMPLE_REQUESTED',
  'QUOTATION_REQUESTED',
  'AWAITING_RESPONSE',
  'NOT_INTERESTED',
] as const;

export type CallOutcome = (typeof CALL_OUTCOMES)[number];

/** How the outcome is written to the lead timeline (existing activity types). */
export type OutcomeActivityType = 'CALL_COMPLETED' | 'CALL_NOT_ANSWERED' | 'CALL_BACK_LATER';

export interface CallOutcomeRule {
  label: string;
  /** Whether a person was actually spoken to. Drives "contacted" and NEW → CONTACTED. */
  reached: boolean;
  activityType: OutcomeActivityType;
  /**
   * What happens to the follow-up being worked.
   *
   *   'complete'  the call happened — the follow-up is done (COMPLETED).
   *   'retry'     the work is still owed — the follow-up is superseded by a retry,
   *               never completed. Not reaching someone is an attempt, not an outcome.
   */
  followUp: 'complete' | 'retry';
  /** Suggested time until the next action, in hours. The user can change it. */
  defaultNextInHours: number;
  /** Requirement fields (product, quantity, purchase date) are offered. */
  capturesRequirement: boolean;
  /** "Mark qualified" is offered, and pre-ticked when the lead is earlier in the pipeline. */
  suggestsQualified: boolean;
  /** "Close as lost" is offered as an alternative to scheduling the next action. */
  offersClose: boolean;
  /** Pre-filled lost reason when the user chooses to close. */
  defaultLostReason?: string;
  /** Title for the follow-up this outcome schedules. */
  nextTitle: string;
}

export const CALL_OUTCOME_RULES: Readonly<Record<CallOutcome, CallOutcomeRule>> = {
  CONNECTED_REQUIREMENT: {
    label: 'Connected — requirement available',
    reached: true,
    activityType: 'CALL_COMPLETED',
    followUp: 'complete',
    defaultNextInHours: 48,
    capturesRequirement: true,
    suggestsQualified: true,
    offersClose: false,
    nextTitle: 'Follow up on requirement',
  },
  CONNECTED_NO_REQUIREMENT: {
    label: 'Connected — no current requirement',
    reached: true,
    activityType: 'CALL_COMPLETED',
    followUp: 'complete',
    // A nurture call a month out. Optional in spirit, but an open lead must
    // keep a next action, so the alternative offered is closing it.
    defaultNextInHours: 24 * 30,
    capturesRequirement: false,
    suggestsQualified: false,
    offersClose: true,
    defaultLostReason: 'No current requirement',
    nextTitle: 'Check for a new requirement',
  },
  CONNECTED_CALL_BACK: {
    label: 'Connected — call back later',
    reached: true,
    activityType: 'CALL_BACK_LATER',
    followUp: 'complete',
    defaultNextInHours: 24,
    capturesRequirement: false,
    suggestsQualified: false,
    offersClose: false,
    nextTitle: 'Call back as agreed',
  },
  NOT_ANSWERED: {
    label: 'Not answered',
    reached: false,
    activityType: 'CALL_NOT_ANSWERED',
    followUp: 'retry',
    defaultNextInHours: 2,
    capturesRequirement: false,
    suggestsQualified: false,
    offersClose: false,
    nextTitle: 'Retry call — no answer',
  },
  BUSY: {
    label: 'Busy',
    reached: false,
    activityType: 'CALL_NOT_ANSWERED',
    followUp: 'retry',
    defaultNextInHours: 1,
    capturesRequirement: false,
    suggestsQualified: false,
    offersClose: false,
    nextTitle: 'Retry call — line busy',
  },
  UNREACHABLE: {
    label: 'Switched off / unreachable',
    reached: false,
    activityType: 'CALL_NOT_ANSWERED',
    followUp: 'retry',
    defaultNextInHours: 24,
    capturesRequirement: false,
    suggestsQualified: false,
    offersClose: false,
    nextTitle: 'Retry call — unreachable',
  },
  WRONG_NUMBER: {
    label: 'Wrong number',
    reached: false,
    activityType: 'CALL_NOT_ANSWERED',
    followUp: 'retry',
    defaultNextInHours: 24,
    capturesRequirement: false,
    suggestsQualified: false,
    offersClose: true,
    defaultLostReason: 'Wrong number — no valid contact',
    nextTitle: 'Find a working number',
  },
  SAMPLE_REQUESTED: {
    label: 'Interested — sample requested',
    reached: true,
    activityType: 'CALL_COMPLETED',
    followUp: 'complete',
    defaultNextInHours: 72,
    capturesRequirement: true,
    suggestsQualified: true,
    offersClose: false,
    nextTitle: 'Send sample and confirm receipt',
  },
  QUOTATION_REQUESTED: {
    label: 'Interested — quotation requested',
    reached: true,
    activityType: 'CALL_COMPLETED',
    followUp: 'complete',
    defaultNextInHours: 24,
    capturesRequirement: true,
    suggestsQualified: true,
    offersClose: false,
    nextTitle: 'Send quotation',
  },
  AWAITING_RESPONSE: {
    label: 'Awaiting customer response',
    reached: true,
    activityType: 'CALL_COMPLETED',
    followUp: 'complete',
    defaultNextInHours: 72,
    capturesRequirement: false,
    suggestsQualified: false,
    offersClose: false,
    nextTitle: 'Chase customer response',
  },
  NOT_INTERESTED: {
    label: 'Not interested',
    reached: true,
    activityType: 'CALL_COMPLETED',
    followUp: 'complete',
    defaultNextInHours: 24 * 90,
    capturesRequirement: false,
    suggestsQualified: false,
    offersClose: true,
    defaultLostReason: 'Not interested',
    nextTitle: 'Check back for future interest',
  },
};

/** Outcomes that mean "the customer owes us an answer" — the Awaiting Response view. */
export const AWAITING_RESPONSE_OUTCOMES: readonly CallOutcome[] = ['AWAITING_RESPONSE'];

export function isCallOutcome(value: unknown): value is CallOutcome {
  return typeof value === 'string' && (CALL_OUTCOMES as readonly string[]).includes(value);
}
