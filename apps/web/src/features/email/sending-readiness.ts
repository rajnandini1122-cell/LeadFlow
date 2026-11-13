import type { MailboxView } from '@leadflow/api-types';

export interface Readiness {
  ok: boolean;
  /** What is still missing, in plain words, in the order to fix it. Empty when ok. */
  reasons: string[];
}

/**
 * Whether the email account can be used, decided the same way the server
 * decides it — so a button is enabled exactly when the server would accept
 * the action, and otherwise says why.
 *
 *   campaigns  "Use this account for campaigns" (MailboxService.setSending):
 *              replies need IMAP; sending needs the SMTP test for SMTP, or the
 *              Resend test with a verified sending domain for Resend.
 *   testSend   the test-email buttons (CampaignsService.testSend): the
 *              platform's two sending switches, and the sending provider's own
 *              test — the Resend test (with a verified domain) for Resend, the
 *              SMTP test for SMTP. SMTP is never required when Resend sends.
 */
export function sendingReadiness(view: MailboxView | undefined): {
  campaigns: Readiness;
  testSend: Readiness;
} {
  if (!view?.configured) {
    const missing = ['Set up the email account in Email settings.'];
    return {
      campaigns: { ok: false, reasons: missing },
      testSend: { ok: false, reasons: missing },
    };
  }

  const provider: string[] = [];
  if (view.sendingProvider === 'RESEND') {
    if (!view.provider?.okAt) provider.push('Test the Resend connection in Email settings.');
    if (!view.resend?.domainVerifiedAt) {
      provider.push('Verify the sending domain in Resend, then test Resend again.');
    }
  } else if (!view.smtp?.okAt) {
    provider.push('Test the SMTP (sending) connection in Email settings.');
  }

  const campaigns = [
    ...(view.imap?.okAt ? [] : ['Test the IMAP (replies) connection in Email settings.']),
    ...provider,
  ];

  const testSend = [
    ...(view.platform?.sendingEnabled && view.platform?.dispatcherEnabled
      ? []
      : ['Test emails are switched off on this server until email sending is enabled.']),
    ...provider,
  ];

  return {
    campaigns: { ok: campaigns.length === 0, reasons: campaigns },
    testSend: { ok: testSend.length === 0, reasons: testSend },
  };
}
