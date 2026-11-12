import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Resend webhooks are signed the Svix way: HMAC-SHA256, keyed with the
 * base64 part of the endpoint's `whsec_…` secret, over
 * `${svix-id}.${svix-timestamp}.${raw body}`. The `svix-signature` header holds
 * one or more space-separated `v1,<base64>` values (several during rotation).
 */

/** How far a timestamp may be from now. Older deliveries are replays. */
export const SVIX_TOLERANCE_SECONDS = 5 * 60;

export type SvixResult =
  | { ok: true }
  | { ok: false; reason: 'MISSING' | 'STALE' | 'BAD_SIGNATURE' | 'BAD_SECRET' };

export function verifySvixSignature(input: {
  secret: string;
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: Buffer;
  now?: Date;
}): SvixResult {
  if (!input.id || !input.timestamp || !input.signature) return { ok: false, reason: 'MISSING' };
  const seconds = Number(input.timestamp);
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (!Number.isFinite(seconds) || Math.abs(now - seconds) > SVIX_TOLERANCE_SECONDS)
    return { ok: false, reason: 'STALE' };

  const encoded = input.secret.startsWith('whsec_') ? input.secret.slice(6) : input.secret;
  const key = Buffer.from(encoded, 'base64');
  if (key.length < 16) return { ok: false, reason: 'BAD_SECRET' };

  const expected = createHmac('sha256', key)
    .update(`${input.id}.${input.timestamp}.`)
    .update(input.rawBody)
    .digest();
  for (const part of input.signature.split(' ')) {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) continue;
    const given = Buffer.from(value, 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: 'BAD_SIGNATURE' };
}

/** For tests: the header a sender with this secret would produce. */
export function signSvix(secret: string, id: string, timestamp: string, rawBody: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64')}`;
}
