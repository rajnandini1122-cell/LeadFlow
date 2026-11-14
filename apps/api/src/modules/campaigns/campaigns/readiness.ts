import type {
  CampaignReadiness,
  CampaignReadinessCheck,
  CampaignReadinessIntent,
  EmailDeliveryChannel,
} from '@leadflow/api-types';
import { BROADCAST_MERGE_FIELDS } from '../broadcast/broadcast-state';

/**
 * Whether a campaign can be test-sent or confirmed, as one ordered checklist.
 *
 * Pure and shared: the readiness endpoint renders it for people, and the
 * send guards (testSend, confirm) refuse with the same rules — so a button is
 * enabled exactly when the server would accept the action.
 *
 * Titles are written for business users: no switch names, hosts, keys or
 * allowlist entries. Server logs keep the technical cause.
 */

export interface ReadinessInput {
  intent: CampaignReadinessIntent;
  switches: { dispatch: boolean; sending: boolean; broadcasts: boolean };
  mailbox: {
    enabled: boolean;
    sendingProvider: 'SMTP' | 'RESEND';
    providerTested: boolean;
    smtpTested: boolean;
    fullAccessKey: boolean;
    domainVerified: boolean;
    webhookConnected: boolean;
  } | null;
  campaign: {
    purpose: 'PROMOTIONAL' | 'TRANSACTIONAL';
    subject: string;
    html: string;
    text: string | null;
    attachments: number;
  };
  /** CONFIRM only: the audience as the server would queue it now. */
  audience?: { eligible: number; unapproved: number; tooLarge: boolean };
}

/** How a campaign will be delivered — fixed for good at confirmation. */
export function predictChannel(
  provider: 'SMTP' | 'RESEND',
  purpose: 'PROMOTIONAL' | 'TRANSACTIONAL',
): EmailDeliveryChannel {
  if (provider === 'SMTP') return 'SMTP';
  return purpose === 'PROMOTIONAL' ? 'RESEND_BROADCAST' : 'RESEND_EMAIL';
}

/** What each delivery channel can carry. */
export function providerCapabilities(channel: EmailDeliveryChannel): {
  attachments: boolean;
  personalisedSubject: boolean;
  mergeFields: 'ALL' | 'NAME_ONLY';
} {
  return channel === 'RESEND_BROADCAST'
    ? { attachments: false, personalisedSubject: false, mergeFields: 'NAME_ONLY' }
    : { attachments: true, personalisedSubject: true, mergeFields: 'ALL' };
}

/**
 * Why this content cannot go out as one broadcast, in the order a person
 * would fix it. Empty when it fits. The messages are the ones the confirm
 * guard has always used.
 */
export function broadcastContentProblems(campaign: ReadinessInput['campaign']): string[] {
  const problems: string[] = [];
  if (campaign.attachments > 0) {
    problems.push('Broadcasts cannot carry attachments. Link to the catalogue instead.');
  }
  const used = [
    ...`${campaign.html} ${campaign.text ?? ''}`.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi),
  ].map((m) => m[1]!.toLowerCase());
  const unsupported = [...new Set(used)].filter(
    (f) => !(f in BROADCAST_MERGE_FIELDS) && f !== 'organization' && f !== 'sender_name',
  );
  if (unsupported.length > 0) {
    problems.push(
      `A broadcast can only personalise first name and last name. Remove: ${unsupported.map((f) => `{{${f}}}`).join(', ')}.`,
    );
  }
  if (/\{\{\s*(first_name|last_name|full_name)\s*\}\}/i.test(campaign.subject)) {
    problems.push('A broadcast subject cannot be personalised per recipient.');
  }
  return problems;
}

const SETTINGS = { label: 'Open Email settings', to: '/settings/email' };

