import { createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Unsubscribe tokens: 32 bytes, base64url, one per recipient.
 *
 * Only the SHA-256 is stored, so a database copy cannot be used to unsubscribe
 * (or to learn) anyone, and the token reveals nothing — not the address, not the
 * organization, not the campaign.
 *
 * The token itself is DERIVED — HMAC of the recipient id under a key only the
 * server holds — because the dispatcher must put it in the message long after
 * the row was written, possibly after a restart, without it ever being stored.
 */
export function unsubscribeKey(credentialKey: Buffer): Buffer {
  return Buffer.from(
    hkdfSync('sha256', credentialKey, Buffer.alloc(0), 'leadflow-email-unsubscribe-v1', 32),
  );
}

export function deriveUnsubscribeToken(
  key: Buffer,
  recipientId: string,
): { token: string; hash: string } {
  const token = createHmac('sha256', key).update(recipientId, 'utf8').digest('base64url');
  return { token, hash: hashUnsubscribeToken(token) };
}

/** A random token — for fixtures only; production tokens are derived. */
export function createUnsubscribeToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashUnsubscribeToken(token) };
}

export function hashUnsubscribeToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** The shape of a token we issued; anything else is rejected before a lookup. */
export function isWellFormedUnsubscribeToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

/** The page a person opens from the footer link (asks before changing anything). */
export function unsubscribePageUrl(webBaseUrl: string, token: string): string {
  return `${webBaseUrl.replace(/\/$/, '')}/unsubscribe/${token}`;
}

/** The RFC 8058 one-click endpoint mail clients POST to. Same origin as the web app. */
export function unsubscribeOneClickUrl(webBaseUrl: string, token: string): string {
  return `${webBaseUrl.replace(/\/$/, '')}/api/v1/email/unsubscribe/${token}`;
}
