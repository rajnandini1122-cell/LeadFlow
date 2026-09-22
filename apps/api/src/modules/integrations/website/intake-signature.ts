import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Authenticity for server-to-server intake.
 *
 * Separate from the Meta webhook verifier next door, and deliberately so: Meta
 * decides Meta's scheme and signs the body alone, while this is our own
 * boundary and can bind more. A signature over the body only is replayable
 * forever and says nothing about which submission it belongs to; this one
 * covers the timestamp and the event id as well, so a captured request cannot
 * be re-sent tomorrow, and cannot be re-labelled as a different submission
 * today.
 *
 * What it does NOT do is authorise anything. It proves the caller holds the
 * shared secret. WHICH TENANT the submission lands in comes from configuration
 * — never from the request — because a valid signature on a body naming
 * somebody else's organization is still a valid signature.
 *
 * Pure and dependency-free, so every failure path can be tested without a
 * server, a database or a live website.
 */

/** The bytes that are signed: timestamp, event id, and a digest of the body. */
export function signingBase(input: {
  timestamp: string;
  eventId: string;
  rawBody: Buffer;
}): string {
  const bodyDigest = createHash('sha256').update(input.rawBody).digest('hex');

  // Dot-separated with fixed-shape parts, so no combination of values can be
  // rearranged into a different message that signs identically. The event id
  // is constrained by the caller's own format and the digest is fixed-length
  // hex, which leaves nothing ambiguous to split on.
  return `${input.timestamp}.${input.eventId}.${bodyDigest}`;
}

/** SHA-256 of the exact bytes received, hex. Also stored, to detect reuse. */
export function payloadDigest(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

export type IntakeAuthFailure =
  | 'NOT_CONFIGURED'
  | 'MISSING_HEADERS'
  | 'MALFORMED_SIGNATURE'
  | 'MALFORMED_TIMESTAMP'
  | 'STALE_TIMESTAMP'
  | 'MISSING_BODY'
  | 'MISMATCH';

export type IntakeAuthResult = { valid: true } | { valid: false; reason: IntakeAuthFailure };

/**
 * How far out of step a caller's clock may be.
 *
 * Five minutes each way. Long enough for ordinary drift between two machines
 * nobody synchronises carefully, short enough that a captured request is not a
 * lasting credential. Symmetric because a clock can be fast as easily as slow,
 * and refusing a request from a future-dated caller would be an outage rather
 * than a defence.
 */
export const REPLAY_WINDOW_SECONDS = 300;

export function verifyIntakeSignature(input: {
  rawBody: Buffer | undefined;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  eventId: string | undefined;
  secret: string | undefined;
  /** Injected so the window can be tested without waiting five minutes. */
  now?: Date;
}): IntakeAuthResult {
  // Fail closed. An unconfigured secret rejects everything rather than waving
  // it through: a deployment that forgot it would otherwise accept forged
  // submissions in silence.
  if (!input.secret) return { valid: false, reason: 'NOT_CONFIGURED' };
  if (!input.rawBody) return { valid: false, reason: 'MISSING_BODY' };
  if (!input.signatureHeader || !input.timestampHeader || !input.eventId) {
    return { valid: false, reason: 'MISSING_HEADERS' };
  }

  const [algorithm, provided] = input.signatureHeader.split('=');
  if (algorithm !== 'sha256' || !provided) return { valid: false, reason: 'MALFORMED_SIGNATURE' };

  /*
   * The timestamp is checked BEFORE the HMAC, and that is not a leak: it is
   * caller-supplied and covered by the signature, so a forged one fails the
   * comparison below anyway. Checking it first means a replayed request is
   * refused without spending a hash on it.
   */
  if (!/^\d{1,15}$/.test(input.timestampHeader)) {
    return { valid: false, reason: 'MALFORMED_TIMESTAMP' };
  }

  const sentAt = Number(input.timestampHeader);
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - sentAt) > REPLAY_WINDOW_SECONDS) {
    return { valid: false, reason: 'STALE_TIMESTAMP' };
  }

  const expected = createHmac('sha256', input.secret)
    .update(
      signingBase({
        timestamp: input.timestampHeader,
        eventId: input.eventId,
        rawBody: input.rawBody,
      }),
    )
    .digest('hex');

  // Both buffers must be the same length for timingSafeEqual, and a wrong
  // length is itself a mismatch — testing it first leaks nothing, since the
  // expected length is a constant of the algorithm.
  const providedBuffer = Buffer.from(provided, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (providedBuffer.length !== expectedBuffer.length) return { valid: false, reason: 'MISMATCH' };

  // Constant-time. A comparison that returns on the first wrong byte tells an
  // attacker how much of a guessed signature was right, which is enough to
  // build the rest one byte at a time.
  return timingSafeEqual(providedBuffer, expectedBuffer)
    ? { valid: true }
    : { valid: false, reason: 'MISMATCH' };
}
