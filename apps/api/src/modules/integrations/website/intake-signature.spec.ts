import { createHmac } from 'node:crypto';
import {
  REPLAY_WINDOW_SECONDS,
  payloadDigest,
  signingBase,
  verifyIntakeSignature,
} from './intake-signature';

/**
 * Every way a signed request can be wrong.
 *
 * Pure functions, so the failure paths can be exercised exhaustively without a
 * server — which matters more here than almost anywhere else in the codebase:
 * this check is the ONLY thing standing between the open internet and a write
 * into a customer's CRM.
 */

const SECRET = 'a-website-signing-secret-at-least-32-chars';
const NOW = new Date('2026-09-22T12:00:00.000Z');
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1000));

const sign = (body: Buffer, options: { timestamp?: string; eventId?: string; secret?: string } = {}) =>
  `sha256=${createHmac('sha256', options.secret ?? SECRET)
    .update(
      signingBase({
        timestamp: options.timestamp ?? TIMESTAMP,
        eventId: options.eventId ?? 'evt-1',
        rawBody: body,
      }),
    )
    .digest('hex')}`;

const body = Buffer.from(JSON.stringify({ message: 'Please send a quotation.' }));

const verify = (overrides: Partial<Parameters<typeof verifyIntakeSignature>[0]> = {}) =>
  verifyIntakeSignature({
    rawBody: body,
    signatureHeader: sign(body),
    timestampHeader: TIMESTAMP,
    eventId: 'evt-1',
    secret: SECRET,
    now: NOW,
    ...overrides,
  });

describe('verifyIntakeSignature', () => {
  it('accepts a correctly signed request', () => {
    expect(verify()).toEqual({ valid: true });
  });

  it('refuses a request with no signature at all', () => {
    expect(verify({ signatureHeader: undefined })).toEqual({
      valid: false,
      reason: 'MISSING_HEADERS',
    });
  });

  it('refuses a signature that is simply wrong', () => {
    expect(verify({ signatureHeader: `sha256=${'0'.repeat(64)}` })).toEqual({
      valid: false,
      reason: 'MISMATCH',
    });
  });

  it('refuses a signature made with a different secret', () => {
    // The case that matters if a secret is ever rotated or leaked: the old one
    // stops working the moment the new one is configured.
    expect(verify({ signatureHeader: sign(body, { secret: 'a-different-secret-of-sufficient-len' }) })).toEqual({
      valid: false,
      reason: 'MISMATCH',
    });
  });

  it('refuses a valid signature over DIFFERENT bytes', () => {
    /*
     * The body is bound by a digest, so a caller cannot sign one payload and
     * send another. This is the check that stops an intercepted request having
     * its message, phone number or company swapped in flight.
     */
    const tampered = Buffer.from(JSON.stringify({ message: 'Something else entirely.' }));

    expect(verify({ rawBody: tampered })).toEqual({ valid: false, reason: 'MISMATCH' });
  });

  it('refuses a valid signature re-labelled as a different event', () => {
    // The event id is the idempotency key. If it were not signed, a replayed
    // request could be given a fresh id and become a second customer.
    expect(verify({ eventId: 'evt-2' })).toEqual({ valid: false, reason: 'MISMATCH' });
  });

  describe('the replay window', () => {
    it('accepts a request at the edge of the window, either side', () => {
      // Clocks drift in both directions, and refusing a caller whose clock runs
      // fast would be an outage rather than a defence.
      for (const offset of [REPLAY_WINDOW_SECONDS, -REPLAY_WINDOW_SECONDS]) {
        const timestamp = String(Number(TIMESTAMP) + offset);

        expect(
          verify({ timestampHeader: timestamp, signatureHeader: sign(body, { timestamp }) }),
        ).toEqual({ valid: true });
      }
    });

    it('refuses a request from beyond it', () => {
      const timestamp = String(Number(TIMESTAMP) - REPLAY_WINDOW_SECONDS - 1);

      // A captured request must stop working. Without this, one recording of
      // one valid submission is a permanent credential.
      expect(
        verify({ timestampHeader: timestamp, signatureHeader: sign(body, { timestamp }) }),
      ).toEqual({ valid: false, reason: 'STALE_TIMESTAMP' });
    });

    it.each(['', 'yesterday', '-1', '1.5', '2026-09-22T12:00:00Z', '9'.repeat(20)])(
      'refuses the malformed timestamp %p',
      (timestamp) => {
        expect(verify({ timestampHeader: timestamp })).toMatchObject({ valid: false });
      },
    );
  });

  it('refuses everything when no secret is configured', () => {
    // Fail closed. A deployment that enabled the integration and forgot the
    // secret must reject callers, not accept them.
    expect(verify({ secret: undefined })).toEqual({ valid: false, reason: 'NOT_CONFIGURED' });
    expect(verify({ secret: '' })).toEqual({ valid: false, reason: 'NOT_CONFIGURED' });
  });

  it('refuses a request whose raw body was never captured', () => {
    // Without the exact bytes there is nothing to verify, and verifying a
    // re-serialised object would be a check that passes when it should fail.
    expect(verify({ rawBody: undefined })).toEqual({ valid: false, reason: 'MISSING_BODY' });
  });

  it.each(['', 'deadbeef', 'sha1=deadbeef', 'sha256=', 'sha256=not-hex-at-all'])(
    'refuses the malformed signature header %p',
    (header) => {
      expect(verify({ signatureHeader: header })).toMatchObject({ valid: false });
    },
  );
});

describe('payloadDigest', () => {
  it('is stable for identical bytes and different for any change', () => {
    // What distinguishes a retry from a caller reusing an event id for
    // something else, so it has to be exact.
    expect(payloadDigest(Buffer.from('{"a":1}'))).toBe(payloadDigest(Buffer.from('{"a":1}')));
    expect(payloadDigest(Buffer.from('{"a":1}'))).not.toBe(payloadDigest(Buffer.from('{"a":2}')));
    // Byte-for-byte, not semantically: re-ordered keys ARE different bytes,
    // and treating them as the same would mean re-serialising a body we were
    // asked to verify.
    expect(payloadDigest(Buffer.from('{"a":1,"b":2}'))).not.toBe(
      payloadDigest(Buffer.from('{"b":2,"a":1}')),
    );
  });
});
