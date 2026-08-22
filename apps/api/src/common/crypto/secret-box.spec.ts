import { randomBytes } from 'node:crypto';
import {
  credentialHint,
  openSecret,
  parseEncryptionKey,
  sealSecret,
  SecretBoxError,
} from './secret-box';

/**
 * Credential encryption at rest.
 *
 * The property being tested is narrow and worth stating plainly: possession of
 * the database is not enough to use the tokens in it. These cases check that
 * holds, and that failure is loud rather than silent — a credential that
 * decrypts to the wrong thing would be far worse than one that will not
 * decrypt at all.
 */

const KEY = randomBytes(32);
const KEY_B64 = KEY.toString('base64');
const TOKEN = 'EAAG1ZC0example0PERMANENT0TOKEN0abcdef';

describe('parseEncryptionKey', () => {
  it('accepts a 32-byte base64 key', () => {
    expect(parseEncryptionKey(KEY_B64)).toHaveLength(32);
  });

  it('refuses a missing key rather than inventing one', () => {
    // A default key is no key at all.
    expect(() => parseEncryptionKey(undefined)).toThrow(SecretBoxError);
  });

  it.each([
    ['too short', randomBytes(16).toString('base64')],
    ['too long', randomBytes(64).toString('base64')],
    ['not base64', 'definitely not base64 !!!'],
  ])('refuses a key that is %s', (_label, value) => {
    expect(() => parseEncryptionKey(value)).toThrow(SecretBoxError);
  });
});

describe('sealSecret / openSecret', () => {
  it('round-trips a token', () => {
    expect(openSecret(sealSecret(TOKEN, KEY), KEY)).toBe(TOKEN);
  });

  it('never contains the plaintext', () => {
    const sealed = sealSecret(TOKEN, KEY);

    expect(sealed).not.toContain(TOKEN);
    expect(sealed).not.toContain(TOKEN.slice(0, 12));
  });

  it('produces different ciphertext each time', () => {
    // A fresh IV per encryption. Identical output for identical input would
    // leak that two tenants configured the same token.
    expect(sealSecret(TOKEN, KEY)).not.toBe(sealSecret(TOKEN, KEY));
  });

  it('refuses a different key', () => {
    const sealed = sealSecret(TOKEN, KEY);
    expect(() => openSecret(sealed, randomBytes(32))).toThrow(SecretBoxError);
  });

  it('refuses tampered ciphertext instead of returning something else', () => {
    // The reason for GCM over CBC: altered ciphertext fails to decrypt rather
    // than quietly producing different plaintext, so a modified row is an
    // error and not a request sent with an attacker's token.
    const sealed = sealSecret(TOKEN, KEY);
    const parts = sealed.split('.');
    const corrupted = [parts[0], parts[1], parts[2], `${parts[3]}AA`].join('.');

    expect(() => openSecret(corrupted, KEY)).toThrow(SecretBoxError);
  });

  it('refuses a swapped authentication tag', () => {
    const a = sealSecret(TOKEN, KEY).split('.');
    const b = sealSecret('another-token', KEY).split('.');
    const frankenstein = [a[0], a[1], b[2], a[3]].join('.');

    expect(() => openSecret(frankenstein, KEY)).toThrow(SecretBoxError);
  });

  it.each(['', 'v1', 'v1.a.b', 'v2.a.b.c', 'garbage'])('refuses the malformed value %p', (value) => {
    expect(() => openSecret(value, KEY)).toThrow(SecretBoxError);
  });

  it('handles a long token', () => {
    const long = 'E'.repeat(900);
    expect(openSecret(sealSecret(long, KEY), KEY)).toBe(long);
  });
});

describe('credentialHint', () => {
  it('shows only the last four characters', () => {
    expect(credentialHint(TOKEN)).toBe('****cdef');
  });

  it('reveals nothing at all for a short value', () => {
    expect(credentialHint('abc')).toBe('****');
  });
});
