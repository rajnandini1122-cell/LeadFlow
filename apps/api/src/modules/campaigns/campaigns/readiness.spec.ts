import {
  broadcastContentProblems,
  evaluateReadiness,
  predictChannel,
  providerCapabilities,
  type ReadinessInput,
} from './readiness';

const base = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
  intent: 'CONFIRM',
  switches: { dispatch: true, sending: true, broadcasts: true },
  mailbox: {
    enabled: true,
    sendingProvider: 'RESEND',
    providerTested: true,
    smtpTested: false,
    fullAccessKey: true,
    domainVerified: true,
    webhookConnected: true,
  },
  campaign: {
    purpose: 'PROMOTIONAL',
    subject: 'Our catalogue',
    html: '<p>Dear {{first_name}}, from {{sender_name}}</p>',
    text: 'Dear {{first_name}}',
    attachments: 0,
  },
  audience: { eligible: 1, unapproved: 0, tooLarge: false },
  ...over,
});
const failing = (input: ReadinessInput) =>
  evaluateReadiness(input)
    .checks.filter((c) => c.status === 'fail')
    .map((c) => c.id);

describe('campaign readiness', () => {
  it('everything in place: ok, broadcast channel, no failures', () => {
    const r = evaluateReadiness(base());
    expect(r).toMatchObject({ ok: true, channel: 'RESEND_BROADCAST', intent: 'CONFIRM' });
    expect(failing(base())).toEqual([]);
  });

  it('the first real send of 13 Nov: an attachment on a promotional broadcast fails confirmation', () => {
    const input = base({ campaign: { ...base().campaign, attachments: 1 } });
    expect(failing(input)).toEqual(['MESSAGE_FITS']);
    const check = evaluateReadiness(input).checks.find((c) => c.id === 'MESSAGE_FITS')!;
    expect(check.detail).toContain('Broadcasts cannot carry attachments');
    expect(check.fix?.label).toBe('Edit the message');
  });

  it('…but only warns for a test email, which can still go out', () => {
    const r = evaluateReadiness(
      base({ intent: 'TEST', campaign: { ...base().campaign, attachments: 1 } }),
    );
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.id === 'MESSAGE_FITS')!.status).toBe('warn');
  });

  it.each([
    [
      'sending off',
      { switches: { dispatch: true, sending: false, broadcasts: true } },
      'SENDING_AVAILABLE',
    ],
    ['account toggle off', { mailbox: { ...base().mailbox!, enabled: false } }, 'ACCOUNT_ON'],
    [
      'Resend not tested',
      { mailbox: { ...base().mailbox!, providerTested: false } },
      'ACCOUNT_TESTED',
    ],
    [
      'broadcasts off',
      { switches: { dispatch: true, sending: true, broadcasts: false } },
      'PROMOTIONAL_AVAILABLE',
    ],
    [
      'restricted key',
      { mailbox: { ...base().mailbox!, fullAccessKey: false } },
      'MARKETING_ACCOUNT',
    ],
    [
      'domain unverified',
      { mailbox: { ...base().mailbox!, domainVerified: false } },
      'DOMAIN_VERIFIED',
    ],
    [
      'no webhook',
      { mailbox: { ...base().mailbox!, webhookConnected: false } },
      'UNSUBSCRIBES_CONNECTED',
    ],
    [
      'nobody eligible',
      { audience: { eligible: 0, unapproved: 0, tooLarge: false } },
      'AUDIENCE_ELIGIBLE',
    ],
    [
      'too large',
      { audience: { eligible: 0, unapproved: 0, tooLarge: true } },
      'AUDIENCE_ELIGIBLE',
    ],
    [
      'not approved',
      { audience: { eligible: 3, unapproved: 2, tooLarge: false } },
      'RECIPIENTS_APPROVED',
    ],
  ] as const)('%s → fails %s', (_label, over, id) => {
    expect(failing(base(over as Partial<ReadinessInput>))).toEqual([id]);
    expect(evaluateReadiness(base(over as Partial<ReadinessInput>)).ok).toBe(false);
  });

  it('a test needs both switches; the account toggle is not part of a test', () => {
    expect(
      failing(
        base({ intent: 'TEST', switches: { dispatch: false, sending: true, broadcasts: true } }),
      ),
    ).toEqual(['SENDING_AVAILABLE']);
    const t = evaluateReadiness(
      base({ intent: 'TEST', mailbox: { ...base().mailbox!, enabled: false } }),
    );
    expect(t.ok).toBe(true);
    expect(t.checks.map((c) => c.id)).not.toContain('ACCOUNT_ON');
    expect(t.checks.map((c) => c.id)).not.toContain('AUDIENCE_ELIGIBLE');
  });

  it('no email account: one clear failure, no channel', () => {
    const r = evaluateReadiness(base({ mailbox: null }));
    expect(r.channel).toBeNull();
    expect(r.checks.map((c) => c.id)).toEqual(['SENDING_AVAILABLE', 'ACCOUNT_SET_UP']);
  });

  it('a service message through Resend is one email per person: no broadcast checks', () => {
    const r = evaluateReadiness(
      base({
        switches: { dispatch: true, sending: true, broadcasts: false },
        campaign: { ...base().campaign, purpose: 'TRANSACTIONAL', attachments: 2 },
      }),
    );
    expect(r).toMatchObject({ ok: true, channel: 'RESEND_EMAIL' });
  });

  it('SMTP sending needs the SMTP test, never the Resend one', () => {
    const smtp = { ...base().mailbox!, sendingProvider: 'SMTP' as const, providerTested: false };
    expect(
      evaluateReadiness(base({ mailbox: smtp })).checks.find((c) => c.id === 'ACCOUNT_TESTED')!
        .status,
    ).toBe('fail');
    expect(evaluateReadiness(base({ mailbox: { ...smtp, smtpTested: true } })).ok).toBe(true);
  });

  it('never names switches, hosts, keys or approved addresses', () => {
    const everythingOff = base({
      switches: { dispatch: false, sending: false, broadcasts: false },
      mailbox: {
        ...base().mailbox!,
        providerTested: false,
        domainVerified: false,
        fullAccessKey: false,
        webhookConnected: false,
        enabled: false,
      },
      audience: { eligible: 4, unapproved: 4, tooLarge: false },
    });
    const text = JSON.stringify(evaluateReadiness(everythingOff));
    expect(text).not.toMatch(/EMAIL_[A-Z_]+|ALLOWLIST|railway|api key|smtp\.|@/i);
  });
});

