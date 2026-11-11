/**
 * The broadcast state machine. Each arrow is persisted BEFORE the provider call
 * that follows it, and moved with a conditional update, so a restart resumes
 * at the step it was on and two workers cannot take the same step.
 *
 *   PENDING ──sync contacts──▶ CONTACTS_SYNCED ──segment──▶ SEGMENT_READY
 *     ──precheck + draft──▶ DRAFT_CREATED ──persist──▶ SEND_REQUESTED ──send──▶ HANDED_OFF
 *
 * The one step that can send email is SEND_REQUESTED → HANDED_OFF, and Resend
 * documents no idempotency key for it. So from SEND_REQUESTED the only safe
 * move is to READ the broadcast:
 *
 *   draft                       not sent: the send may be requested again
 *   scheduled | queued | sent   handed off: never request it again
 *   canceled                    CANCELLED_AT_PROVIDER
 *   no answer                   stay in SEND_REQUESTED and read again later
 *
 * A send request that got an explicit error stays in SEND_REQUESTED too, and is
 * resolved the same way: by reading, never by asking again blindly.
 *
 * If the read keeps showing `draft` after the settle period, or the status
 * cannot be read for RETRY_LIMIT_MS, LeadFlow does NOT decide on its own:
 * NEEDS_REVIEW pauses the campaign until a person resolves it (send again,
 * after the live status is read once more, or abandon).
 *
 * NEEDS_REVIEW: any step that cannot complete for RETRY_LIMIT_MS, or an
 * ambiguous send. A person decides; LeadFlow never guesses.
 *
 * BLOCKED: a precheck failed closed (segment membership could not be made
 * exactly the eligible set, an unsubscribe could not be pushed, a contact
 * could not be read). The campaign is paused for a person to look at.
 */
export const BROADCAST_STATES = [
  'PENDING',
  'CONTACTS_SYNCED',
  'SEGMENT_READY',
  'DRAFT_CREATED',
  'SEND_REQUESTED',
  'HANDED_OFF',
  'CANCELLED_AT_PROVIDER',
  'BLOCKED',
  'NEEDS_REVIEW',
] as const;
export type BroadcastState = (typeof BROADCAST_STATES)[number];

/** States after which LeadFlow can no longer stop the email by pausing or cancelling. */
export const HANDED_TO_PROVIDER: readonly BroadcastState[] = ['SEND_REQUESTED', 'HANDED_OFF'];

/** A step that keeps failing for this long is handed to a person (NEEDS_REVIEW). */
export const RETRY_LIMIT_MS = 15 * 60_000;

/** How long after hand-off a recipient with no event is closed as "no report". */
export const NO_REPORT_AFTER_MS = 48 * 3_600_000;

/** Merge fields a broadcast can personalise (Resend contact fields); the rest are refused. */
export const BROADCAST_MERGE_FIELDS: Record<string, string> = {
  first_name: '{{{contact.first_name}}}',
  last_name: '{{{contact.last_name}}}',
  full_name: '{{{contact.first_name}}} {{{contact.last_name}}}',
};

/** Resend's own unsubscribe link placeholder, replaced per contact by Resend. */
export const RESEND_UNSUBSCRIBE_PLACEHOLDER = '{{{RESEND_UNSUBSCRIBE_URL}}}';
