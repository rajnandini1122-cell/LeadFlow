import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Authenticity for the Central Admin control plane.
 *
 * A SEPARATE CONTRACT from the website intake next door, and separate on
 * purpose rather than by neglect. The two boundaries carry different risk and
 * bind different things: a website submission is one enquiry and its signature
 * covers a timestamp, an event id and the body. A control command can rewrite a
 * tenant's routing table, so its signature also covers the METHOD and the PATH
 * — without those, a captured `POST /teams` could be replayed against
 * `POST /territories`, or a `GET` re-aimed at a `DELETE`, and the signature
 * would still verify.
 *
 * Sharing one signing base between them was considered and rejected. J1's
 * contract is already implemented by a deployed website backend; widening it
 * would mean changing bytes that a system outside this repository produces, for
 * the benefit of a system that does not exist yet. The one thing genuinely
 * worth sharing — how long a captured request stays usable — is imported rather
 * than re-decided.
 *
 * What this does NOT do is authorise anything. It proves the caller holds the
 * shared secret. WHICH TENANT a command applies to comes from configuration —
 * never from the request — because a valid signature on a body naming somebody
 * else's organization is still a valid signature.
 *
 * Pure and dependency-free, so every failure path is testable without a server,
 * a database or a live admin console.
 */

import { REPLAY_WINDOW_SECONDS } from '../website/intake-signature';

export { REPLAY_WINDOW_SECONDS };

/** SHA-256 of the exact bytes received, hex. Empty body hashes empty bytes. */
export function bodyDigest(rawBody: Buffer | undefined): string {
  return createHash('sha256')
    .update(rawBody ?? Buffer.alloc(0))
    .digest('hex');
}

/**
 * The bytes that are signed.
 *
 * Newline-separated, with every part of fixed or constrained shape:
 *
 *   METHOD          upper-case, letters only
 *   PATH            the request path, no query string
 *   TIMESTAMP       unix seconds, digits only
 *   REQUEST_ID      the caller's idempotency key
 *   ACTOR_REF       who asked, as their own system names them
 *   BODY_DIGEST     64 hex characters
 *
 * A newline is the delimiter because it is the one character none of the
 * constrained parts may contain — request id and actor reference are both
 * validated to a printable, newline-free shape before they are ever used here.
 * That is what stops two different requests producing the same signing base by
 * moving a delimiter into a value.
 *
 * The QUERY STRING is deliberately not covered, and the path must therefore be
 * the path alone. Filters on a read change nothing, and binding them would make
 * the caller's URL-encoding choices part of the contract — a class of
 * interoperability bug that costs more than it prevents here. Nothing that
 * MUTATES takes its instructions from the query string.
 */
export function adminSigningBase(input: {
  method: string;
  path: string;
  timestamp: string;
  requestId: string;
  actorRef: string;
  rawBody: Buffer | undefined;
}): string {
  return [
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.requestId,
    input.actorRef,
    bodyDigest(input.rawBody),
  ].join('\n');
}

export type AdminAuthFailure =
  | 'NOT_CONFIGURED'
  | 'MISSING_HEADERS'
  | 'MALFORMED_SIGNATURE'
  | 'MALFORMED_TIMESTAMP'
  | 'MALFORMED_REQUEST_ID'
  | 'MALFORMED_ACTOR'
  | 'STALE_TIMESTAMP'
  | 'MISMATCH';

export type AdminAuthResult = { valid: true } | { valid: false; reason: AdminAuthFailure };

/**
 * The shape a request id and an actor reference must take.
 *
 * Printable ASCII without whitespace or control characters. Two reasons, and
 * the first is structural: a newline in either would let a caller forge a
 * signing base by moving the delimiter. The second is that both are stored and
 * shown to operators, and a value carrying control characters is a value that
 * will eventually be pasted somewhere it does something.
 */
const SAFE_TOKEN = /^[\x21-\x7e]{1,120}$/;
const SAFE_ACTOR = /^[\x21-\x7e]{1,200}$/;

export function isSafeRequestId(value: string | undefined): value is string {
  return typeof value === 'string' && SAFE_TOKEN.test(value);
}

export function isSafeActorRef(value: string | undefined): value is string {
  return typeof value === 'string' && SAFE_ACTOR.test(value);
}

export function verifyAdminSignature(input: {
  method: string;
  path: string;
  rawBody: Buffer | undefined;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  requestId: string | undefined;
  actorRef: string | undefined;
  secret: string | undefined;
  /** Injected so the window can be tested without waiting five minutes. */
  now?: Date;
}): AdminAuthResult {
  // Fail closed. An unconfigured secret rejects everything rather than waving
  // it through: a deployment that forgot it would otherwise accept forged
  // commands in silence.
  if (!input.secret) return { valid: false, reason: 'NOT_CONFIGURED' };

  if (!input.signatureHeader || !input.timestampHeader) {
    return { valid: false, reason: 'MISSING_HEADERS' };
  }
  if (!input.requestId) return { valid: false, reason: 'MISSING_HEADERS' };
  if (!input.actorRef) return { valid: false, reason: 'MISSING_HEADERS' };

  if (!isSafeRequestId(input.requestId)) return { valid: false, reason: 'MALFORMED_REQUEST_ID' };
  if (!isSafeActorRef(input.actorRef)) return { valid: false, reason: 'MALFORMED_ACTOR' };

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
      adminSigningBase({
        method: input.method,
        path: input.path,
        timestamp: input.timestampHeader,
        requestId: input.requestId,
        actorRef: input.actorRef,
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