describe('channel and capabilities', () => {
  it('predicts the channel the way confirmation fixes it', () => {
    expect(predictChannel('SMTP', 'PROMOTIONAL')).toBe('SMTP');
    expect(predictChannel('RESEND', 'PROMOTIONAL')).toBe('RESEND_BROADCAST');
    expect(predictChannel('RESEND', 'TRANSACTIONAL')).toBe('RESEND_EMAIL');
  });

  it('only a broadcast refuses attachments and per-recipient subjects', () => {
    expect(providerCapabilities('RESEND_BROADCAST')).toEqual({
      attachments: false,
      personalisedSubject: false,
      mergeFields: 'NAME_ONLY',
    });
    expect(providerCapabilities('RESEND_EMAIL').attachments).toBe(true);
    expect(providerCapabilities('SMTP').attachments).toBe(true);
  });

  it('lists every broadcast content problem, in fixing order', () => {
    expect(
      broadcastContentProblems({
        purpose: 'PROMOTIONAL',
        subject: 'Hi {{first_name}}',
        html: '{{company}} {{first_name}} {{organization}}',
        text: null,
        attachments: 1,
      }),
    ).toEqual([
      'Broadcasts cannot carry attachments. Link to the catalogue instead.',
      'A broadcast can only personalise first name and last name. Remove: {{company}}.',
      'A broadcast subject cannot be personalised per recipient.',
    ]);
  });
});
