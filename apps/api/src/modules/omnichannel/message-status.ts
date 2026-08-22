import type { MessageDeliveryStatus } from '../../generated/prisma/enums';

/**
 * How an outbound message's status may change.
 *
 * Status webhooks arrive out of order and more than once. Meta gives no
 * ordering guarantee, so a `delivered` callback routinely lands after the
 * `read` one it precedes — and applying it naively would show a message the
 * customer has already read as merely delivered. A salesperson reading that
 * would follow up on something already answered.
 *
 * So the rule is monotonic: a status only ever moves forward. Duplicates are
 * no-ops, late events are no-ops, and the only exception is failure, which is
 * handled explicitly below.
 */

/** How far along each state is. Higher wins. */
const RANK: Record<MessageDeliveryStatus, number> = {
  PENDING: 0,
  SENT: 1,
  DELIVERED: 2,
  READ: 3,
  // Ranked alongside SENT because failure competes with it, not with delivery.
  // The special case below is what actually decides.
  FAILED: 1,
};

/**
 * The status to store, or null to leave the message alone.
 *
 * @param current what is on the row now. Null for a message with no status,
 *   which should not happen for outbound but is handled rather than assumed.
 */
export function nextDeliveryStatus(
  current: MessageDeliveryStatus | null,
  incoming: MessageDeliveryStatus,
): MessageDeliveryStatus | null {
  if (current === null) return incoming;
  if (current === incoming) return null; // Duplicate delivery. Harmless.

  /*
   * Failure is not simply "further along".
   *
   * A message CAN fail after being accepted — an invalid number surfaces late —
   * so FAILED must be able to overwrite SENT. It must NOT overwrite DELIVERED
   * or READ: the customer demonstrably received those, and marking them failed
   * would tell a salesperson to resend something already read.
   */
  if (incoming === 'FAILED') {
    return current === 'DELIVERED' || current === 'READ' ? null : 'FAILED';
  }

  /*
   * Nothing recovers from failure on its own.
   *
   * A late `sent` callback for a message we already recorded as failed is
   * describing an earlier moment, not a new one. Treating it as progress would
   * quietly clear a failure somebody needs to see.
   */
  if (current === 'FAILED') return null;

  return RANK[incoming] > RANK[current] ? incoming : null;
}

/** Meta's status strings, mapped to ours. Unknown values are ignored. */
export function parseProviderStatus(value: string): MessageDeliveryStatus | null {
  switch (value) {
    case 'sent':
      return 'SENT';
    case 'delivered':
      return 'DELIVERED';
    case 'read':
      return 'READ';
    case 'failed':
      return 'FAILED';
    default:
      // `accepted` and `deleted` exist and mean neither progress nor failure.
      // A status we do not understand must not become one we do.
      return null;
  }
}
