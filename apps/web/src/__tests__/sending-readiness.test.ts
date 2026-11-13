import { describe, expect, it } from 'vitest';
import type { MailboxView } from '@leadflow/api-types';

import { sendingReadiness } from '../features/email/sending-readiness';

/**
 * One rule for "can this account be used" and "can I send myself a test",
 * matching the server. In particular: a Resend account never needs SMTP
 * (Railway blocks outbound SMTP, so that test times out).
 */

const OK = '2026-11-12T13:25:28.000Z';

const view = (over: Partial<MailboxView> = {}): MailboxView =>
  ({
    configured: true,
    sendingProvider: 'RESEND',
    smtp: { checkedAt: OK, okAt: null, error: 'The connection timed out.' },
    imap: { checkedAt: OK, okAt: OK, error: null },
    provider: { checkedAt: OK, okAt: OK, error: null },
    resend: {
      apiKeySet: true,
      apiKeyHint: null,
      webhookSecretSet: true,
      webhookUrl: null,
      domainVerifiedAt: OK,
      lastWebhookAt: null,
    },
    platform: { sendingEnabled: true, dispatcherEnabled: true },
    ...over,
  }) as MailboxView;

const SWITCHES_OFF = 'Test emails are switched off on this server until email sending is enabled.';

describe('sendingReadiness — Resend', () => {
  it('Resend tested + domain verified + switches on: ready, even though SMTP times out', () => {
    const r = sendingReadiness(view());
    expect(r.testSend).toEqual({ ok: true, reasons: [] });
    expect(r.campaigns).toEqual({ ok: true, reasons: [] });
  });

  it('switches off: test sends unavailable for that reason only; the account itself is ready', () => {
    const r = sendingReadiness(
      view({ platform: { sendingEnabled: false, dispatcherEnabled: false } }),
    );
    expect(r.testSend).toEqual({ ok: false, reasons: [SWITCHES_OFF] });
    expect(r.campaigns.ok).toBe(true);
  });

  it.each([
    [{ sendingEnabled: true, dispatcherEnabled: false }],
    [{ sendingEnabled: false, dispatcherEnabled: true }],
  ])('needs BOTH switches: %j → unavailable', (platform) => {
    expect(sendingReadiness(view({ platform })).testSend.reasons).toEqual([SWITCHES_OFF]);
  });

  it('Resend test not passed: unavailable, says to test Resend (not SMTP)', () => {
    const r = sendingReadiness(view({ provider: { checkedAt: OK, okAt: null, error: 'bad key' } }));
    expect(r.testSend.reasons).toEqual(['Test the Resend connection in Email settings.']);
    expect(r.testSend.reasons.join(' ')).not.toMatch(/SMTP/);
  });

  it('sending domain not verified: unavailable for tests and campaigns', () => {
    const r = sendingReadiness(
      view({
        resend: {
          apiKeySet: true,
          apiKeyHint: null,
          webhookSecretSet: true,
          webhookUrl: null,
          domainVerifiedAt: null,
          lastWebhookAt: null,
        },
      }),
    );
    const reason = 'Verify the sending domain in Resend, then test Resend again.';
    expect(r.testSend).toEqual({ ok: false, reasons: [reason] });
    expect(r.campaigns).toEqual({ ok: false, reasons: [reason] });
  });

  it('IMAP is needed for using the account in campaigns, not for a test email', () => {
    const r = sendingReadiness(
      view({ imap: { checkedAt: OK, okAt: null, error: 'login failed' } }),
    );
    expect(r.testSend.ok).toBe(true);
    expect(r.campaigns.reasons).toEqual(['Test the IMAP (replies) connection in Email settings.']);
  });

  it('several gaps are all listed, switches first', () => {
    const r = sendingReadiness(
      view({
        platform: { sendingEnabled: false, dispatcherEnabled: false },
        provider: { checkedAt: null, okAt: null, error: null },
      }),
    );
    expect(r.testSend.reasons).toEqual([
      SWITCHES_OFF,
      'Test the Resend connection in Email settings.',
    ]);
  });
});

describe('sendingReadiness — SMTP', () => {
  const smtp = (smtpOk: boolean) =>
    view({
      sendingProvider: 'SMTP',
      smtp: { checkedAt: OK, okAt: smtpOk ? OK : null, error: null },
      provider: { checkedAt: null, okAt: null, error: null },
    });

  it('SMTP tested: ready (Resend state is irrelevant)', () => {
    expect(sendingReadiness(smtp(true)).testSend).toEqual({ ok: true, reasons: [] });
  });

  it('SMTP not tested: unavailable, says to test SMTP', () => {
    expect(sendingReadiness(smtp(false)).testSend.reasons).toEqual([
      'Test the SMTP (sending) connection in Email settings.',
    ]);
  });
});

describe('sendingReadiness — no account', () => {
  it.each([[undefined], [{ configured: false } as MailboxView]])('%j → set up first', (v) => {
    const r = sendingReadiness(v);
    expect(r.testSend).toEqual({
      ok: false,
      reasons: ['Set up the email account in Email settings.'],
    });
    expect(r.campaigns.ok).toBe(false);
  });
});

describe('sendingReadiness — incomplete data never crashes the page', () => {
  it('a Resend account object without the resend block is treated as not ready', () => {
    const partial = { ...view(), resend: undefined } as unknown as MailboxView;
    expect(() => sendingReadiness(partial)).not.toThrow();
    expect(sendingReadiness(partial).testSend.ok).toBe(false);
  });
});
