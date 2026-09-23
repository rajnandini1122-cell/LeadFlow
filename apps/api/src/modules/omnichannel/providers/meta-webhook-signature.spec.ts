import { createHmac } from 'node:crypto';
import { verifySubscription, verifyWebhookSignature } from './meta-webhook-signature';

/**
 * Webhook authenticity, for every Meta channel.
 *
 * This is the only thing standing between the public internet and a write into
 * a customer's CRM. Every one of these cases is a way that check could be made
 * to pass when it should not.
 */

const SECRET = 'test-app-secret';
const BODY = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');

function sign(body: Buffer, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('verifyWebhookSignature', () => {
  it('accepts a correctly signed body', () => {
    expect(verifyWebhookSignature(BODY, sign(BODY), SECRET)).toEqual({ valid: true });
  });

  it('rejects a body signed with a different secret', () => {
    const forged = sign(BODY, 'not-the-app-secret');
    expect(verifyWebhookSignature(BODY, forged, SECRET)).toEqual({
      valid: false,
      reason: 'MISMATCH',
    });
  });

  it('rejects a body that was altered after signing', () => {
    const signature = sign(BODY);
    const tampered = Buffer.from('{"object":"whatsapp_business_account","entry":[{}]}');

    expect(verifyWebhookSignature(tampered, signature, SECRET)).toEqual({
      valid: false,
      reason: 'MISMATCH',
    });
  });

  it('rejects a request with no signature header', () => {
    expect(verifyWebhookSignature(BODY, undefined, SECRET)).toEqual({
      valid: false,
      reason: 'MISSING_HEADER',
    });
  });

  it.each(['', 'deadbeef', 'sha1=deadbeef', 'sha256=', 'sha256'])(
    'rejects the malformed header %p',
    (header) => {
      const result = verifyWebhookSignature(BODY, header, SECRET);
      expect(result.valid).toBe(false);
    },
  );

  it('FAILS CLOSED when no app secret is configured', () => {
    // A deployment that forgot the secret must reject everything rather than
    // accept forged webhooks silently.
    expect(verifyWebhookSignature(BODY, sign(BODY), undefined)).toEqual({
      valid: false,
      reason: 'NOT_CONFIGURED',
    });
  });

  it('rejects a signature of the right shape but the wrong length', () => {
    expect(verifyWebhookSignature(BODY, 'sha256=abcd', SECRET)).toEqual({
      valid: false,
      reason: 'MISMATCH',
    });
  });

  it('rejects when the raw body was not captured', () => {
    // Without the exact bytes there is nothing to verify, and verifying a
    // re-serialised body would be a check that proves nothing.
    expect(verifyWebhookSignature(undefined, sign(BODY), SECRET).valid).toBe(false);
  });

  it('is sensitive to byte-level differences a re-serialisation would introduce', () => {
    const original = Buffer.from('{"a":1,"b":2}');
    const reserialised = Buffer.from('{"b":2,"a":1}');

    const signature = sign(original);
    expect(verifyWebhookSignature(original, signature, SECRET).valid).toBe(true);
    expect(verifyWebhookSignature(reserialised, signature, SECRET).valid).toBe(false);
  });
});

describe('verifySubscription', () => {
  it('echoes the challenge for a correct token', () => {
    expect(
      verifySubscription({ mode: 'subscribe', token: 'shared', challenge: '12345' }, 'shared'),
    ).toBe('12345');
  });

  it('refuses a wrong token', () => {
    expect(
      verifySubscription({ mode: 'subscribe', token: 'guessed', challenge: '12345' }, 'shared'),
    ).toBeNull();
  });

  it('refuses a token of a different length', () => {
    expect(
      verifySubscription({ mode: 'subscribe', token: 'sh', challenge: '12345' }, 'shared'),
    ).toBeNull();
  });

  it.each([
    ['wrong mode', { mode: 'unsubscribe', token: 'shared', challenge: '1' }],
    ['no mode', { token: 'shared', challenge: '1' }],
    ['no token', { mode: 'subscribe', challenge: '1' }],
    ['no challenge', { mode: 'subscribe', token: 'shared' }],
  ])('refuses %s', (_label, params) => {
    expect(verifySubscription(params, 'shared')).toBeNull();
  });

  it('FAILS CLOSED when no verify token is configured', () => {
    expect(
      verifySubscription({ mode: 'subscribe', token: 'anything', challenge: '1' }, undefined),
    ).toBeNull();
  });
});