export function evaluateReadiness(input: ReadinessInput): CampaignReadiness {
  const checks: CampaignReadinessCheck[] = [];
  const add = (check: CampaignReadinessCheck) => checks.push(check);
  const { intent, switches, mailbox, campaign } = input;

  // 1. Is sending available at all for this organization?
  const platformOn = intent === 'TEST' ? switches.dispatch && switches.sending : switches.sending;
  add({
    id: 'SENDING_AVAILABLE',
    status: platformOn ? 'pass' : 'fail',
    title: platformOn
      ? 'Email sending is available'
      : intent === 'TEST'
        ? 'Test emails are not available on this LeadFlow server yet'
        : 'Sending campaigns is not available on this LeadFlow server yet',
    ...(platformOn
      ? {}
      : {
          detail:
            'Drafts, previews and recipient lists still work. Ask your LeadFlow administrator to enable sending.',
        }),
  });

  // 2. The email account.
  if (!mailbox) {
    add({
      id: 'ACCOUNT_SET_UP',
      status: 'fail',
      title: 'No email account is set up',
      fix: { label: 'Set up the email account', to: SETTINGS.to },
    });
    return finish(intent, null, checks);
  }
  const channel = predictChannel(mailbox.sendingProvider, campaign.purpose);
  const resend = mailbox.sendingProvider === 'RESEND';
  const tested = resend ? mailbox.providerTested : mailbox.smtpTested;
  add({
    id: 'ACCOUNT_TESTED',
    status: tested ? 'pass' : 'fail',
    title: tested
      ? 'The sending account works'
      : resend
        ? 'Test the Resend connection'
        : 'Test the SMTP (sending) connection',
    ...(tested ? {} : { fix: SETTINGS }),
  });
  if (intent === 'CONFIRM') {
    add({
      id: 'ACCOUNT_ON',
      status: mailbox.enabled ? 'pass' : 'fail',
      title: mailbox.enabled
        ? 'The email account is on for campaigns'
        : 'Turn on "Use this account for campaigns"',
      ...(mailbox.enabled ? {} : { fix: SETTINGS }),
    });
  }

  // 3. Promotional email through Resend goes out as one broadcast.
  if (channel === 'RESEND_BROADCAST') {
    if (intent === 'CONFIRM') {
      add({
        id: 'PROMOTIONAL_AVAILABLE',
        status: switches.broadcasts ? 'pass' : 'fail',
        title: switches.broadcasts
          ? 'Promotional sending is available'
          : 'Promotional campaigns are not available on this LeadFlow server yet',
      });
      add({
        id: 'MARKETING_ACCOUNT',
        status: mailbox.fullAccessKey ? 'pass' : 'fail',
        title: mailbox.fullAccessKey
          ? 'The marketing account has full access'
          : 'Promotional email needs a full-access key for the marketing account',
        ...(mailbox.fullAccessKey ? {} : { fix: SETTINGS }),
      });
      add({
        id: 'DOMAIN_VERIFIED',
        status: mailbox.domainVerified ? 'pass' : 'fail',
        title: mailbox.domainVerified
          ? 'The sending domain is verified'
          : 'Verify the sending domain, then test Resend again',
        ...(mailbox.domainVerified ? {} : { fix: SETTINGS }),
      });
      add({
        id: 'UNSUBSCRIBES_CONNECTED',
        status: mailbox.webhookConnected ? 'pass' : 'fail',
        title: mailbox.webhookConnected
          ? 'Unsubscribes, bounces and complaints are reported back'
          : 'Connect the Resend webhook so unsubscribes and bounces reach LeadFlow',
        ...(mailbox.webhookConnected ? {} : { fix: SETTINGS }),
      });
    }
    const problems = broadcastContentProblems(campaign);
    add({
      id: 'MESSAGE_FITS',
      // A test can still go out; the real campaign cannot until it is fixed.
      status: problems.length === 0 ? 'pass' : intent === 'CONFIRM' ? 'fail' : 'warn',
      title:
        problems.length === 0
          ? 'The message fits a promotional broadcast'
          : intent === 'CONFIRM'
            ? 'Change the message before sending'
            : 'The test can be sent, but the real campaign needs changes',
      ...(problems.length
        ? { detail: problems.join(' '), fix: { label: 'Edit the message', to: '#message' } }
        : {}),
    });
  }

  // 4. Who would receive it (confirmation only).
  if (intent === 'CONFIRM' && input.audience) {
    const { eligible, unapproved, tooLarge } = input.audience;
    add({
      id: 'AUDIENCE_ELIGIBLE',
      status: !tooLarge && eligible > 0 ? 'pass' : 'fail',
      title: tooLarge
        ? 'The recipient list is too large — narrow the filters'
        : eligible > 0
          ? `${eligible} ${eligible === 1 ? 'person' : 'people'} can receive it`
          : 'Nobody in the recipient list can receive it yet',
      ...(eligible === 0 && !tooLarge && campaign.purpose === 'PROMOTIONAL'
        ? {
            detail: 'Promotional email only goes to people with recorded marketing eligibility.',
            fix: { label: 'Open Marketing eligibility', to: '/campaigns/eligibility' },
          }
        : {}),
    });
    if (eligible > 0) {
      add({
        id: 'RECIPIENTS_APPROVED',
        status: unapproved === 0 ? 'pass' : 'fail',
        title:
          unapproved === 0
            ? 'Every recipient is approved for sending'
            : `${unapproved} of ${eligible} recipients are not approved for sending on this server`,
        ...(unapproved === 0
          ? {}
          : {
              detail: 'Sending is limited to approved addresses. Ask your LeadFlow administrator.',
            }),
      });
    }
  }

  return finish(intent, channel, checks);
}

function finish(
  intent: CampaignReadinessIntent,
  channel: EmailDeliveryChannel | null,
  checks: CampaignReadinessCheck[],
): CampaignReadiness {
  return { intent, channel, ok: checks.every((c) => c.status !== 'fail'), checks };
}
