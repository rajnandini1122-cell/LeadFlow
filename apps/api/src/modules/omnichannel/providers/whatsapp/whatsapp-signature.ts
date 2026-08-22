import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta webhook authenticity.
 *
 * Every webhook POST carries `X-Hub-Signature-256: sha256=<hex>`, an HMAC-SHA256
 * of the RAW request body keyed on the Meta app secret. Until that check
 * passes, nothing in the payload means anything: the phone number id, the
 * business account id and the message contents are all attacker-controlled
 * strings, and treating any of them as identifying a tenant before verifying
 * the signature is how a forged request writes into someone else's CRM.
 *
 * Pure and dependency-free so the failure cases can be tested exhaustively
 * without a server, a database or a live Meta app.
 */

export type SignatureResult =
  | { valid: true }
  | { valid: false; reason: 'MISSING_HEADER' | 'MALFORMED_HEADER' | 'MISMATCH' | 'NOT_CONFIGURED' };

/**
 * @param rawBody the exact bytes received. NOT a re-serialised object — key
 *   order, unicode escaping and whitespace all change the HMAC, so verifying a
 *   re-encoded body is a check that passes when it should fail and fails when
 *   it should pass.
 */
export function verifyWebhookSignature(
  rawBody: Buffer | undefined,
  header: string | undefined,
  appSecret: string | undefined,
): SignatureResult {
  // Fail closed. An unconfigured secret must reject every request rather than
  // wave them through — a deployment that forgot the secret would otherwise
  // accept forged webhooks silently.
  if (!appSecret) return { valid: false, reason: 'NOT_CONFIGURED' };
  if (!rawBody) return { valid: false, reason: 'MISSING_HEADER' };
  if (!header) return { valid: false, reason: 'MISSING_HEADER' };

  const [algorithm, provided] = header.split('=');
  if (algorithm !== 'sha256' || !provided) return { valid: false, reason: 'MALFORMED_HEADER' };

  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');

  // Both buffers must be the same length for timingSafeEqual, and a wrong
  // length is itself a mismatch — checking it first is not a leak, since the
  // expected length is a constant of the algorithm.
  const providedBuffer = Buffer.from(provided, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (providedBuffer.length !== expectedBuffer.length) return { valid: false, reason: 'MISMATCH' };

  // Constant-time: a byte-by-byte comparison that returns early leaks how much
  // of a guessed signature was right, which is enough to forge one.
  return timingSafeEqual(providedBuffer, expectedBuffer)
    ? { valid: true }
    : { valid: false, reason: 'MISMATCH' };
}

/**
 * The subscription handshake Meta performs when a webhook URL is saved.
 *
 * Returns the challenge to echo, or null. Null must become a 403 — returning
 * the challenge regardless would let anyone confirm the endpoint is a live
 * webhook and, worse, would let a third party point their own Meta app at it.
 */
export function verifySubscription(
  params: { mode?: string | undefined; token?: string | undefined; challenge?: string | undefined },
  verifyToken: string | undefined,
): string | null {
  if (!verifyToken) return null;
  if (params.mode !== 'subscribe') return null;
  if (!params.token || !params.challenge) return null;

  const provided = Buffer.from(params.token);
  const expected = Buffer.from(verifyToken);
  if (provided.length !== expected.length) return null;

  return timingSafeEqual(provided, expected) ? params.challenge : null;
}
