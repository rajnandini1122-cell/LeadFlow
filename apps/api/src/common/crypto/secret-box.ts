import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Authenticated encryption for provider credentials at rest.
 *
 * A WhatsApp access token is a bearer credential: whoever holds it can send
 * messages as the business and read its message history. Storing one in a
 * plain column would put it in every database backup, every logical replica,
 * every support export and every screenshot of a psql session — none of which
 * are places a customer's Meta credentials belong.
 *
 * This is deliberately NOT a secret-management platform. The application has no
 * vault and inventing one is out of proportion to a single credential per
 * tenant. What this does provide is the property that actually matters here:
 * possession of the database is not sufficient to use the tokens in it. The key
 * lives in the environment, so a leaked dump is inert without a second,
 * separately-held secret.
 *
 * AES-256-GCM rather than CBC, because GCM authenticates as well as encrypts.
 * Ciphertext that has been altered fails to decrypt instead of quietly
 * producing different plaintext, so a tampered row is an error rather than a
 * request sent with an attacker's token.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits — the size GCM is specified for.
const KEY_BYTES = 32;

export class SecretBoxError extends Error {}

/**
 * Parses the configured key.
 *
 * Throws rather than falling back to a default or a derived key: a wrong key
 * silently used to encrypt is a set of credentials nobody can ever decrypt
 * again, and a default key is no key at all.
 */
export function parseEncryptionKey(base64Key: string | undefined): Buffer {
  if (!base64Key) {
    throw new SecretBoxError(
      'CREDENTIAL_ENCRYPTION_KEY is not set. Provider credentials cannot be stored without it.',
    );
  }

  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new SecretBoxError(
      `CREDENTIAL_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes; got ${key.length}. ` +
        'Generate one with: openssl rand -base64 32',
    );
  }

  return key;
}

/**
 * Encrypts a secret into a single self-describing string.
 *
 * Everything needed to decrypt except the key travels with the ciphertext, so
 * one column holds the whole record and there is no way to store an IV against
 * the wrong ciphertext.
 *
 *   v1.<iv>.<authTag>.<ciphertext>    all base64url
 *
 * The version prefix exists so the algorithm can change later without having to
 * guess what an existing row was encrypted with.
 */
export function sealSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    'v1',
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/** Reverses `sealSecret`. Throws on any tampering or a wrong key. */
export function openSecret(sealed: string, key: Buffer): string {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new SecretBoxError('Malformed sealed secret.');
  }

  const iv = Buffer.from(parts[1] as string, 'base64url');
  const authTag = Buffer.from(parts[2] as string, 'base64url');
  const ciphertext = Buffer.from(parts[3] as string, 'base64url');

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Deliberately opaque. The distinction between "wrong key" and "tampered
    // ciphertext" is useful to an attacker and to nobody else.
    throw new SecretBoxError('Could not decrypt the stored credential.');
  }
}

/**
 * A safe fragment of a credential, for showing which token is configured.
 *
 * Last four characters only, and only ever for a value the caller already had.
 * Enough to answer "is this the token I pasted?" without being enough to use.
 */
export function credentialHint(plaintext: string): string {
  return plaintext.length <= 4 ? '****' : `****${plaintext.slice(-4)}`;
}
