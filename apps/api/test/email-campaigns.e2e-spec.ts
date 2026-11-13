// Must be first: the config module reads the environment on import.
import { restoreEmailCampaignsEnv } from './helpers/email-campaigns-env';
import { randomUUID } from 'node:crypto';
import { createTestContext, type TestContext } from './helpers/test-app';
import { fixtureMobile } from './helpers/phone-fixtures';
import {
  generateTestCertificate,
  startFakeImap,
  startFakeSmtp,
  TEST_MAIL_HOST,
  type FakeImap,
  type FakeSmtp,
  type TestCertificate,
} from './helpers/fake-mail-servers';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { MailboxService } from '../src/modules/campaigns/mailbox/mailbox.service';
import { EmailDispatcher } from '../src/modules/campaigns/dispatch/email-dispatcher.service';
import { DispatchRepository } from '../src/modules/campaigns/dispatch/dispatch.repository';
import { CampaignsRepository } from '../src/modules/campaigns/campaigns/campaigns.repository';
import { AppConfig } from '../src/common/config/config.module';

/**
 * Campaigns, end to end, against a real SMTP server over TLS.
 *
 *   one message per recipient, with its own Message-ID and unsubscribe header,
 *   and an envelope naming exactly that one recipient;
 *   nothing is sent without the explicit confirmation, and a double click
 *   confirms once;
 *   eligibility is checked again at send time — an unsubscribe in between wins;
 *   4xx is retried with backoff, 5xx is not, and a lost answer after the body
 *   is UNCERTAIN and never resent;
 *   a worker that dies mid-send leaves UNCERTAIN, not a duplicate;
 *   every email — sent or not — is in the lead's history with the server's answer;
 *   another organization can neither see nor send a campaign.
 */
describe('Email campaigns: compose, confirm, deliver', () => {
  let ctx: TestContext;
  let tls: TestCertificate;
  let smtp: FakeSmtp;
  let imap: FakeImap;
  const PASSWORD = 'Mailbox-Secret-2026!';
  const SENDER = 'sales@leadflow-test.example';

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const owner = () => auth(ctx.orgA.owner.accessToken);
  const prisma = () => ctx.app.get(PrismaService).client;
  const asSystem = <T>(run: () => Promise<T>) =>
    ctx.app.get(TenantContextService).runAsSystem('e2e', run);
  const dispatcher = () => ctx.app.get(EmailDispatcher);
  const tag = () => `T${Date.now()}${Math.floor(Math.random() * 1e6)}`;

  /** A lead in a city unique to the test, so each test's audience is its own. */
  const lead = async (
    city: string,
    email: string,
    firstName = 'Asha',
    extra: Record<string, unknown> = {},
  ) => {
    const res = await ctx
      .http()
      .post('/api/v1/leads')
      .set(owner())
      .send({
        firstName,
        lastName: 'Rao',
        mobile: fixtureMobile(),
        email,
        companyName: 'Rao Traders',
        city,
        source: 'Website',
        priority: 'MEDIUM',
        nextFollowUpAt: new Date(Date.now() + 86_400_000).toISOString(),
        ...extra,
      });
    expect({ status: res.status, error: res.body.error }).toMatchObject({ status: 201 });
    return res.body.data.id as string;
  };
  const grant = async (emails: string[]) => {
    const res = await ctx
      .http()
      .post('/api/v1/email/eligibility/grant')
      .set(owner())
      .send({ emails, basis: 'CONSENT', note: 'Signed up for offers' });
    expect(res.status).toBe(200);
  };
  const draft = async (city: string, over: Record<string, unknown> = {}) => {
    const res = await ctx
      .http()
      .post('/api/v1/email/campaigns')
      .set(owner())
      .send({
        name: `Offer ${city}`,
        category: 'PROMOTIONAL_OFFER',
        purpose: 'PROMOTIONAL',
        subject: 'Hello {{first_name}}',
        html: '<p>Dear {{full_name}}, our new catalogue is out.</p>',
        filter: { cities: [city] },
        ...over,
      });
    expect({ status: res.status, error: res.body.error }).toMatchObject({ status: 201 });
    return res.body.data.id as string;
  };
  const audience = async (city: string, purpose = 'PROMOTIONAL') =>
    (
      await ctx
        .http()
        .post('/api/v1/email/campaigns/audience')
        .set(owner())
        .send({ purpose, filter: { cities: [city] } })
    ).body.data;
  const confirm = (id: string, eligibleCount: number, submitKey = randomUUID().replace(/-/g, '')) =>
    ctx
      .http()
      .post(`/api/v1/email/campaigns/${id}/confirm`)
      .set(owner())
      .send({ submitKey, eligibleCount });
  const recipients = (campaignId: string) =>
    asSystem(() =>
      prisma().emailCampaignRecipient.findMany({
        where: { campaignId },
        orderBy: { email: 'asc' },
      }),
    );
  const activities = (leadId: string) =>
    asSystem(() =>
      prisma().leadActivity.findMany({
        where: { leadId, activityType: { in: ['EMAIL_SENT', 'EMAIL_FAILED'] } },
        orderBy: { createdAt: 'asc' },
      }),
    );

  beforeAll(async () => {
    ctx = await createTestContext();
    tls = generateTestCertificate();
    smtp = await startFakeSmtp(tls, { user: SENDER, pass: PASSWORD });
    imap = await startFakeImap(tls, { user: SENDER, pass: PASSWORD });
    ctx.app.get(MailboxService).useConnectionDeps({
      resolveHost: async () => '127.0.0.1',
      testPorts: { smtp: smtp.port, imap: imap.port },
      testCa: tls.cert,
    });

    const saved = await ctx.http().put('/api/v1/email/mailbox').set(owner()).send({
      emailAddress: SENDER,
      imapHost: TEST_MAIL_HOST,
      imapPort: 993,
      imapSecurity: 'SSL_TLS',
      smtpHost: TEST_MAIL_HOST,
      smtpPort: 465,
      smtpSecurity: 'SSL_TLS',
      password: PASSWORD,
    });
    expect(saved.status).toBe(200);
    expect(
      (await ctx.http().post('/api/v1/email/mailbox/test/smtp').set(owner())).body.data.ok,
    ).toBe(true);
    expect(
      (await ctx.http().post('/api/v1/email/mailbox/test/imap').set(owner())).body.data.ok,
    ).toBe(true);
    expect(
      (
        await ctx
          .http()
          .patch('/api/v1/email/mailbox/sending')
          .set(owner())
          .send({ enabled: true, hourlyLimit: 1000, dailyLimit: 10000 })
      ).status,
    ).toBe(200);
  });

  beforeEach(() => {
    smtp.reset();
    // Per-route rate limits are real here; each test starts with a fresh allowance.
    ctx.redis.flush();
  });

  // Nothing one test queued may be delivered during another test's tick.
  afterEach(async () => {
    await asSystem(async () => {
      await prisma().emailCampaignRecipient.updateMany({
        where: { organizationId: ctx.orgA.id, status: { in: ['QUEUED', 'SENDING'] } },
        data: { status: 'CANCELLED', lockedBy: null, lockedUntil: null },
      });
      await prisma().emailCampaign.updateMany({
        where: { organizationId: ctx.orgA.id, status: { in: ['SCHEDULED', 'SENDING', 'PAUSED'] } },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
    });
  });

  /** Headers as one logical line each (RFC 5322 folding undone). */
  const unfold = (raw: string) => raw.replace(/\r?\n[ \t]+/g, ' ');

  afterAll(async () => {
    await smtp?.close();
    await imap?.close();
    await ctx?.close();
    restoreEmailCampaignsEnv();
  });

  it('a promotional audience excludes everyone without recorded eligibility, suppressed addresses and duplicates', async () => {
    const city = tag();
    const a = `a.${city}@cust.example`.toLowerCase();
    const b = `b.${city}@cust.example`.toLowerCase();
    const c = `c.${city}@cust.example`.toLowerCase();
    await lead(city, a);
    await lead(city, b);
    await lead(city, c);
    await lead(city, a.toUpperCase(), 'Asha', { allowDuplicate: true }); // the same person twice
    expect(await audience(city)).toMatchObject({
      selected: 4,
      eligible: 0,
      excluded: { NO_CONSENT: 4 },
    });

    await grant([a, b, c]);
    await ctx
      .http()
      .post('/api/v1/email/suppressions')
      .set(owner())
      .send({ emails: [c], note: 'Asked by phone' });
    expect(await audience(city)).toMatchObject({
      selected: 4,
      eligible: 2,
      excluded: { SUPPRESSED: 1, DUPLICATE: 1, NO_CONSENT: 0 },
    });
    // A service message does not need marketing consent — but suppression still applies.
    expect(await audience(city, 'TRANSACTIONAL')).toMatchObject({
      eligible: 2,
      excluded: { SUPPRESSED: 1 },
    });
  });

  it('delivers one message per recipient, with its own Message-ID, unsubscribe headers and a one-address envelope; each lead gets a history entry with the server answer', async () => {
    const city = tag();
    const emails = [`x.${city}@cust.example`, `y.${city}@cust.example`].map((e) => e.toLowerCase());
    const leadIds = [
      await lead(city, emails[0]!, 'Xavier'),
      await lead(city, emails[1]!, 'Yamini'),
    ];
    await grant(emails);
    const id = await draft(city);

    // Nothing leaves before the confirmation.
    await dispatcher().tick();
    expect(smtp.messages).toHaveLength(0);

    const confirmed = await confirm(id, 2);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data).toMatchObject({
      status: 'SENDING',
      counts: { eligible: 2, queued: 2 },
    });

    const report = await dispatcher().tick();
    expect(report.accepted).toBe(2);
    expect(smtp.messages).toHaveLength(2);

    const rows = await recipients(id);
    for (const sent of smtp.messages) {
      const mail = { ...sent, raw: unfold(sent.raw) };
      expect(mail.to).toHaveLength(1);
      expect(mail.from).toBe(SENDER);
      const row = rows.find((r) => r.email === mail.to[0])!;
      expect(mail.raw).toContain(`Message-ID: ${row.messageId}`);
      expect(mail.raw).toMatch(
        /List-Unsubscribe: <https?:\/\/[^>]+\/api\/v1\/email\/unsubscribe\/[A-Za-z0-9_-]{43}>/,
      );
      expect(mail.raw).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
      expect(mail.raw).toContain(`Reply-To: ${SENDER}`);
      expect(mail.raw).not.toMatch(/^Bcc:/m);
    }
    expect(smtp.messages.map((m) => m.raw).join()).toContain('Hello Xavier');
    expect(rows.every((r) => r.status === 'ACCEPTED' && r.attempts === 1)).toBe(true);

    const history = await activities(leadIds[0]!);
    expect(history).toEqual([
      expect.objectContaining({
        activityType: 'EMAIL_SENT',
        description: expect.stringContaining(
          'accepted by the mail server (not proof of inbox delivery)',
        ),
        metadata: expect.objectContaining({
          campaignId: id,
          email: emails[0],
          smtpCode: 250,
          serverResponse: expect.stringContaining('250'),
        }),
      }),
    ]);

    await dispatcher().tick();
    const view = (await ctx.http().get(`/api/v1/email/campaigns/${id}`).set(owner())).body.data;
    expect(view).toMatchObject({
      status: 'COMPLETED',
      counts: { accepted: 2, attempted: 2, failed: 0, queued: 0 },
    });
    expect(smtp.messages).toHaveLength(2); // a later tick sends nothing again
  });

  it('a double click confirms once: same key replays, a second key is refused, recipients are written once', async () => {
    const city = tag();
    const email = `d.${city}@cust.example`.toLowerCase();
    await lead(city, email);
    await grant([email]);
    const id = await draft(city);
    const key = randomUUID().replace(/-/g, '');
    const [first, second] = await Promise.all([confirm(id, 1, key), confirm(id, 1, key)]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect((await confirm(id, 1)).status).toBe(409);
    expect(await recipients(id)).toHaveLength(1);
  });

  it('refuses a confirmation whose count no longer matches the audience', async () => {
    const city = tag();
    const email = `e.${city}@cust.example`.toLowerCase();
    await lead(city, email);
    await grant([email]);
    const id = await draft(city);
    const res = await confirm(id, 5);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('audience changed');
    expect(await recipients(id)).toHaveLength(0);
  });

  it('an unsubscribe between confirmation and sending wins: the message is skipped, not sent', async () => {
    const city = tag();
    const email = `u.${city}@cust.example`.toLowerCase();
    await lead(city, email);
    await grant([email]);
    const id = await draft(city);
    expect((await confirm(id, 1)).status).toBe(200);
    await ctx
      .http()
      .post('/api/v1/email/eligibility/withdraw')
      .set(owner())
      .send({ emails: [email] });
    const report = await dispatcher().tick();
    expect(report.skipped).toBe(1);
    expect(smtp.messages).toHaveLength(0);
    expect((await recipients(id))[0]).toMatchObject({
      status: 'SKIPPED',
      skipReason: 'NO_CONSENT',
      attempts: 0,
    });
  });

  it('4xx is retried later with backoff; then accepted', async () => {
    const city = tag();
    const email = `t.${city}@cust.example`.toLowerCase();
    await lead(city, email);
    await grant([email]);
    const id = await draft(city);
    expect((await confirm(id, 1)).status).toBe(200);
    smtp.onRcpt = () => ({ code: 451, message: '4.7.1 Greylisted, try again later' });
    const first = await dispatcher().tick();
    expect(first.retried).toBe(1);
    let [row] = await recipients(id);
    expect(row).toMatchObject({ status: 'QUEUED', attempts: 1, lastSmtpCode: 451 });
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 30_000);

    // Not due yet: nothing happens.
    await dispatcher().tick();
    expect((await recipients(id))[0]!.attempts).toBe(1);

    smtp.onRcpt = () => 'accept';
    await asSystem(() =>
      prisma().emailCampaignRecipient.update({
        where: { id: row!.id },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      }),
    );
    expect((await dispatcher().tick()).accepted).toBe(1);
    [row] = await recipients(id);
    expect(row).toMatchObject({ status: 'ACCEPTED', attempts: 2 });
    const attempts = await asSystem(() =>
      prisma().emailDeliveryAttempt.findMany({
        where: { recipientId: row!.id },
        orderBy: { attempt: 'asc' },
      }),
    );
    expect(attempts.map((a) => a.outcome)).toEqual(['TEMPORARY_FAILURE', 'ACCEPTED']);
  });

  it('5xx is permanent: not retried, the unknown address is suppressed as bounced, and the lead history says so', async () => {
    const city = tag();
    const email = `p.${city}@cust.example`.toLowerCase();
    const leadId = await lead(city, email);
    await grant([email]);
    const id = await draft(city);
    expect((await confirm(id, 1)).status).toBe(200);
    smtp.onRcpt = () => ({ code: 550, message: '5.1.1 No such user here' });
    expect((await dispatcher().tick()).failed).toBe(1);
    expect((await recipients(id))[0]).toMatchObject({ status: 'FAILED', lastSmtpCode: 550 });
    expect(
      await asSystem(() => prisma().emailSuppression.findFirst({ where: { email } })),
    ).toMatchObject({ reason: 'BOUNCED' });
    expect(await activities(leadId)).toEqual([
      expect.objectContaining({
        activityType: 'EMAIL_FAILED',
        description: expect.stringContaining('rejected by the mail server'),
        metadata: expect.objectContaining({ smtpCode: 550 }),
      }),
    ]);
    smtp.onRcpt = () => 'accept';
    await dispatcher().tick();
    expect(smtp.messages).toHaveLength(0);
  });

  it('a connection lost after the message body is UNCERTAIN and never sent again', async () => {
    const city = tag();
    const email = `q.${city}@cust.example`.toLowerCase();
    const leadId = await lead(city, email);
    await grant([email]);
    const id = await draft(city);
    expect((await confirm(id, 1)).status).toBe(200);
    smtp.onData = () => 'drop-connection';
    expect((await dispatcher().tick()).uncertain).toBe(1);
    smtp.onData = () => 'accept';
    await dispatcher().tick();
    await dispatcher().tick();
    expect(smtp.messages).toHaveLength(0);
    expect((await recipients(id))[0]).toMatchObject({ status: 'UNCERTAIN', attempts: 1 });
    expect((await activities(leadId))[0]).toMatchObject({
      activityType: 'EMAIL_FAILED',
      description: expect.stringContaining('delivery is unknown'),
    });
  });

  it('a worker that died mid-send (expired lease) is recovered as UNCERTAIN, not resent', async () => {
    const city = tag();
    const email = `r.${city}@cust.example`.toLowerCase();
    const leadId = await lead(city, email);
    await grant([email]);
    const id = await draft(city);
    expect((await confirm(id, 1)).status).toBe(200);
    const [row] = await recipients(id);
    await asSystem(async () => {
      await prisma().emailCampaignRecipient.update({
        where: { id: row!.id },
        data: {
          status: 'SENDING',
          attempts: 1,
          lockedBy: 'dead-worker',
          lockedUntil: new Date(Date.now() - 1000),
        },
      });
      await prisma().emailDeliveryAttempt.create({
        data: {
          organizationId: ctx.orgA.id,
          recipientId: row!.id,
          campaignId: id,
          attempt: 1,
          worker: 'dead-worker',
        },
      });
    });
    expect((await dispatcher().tick()).recovered).toBe(1);
    expect(smtp.messages).toHaveLength(0);
    expect((await recipients(id))[0]).toMatchObject({ status: 'UNCERTAIN' });
    expect((await activities(leadId))[0]).toMatchObject({ activityType: 'EMAIL_FAILED' });
  });

  it('two workers claiming at once never take the same recipient', async () => {
    const city = tag();
    const emails = Array.from({ length: 6 }, (_, i) => `w${i}.${city}@cust.example`.toLowerCase());
    for (const email of emails) await lead(city, email);
    await grant(emails);
    const id = await draft(city);
    expect((await confirm(id, 6)).status).toBe(200);
    const repo = ctx.app.get(DispatchRepository);
    const tenant = ctx.app.get(TenantContextService);
    const until = new Date(Date.now() + 60_000);
    const [one, two] = await Promise.all([
      tenant.runForOrganization(ctx.orgA.id, 'e2e', () => repo.claim(4, 'worker-1', until)),
      tenant.runForOrganization(ctx.orgA.id, 'e2e', () => repo.claim(4, 'worker-2', until)),
    ]);
    // Each claim stays within its own limit, however many rows are due.
    expect(one.length).toBeLessThanOrEqual(4);
    expect(two.length).toBeLessThanOrEqual(4);
    const ids = [...one, ...two].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(6);
    // Put them back so later suites are unaffected.
    await asSystem(() =>
      prisma().emailCampaignRecipient.updateMany({
        where: { campaignId: id },
        data: { status: 'CANCELLED', lockedBy: null, lockedUntil: null },
      }),
    );
  });

  it('pause stops sending, resume continues, cancel drops what is still queued', async () => {
    const city = tag();
    const emails = [`m1.${city}@cust.example`, `m2.${city}@cust.example`].map((e) =>
      e.toLowerCase(),
    );
    for (const email of emails) await lead(city, email);
    await grant(emails);
    const id = await draft(city);
    expect((await confirm(id, 2)).status).toBe(200);
    expect(
      (await ctx.http().post(`/api/v1/email/campaigns/${id}/pause`).set(owner())).body.data.status,
    ).toBe('PAUSED');
    await dispatcher().tick();
    expect(smtp.messages).toHaveLength(0);
    expect(
      (await ctx.http().post(`/api/v1/email/campaigns/${id}/resume`).set(owner())).body.data.status,
    ).toBe('SENDING');
    expect(
      (await ctx.http().post(`/api/v1/email/campaigns/${id}/cancel`).set(owner())).body.data,
    ).toMatchObject({ status: 'CANCELLED', counts: { cancelled: 2, queued: 0 } });
    await dispatcher().tick();
    expect(smtp.messages).toHaveLength(0);
  });

  it('respects the mailbox hourly limit', async () => {
    const city = tag();
    const emails = Array.from({ length: 4 }, (_, i) => `h${i}.${city}@cust.example`.toLowerCase());
    for (const email of emails) await lead(city, email);
    await grant(emails);
    const id = await draft(city);
    expect((await confirm(id, 4)).status).toBe(200);
    const sentThisHour = await asSystem(() =>
      prisma().emailDeliveryAttempt.count({
        where: {
          organizationId: ctx.orgA.id,
          startedAt: { gte: new Date(Date.now() - 3_600_000) },
        },
      }),
    );
    await ctx
      .http()
      .patch('/api/v1/email/mailbox/sending')
      .set(owner())
      .send({ hourlyLimit: sentThisHour + 2 });
    expect((await dispatcher().tick()).accepted).toBe(2);
    expect((await dispatcher().tick()).accepted).toBe(0);
    await ctx
      .http()
      .patch('/api/v1/email/mailbox/sending')
      .set(owner())
      .send({ hourlyLimit: 1000 });
    expect((await dispatcher().tick()).accepted).toBe(2);
  });

  it('a refused sign-in pauses the campaign and keeps everyone queued', async () => {
    const city = tag();
    const email = `s.${city}@cust.example`.toLowerCase();
    await lead(city, email);
    await grant([email]);
    const id = await draft(city);
    expect((await confirm(id, 1)).status).toBe(200);
    // The password changes at the provider without anyone telling LeadFlow.
    await asSystem(async () => {
      const box = await prisma().emailMailbox.findFirst({ where: { organizationId: ctx.orgA.id } });
      const service = ctx.app.get(MailboxService);
      const { sealSecret, parseEncryptionKey } = await import('../src/common/crypto/secret-box');
      await prisma().emailMailbox.update({
        where: { id: box!.id },
        data: {
          encryptedPassword: sealSecret(
            'stale-password',
            parseEncryptionKey(process.env['CREDENTIAL_ENCRYPTION_KEY']),
          ),
        },
      });
      void service;
    });
    const report = await dispatcher().tick();
    expect(report.paused).toBeGreaterThanOrEqual(1);
    const view = (await ctx.http().get(`/api/v1/email/campaigns/${id}`).set(owner())).body.data;
    expect(view).toMatchObject({ status: 'PAUSED', counts: { queued: 1 } });
    expect(view.pauseReason).toContain('refused the email account');
    expect((await recipients(id))[0]).toMatchObject({ status: 'QUEUED', attempts: 0 });
    // Restore the right password for the remaining tests.
    await ctx.http().put('/api/v1/email/mailbox').set(owner()).send({
      emailAddress: SENDER,
      imapHost: TEST_MAIL_HOST,
      imapPort: 993,
      imapSecurity: 'SSL_TLS',
      smtpHost: TEST_MAIL_HOST,
      smtpPort: 465,
      smtpSecurity: 'SSL_TLS',
      password: PASSWORD,
    });
    await ctx.http().post('/api/v1/email/mailbox/test/smtp').set(owner());
    await ctx.http().post('/api/v1/email/mailbox/test/imap').set(owner());
    await ctx.http().patch('/api/v1/email/mailbox/sending').set(owner()).send({ enabled: true });
    await ctx.http().post(`/api/v1/email/campaigns/${id}/cancel`).set(owner());
  });

  /**
   * Runs `fn` with the two email switches as given. The suite boots with the
   * dispatcher switch off (so its timer never starts); only what the service
   * reads per request is changed here. `undefined` stands for "not set".
   */
  const withSwitches = async <T>(
    dispatch: boolean | undefined,
    sending: boolean | undefined,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const config = ctx.app.get(AppConfig);
    const real = config.get.bind(config);
    const spy = jest
      .spyOn(config, 'get')
      .mockImplementation(((key: string) =>
        key === 'EMAIL_DISPATCH_ENABLED'
          ? dispatch
          : key === 'EMAIL_CAMPAIGNS_SENDING_ENABLED'
            ? sending
            : real(key as never)) as typeof config.get);
    try {
      return await fn();
    } finally {
      spy.mockRestore();
    }
  };
  const testSend = (id: string, as = owner()) => {
    ctx.redis.flush(); // the route allows 5 a minute; these tests are about the switches
    return ctx.http().post(`/api/v1/email/campaigns/${id}/test`).set(as).send({});
  };

  it('without `to`, a test email goes to the signed-in user (both switches on)', async () => {
    const city = tag();
    const id = await draft(city);
    smtp.reset();
    const res = await withSwitches(true, true, () => testSend(id));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ sentTo: ctx.orgA.owner.email, accepted: true });
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]!.to).toEqual([ctx.orgA.owner.email.toLowerCase()]);
    expect(smtp.messages[0]!.raw).toContain('[TEST]');
  });

  it.each([
    ['dispatch off, sending off', false, false],
    ['dispatch on, sending off', true, false],
    ['dispatch off, sending on', false, true],
    ['both unset', undefined, undefined],
    ['dispatch unset, sending on', undefined, true],
    ['dispatch on, sending unset', true, undefined],
  ])(
    'test emails are refused with %s — before any SMTP connection',
    async (_label, dispatch, sending) => {
      const id = await draft(tag());
      smtp.reset();
      const res = await withSwitches(dispatch, sending, () => testSend(id));
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Test emails are switched off');
      expect(smtp.connections).toBe(0);
      expect(smtp.logins).toBe(0);
      expect(smtp.messages).toHaveLength(0);
      const audited = await asSystem(() =>
        prisma().auditLog.count({ where: { entityId: id, action: 'email.campaign.test_sent' } }),
      );
      expect(audited).toBe(0);
    },
  );

  it('with both switches on, test sends still require the permission and stay inside the organization', async () => {
    const id = await draft(tag());
    smtp.reset();
    await withSwitches(true, true, async () => {
      expect((await testSend(id, auth(ctx.orgA.rep.accessToken))).status).toBe(403);
      expect((await testSend(id, auth(ctx.orgB.owner.accessToken))).status).toBe(404);
      expect((await ctx.http().post(`/api/v1/email/campaigns/${id}/test`).send({})).status).toBe(
        401,
      );
    });
    expect(smtp.connections).toBe(0);
    expect(smtp.messages).toHaveLength(0);
  });

  describe('test email to another approved address', () => {
    const APPROVED = 'approved.tester@inbox.example';

    /**
     * The switches and the recipient restriction as given; anything left out
     * keeps the suite's own value. This suite boots with
     * EMAIL_SENDING_UNRESTRICTED=true, so each test states it explicitly.
     */
    const withConfig = async <T>(values: Record<string, unknown>, fn: () => Promise<T>) => {
      const config = ctx.app.get(AppConfig);
      const real = config.get.bind(config);
      const spy = jest
        .spyOn(config, 'get')
        .mockImplementation(((key: string) =>
          key in values ? values[key] : real(key as never)) as typeof config.get);
      try {
        return await fn();
      } finally {
        spy.mockRestore();
      }
    };
    const restricted = (over: Record<string, unknown> = {}) => ({
      EMAIL_DISPATCH_ENABLED: true,
      EMAIL_CAMPAIGNS_SENDING_ENABLED: true,
      EMAIL_SENDING_UNRESTRICTED: false,
      EMAIL_ALLOWED_ORGANIZATION_ID: ctx.orgA.id,
      EMAIL_RECIPIENT_ALLOWLIST: APPROVED,
      ...over,
    });
    const sendTo = (id: string, to: unknown, as = owner()) =>
      ctx.http().post(`/api/v1/email/campaigns/${id}/test`).set(as).send({ to });
    const audits = (id: string, action: string) =>
      asSystem(() =>
        prisma().auditLog.findMany({
          where: { entityId: id, action },
          orderBy: { createdAt: 'asc' },
        }),
      );
    const SENT = 'email.campaign.test_sent';
    const REFUSED = 'email.campaign.test_recipient_refused';

    it('an exactly approved address receives it; the audit names actor, organization, recipient and type', async () => {
      const id = await draft(tag());
      const res = await withConfig(restricted(), () =>
        sendTo(id, ' Approved.Tester@INBOX.example '),
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ sentTo: APPROVED, accepted: true });
      expect(smtp.messages).toHaveLength(1);
      expect(smtp.messages[0]!.to).toEqual([APPROVED]);
      expect(smtp.messages[0]!.raw).toContain('[TEST]');
      const [row] = await audits(id, SENT);
      expect(row).toMatchObject({
        organizationId: ctx.orgA.id,
        actorUserId: ctx.orgA.owner.id,
        after: {
          accepted: true,
          recipient: APPROVED,
          recipientType: 'APPROVED_ADDRESS',
          providerMessageId: null,
        },
      });
    });

    it('backward compatible: no `to`, an empty `to` or your own address is a self test', async () => {
      for (const to of [undefined, '', '   ', ctx.orgA.owner.email.toUpperCase()]) {
        const id = await draft(tag());
        smtp.reset();
        ctx.redis.flush();
        const res = await withConfig(
          restricted({ EMAIL_RECIPIENT_ALLOWLIST: `${ctx.orgA.owner.email},${APPROVED}` }),
          () => sendTo(id, to),
        );
        expect(res.status).toBe(200);
        expect(res.body.data.sentTo).toBe(ctx.orgA.owner.email);
        expect(smtp.messages[0]!.to).toEqual([ctx.orgA.owner.email.toLowerCase()]);
        expect((await audits(id, SENT))[0]!.after).toMatchObject({ recipientType: 'SELF' });
      }
    });

    // Overrides of `restricted()`, applied inside each test (ctx exists only then).
    it.each<[string, Record<string, unknown>, string]>([
      ['an address not on the allowlist', {}, 'stranger@elsewhere.example'],
      ['a near miss of an approved address', {}, 'approved.tester@inbox.example.evil'],
      [
        'an approved address, but the restriction names another organization',
        { EMAIL_ALLOWED_ORGANIZATION_ID: '01a0d17f-0000-7000-8000-000000000000' },
        APPROVED,
      ],
      ['no allowlist at all', { EMAIL_RECIPIENT_ALLOWLIST: undefined }, APPROVED],
      [
        'EMAIL_SENDING_UNRESTRICTED=true with the address not listed',
        { EMAIL_SENDING_UNRESTRICTED: true },
        'stranger@elsewhere.example',
      ],
      [
        'EMAIL_SENDING_UNRESTRICTED=true with no allowlist',
        {
          EMAIL_SENDING_UNRESTRICTED: true,
          EMAIL_RECIPIENT_ALLOWLIST: undefined,
          EMAIL_ALLOWED_ORGANIZATION_ID: undefined,
        },
        'stranger@elsewhere.example',
      ],
    ])(
      'is refused explicitly for %s — nothing sent, never redirected, refusal audited',
      async (_label, over, to) => {
        const id = await draft(tag());
        const res = await withConfig(restricted(over), () => sendTo(id, to));
        expect(res.status).toBe(400);
        const message = String(res.body.error.message);
        const attempted = String(to).trim().toLowerCase();
        // It names the address that was tried, and says what to do instead…
        expect(message).toContain(`${attempted} is not approved for test emails`);
        expect(message).toContain('send the test to yourself');
        // …but never the approved list or the organization restriction.
        expect(message.replace(attempted, '')).not.toContain(APPROVED);
        expect(message).not.toContain(ctx.orgA.id);
        expect(message).not.toContain('01a0d17f-0000-7000-8000-000000000000');
        expect(smtp.connections).toBe(0);
        expect(smtp.messages).toHaveLength(0);
        expect(await audits(id, SENT)).toHaveLength(0);
        const refused = await audits(id, REFUSED);
        expect(refused).toHaveLength(1);
        expect(refused[0]).toMatchObject({
          organizationId: ctx.orgA.id,
          actorUserId: ctx.orgA.owner.id,
          after: { recipient: String(to).trim().toLowerCase(), reason: 'NOT_APPROVED' },
        });
      },
    );

    it('a self test refused by the allowlist names your address and points to the approved-address option', async () => {
      const id = await draft(tag());
      const res = await withConfig(restricted(), () => sendTo(id, undefined));
      expect(res.status).toBe(400);
      const message = String(res.body.error.message);
      expect(message).toContain(`Your address (${ctx.orgA.owner.email}) is not approved`);
      expect(message).toContain('enter it under "Test email"');
      expect(message).not.toContain(APPROVED);
      expect(message).not.toContain(ctx.orgA.id);
      expect(smtp.connections).toBe(0);
      expect(await audits(id, SENT)).toHaveLength(0);
    });

    it('a suppressed approved address is refused and audited as SUPPRESSED', async () => {
      const id = await draft(tag());
      const suppressed = `sup.${tag()}@inbox.example`.toLowerCase();
      const added = await ctx
        .http()
        .post('/api/v1/email/suppressions')
        .set(owner())
        .send({ emails: [suppressed], note: 'Asked to stop' });
      expect(added.status).toBe(200);
      const res = await withConfig(restricted({ EMAIL_RECIPIENT_ALLOWLIST: suppressed }), () =>
        sendTo(id, suppressed),
      );
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain(`${suppressed} is suppressed`);
      expect(smtp.messages).toHaveLength(0);
      expect((await audits(id, REFUSED))[0]!.after).toEqual({
        recipient: suppressed,
        reason: 'SUPPRESSED',
      });
    });

    it.each([
      ['dispatch off', { EMAIL_DISPATCH_ENABLED: false }],
      ['sending off', { EMAIL_CAMPAIGNS_SENDING_ENABLED: false }],
      [
        'both unset',
        { EMAIL_DISPATCH_ENABLED: undefined, EMAIL_CAMPAIGNS_SENDING_ENABLED: undefined },
      ],
    ])('an approved address is still refused with %s — before anything else', async (_l, over) => {
      const id = await draft(tag());
      const res = await withConfig(restricted(over), () => sendTo(id, APPROVED));
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Test emails are switched off');
      expect(smtp.connections).toBe(0);
      expect(await audits(id, SENT)).toHaveLength(0);
      expect(await audits(id, REFUSED)).toHaveLength(0);
    });

    it('needs the campaign permission and stays inside the organization', async () => {
      const id = await draft(tag());
      await withConfig(restricted(), async () => {
        expect((await sendTo(id, APPROVED, auth(ctx.orgA.rep.accessToken))).status).toBe(403);
        ctx.redis.flush();
        expect((await sendTo(id, APPROVED, auth(ctx.orgB.owner.accessToken))).status).toBe(404);
        expect(
          (await ctx.http().post(`/api/v1/email/campaigns/${id}/test`).send({ to: APPROVED }))
            .status,
        ).toBe(401);
      });
      expect(smtp.connections).toBe(0);
      expect(await audits(id, SENT)).toHaveLength(0);
      expect(await audits(id, REFUSED)).toHaveLength(0);
    });

    it.each([
      ['not an email', 'not-an-email'],
      ['two addresses', `${APPROVED},other@inbox.example`],
      ['a header injection', `${APPROVED}\r\nBcc: other@inbox.example`],
      ['longer than 254 characters', `${'a'.repeat(250)}@x.example`],
      ['not a string', ['a@x.example']],
    ])('rejects %s as invalid input — nothing sent', async (_label, to) => {
      const id = await draft(tag());
      const res = await withConfig(restricted(), () => sendTo(id, to));
      expect(res.status).toBe(400);
      expect(smtp.connections).toBe(0);
      expect(await audits(id, SENT)).toHaveLength(0);
    });

    it('the daily cap of 20 test emails applies to approved addresses too', async () => {
      const id = await draft(tag());
      const spy = jest
        .spyOn(ctx.app.get(CampaignsRepository), 'testSendsToday')
        .mockResolvedValue(20);
      try {
        const res = await withConfig(restricted(), () => sendTo(id, APPROVED));
        expect(res.status).toBe(400);
        expect(res.body.error.message).toContain('At most 20 test emails per day');
        expect(smtp.connections).toBe(0);
        expect(await audits(id, SENT)).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });

    it('the route allows 5 test requests a minute, whatever the recipient', async () => {
      const id = await draft(tag());
      const statuses = await withConfig(restricted({ EMAIL_DISPATCH_ENABLED: false }), async () => {
        const out: number[] = [];
        for (let i = 0; i < 6; i++) out.push((await sendTo(id, APPROVED)).status);
        return out;
      });
      expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);
      expect(smtp.connections).toBe(0);
    });
  });

  it('another organization can neither see nor send it; a sales rep cannot send', async () => {
    const id = await draft(tag());
    const other = auth(ctx.orgB.owner.accessToken);
    expect((await ctx.http().get(`/api/v1/email/campaigns/${id}`).set(other)).status).toBe(404);
    expect(
      (
        await ctx
          .http()
          .post(`/api/v1/email/campaigns/${id}/confirm`)
          .set(other)
          .send({ submitKey: 'k'.repeat(20), eligibleCount: 1 })
      ).status,
    ).toBe(404);
    expect(
      (
        await ctx
          .http()
          .post(`/api/v1/email/campaigns/${id}/confirm`)
          .set(auth(ctx.orgA.rep.accessToken))
          .send({ submitKey: 'k'.repeat(20), eligibleCount: 1 })
      ).status,
    ).toBe(403);
  });

  describe('recipient checklist and filters', () => {
    const preview = async (filter: Record<string, unknown>, purpose = 'PROMOTIONAL') => {
      ctx.redis.flush();
      const res = await ctx
        .http()
        .post('/api/v1/email/campaigns/audience')
        .set(owner())
        .send({ purpose, filter });
      expect(res.status).toBe(200);
      return res.body.data;
    };

    it('an address unticked in the list is left out of the count, the confirmation and the queue', async () => {
      const city = tag();
      const emails = ['k0', 'k1', 'k2'].map((p) => `${p}.${city}@cust.example`.toLowerCase());
      for (const e of emails) await lead(city, e);
      await grant(emails);
      const all = await preview({ cities: [city] });
      expect(all).toMatchObject({ eligible: 3, recipientsTruncated: false });
      expect(all.recipients.map((r: { email: string }) => r.email)).toEqual([...emails].sort());

      const some = await preview({ cities: [city], excludeEmails: [emails[1]!.toUpperCase()] });
      expect(some.eligible).toBe(2);
      expect(some.excluded.EXCLUDED).toBe(1);
      expect(some.recipients).toHaveLength(3); // still listed, so it can be ticked again
      expect(some.recipients.find((r: { email: string }) => r.email === emails[1])).toMatchObject({
        excluded: true,
      });

      const id = await draft(city, { filter: { cities: [city], excludeEmails: [emails[1]] } });
      expect((await confirm(id, 2)).status).toBe(200);
      expect((await recipients(id)).map((r) => r.email)).toEqual([emails[0], emails[2]].sort());
    });

    it('the preview reports exact listing counts; an audience that changes after the preview is refused at confirmation', async () => {
      const city = tag();
      const emails = ['m0', 'm1', 'm2'].map((p) => `${p}.${city}@cust.example`.toLowerCase());
      for (const e of emails) await lead(city, e);
      await grant(emails);
      const id = await draft(city, { filter: { cities: [city], excludeEmails: [emails[2]] } });
      const seen = await preview({ cities: [city], excludeEmails: [emails[2]] });
      expect(seen).toMatchObject({
        eligible: 2,
        recipientsListed: true,
        recipientsTotal: 3,
        recipientsTruncated: false,
        undisplayedEligible: 0,
      });
      // After the preview, one of the two loses eligibility.
      expect(
        (
          await ctx
            .http()
            .post('/api/v1/email/eligibility/withdraw')
            .set(owner())
            .send({ emails: [emails[0]] })
        ).status,
      ).toBe(200);
      const stale = await confirm(id, seen.eligible);
      expect(stale.status).toBe(409);
      expect(stale.body.error.message).toContain(
        'The audience changed: 1 recipients are eligible now, not 2',
      );
      expect(
        await asSystem(() => prisma().emailCampaignRecipient.count({ where: { campaignId: id } })),
      ).toBe(0);
      // Confirming the new count queues only the one still eligible — never the hand-excluded one.
      expect((await confirm(id, 1)).status).toBe(200);
      expect((await recipients(id)).map((r) => r.email)).toEqual([emails[1]]);
    });

    it('every matching lead is listed — ticked by default — even before it may receive; unticking excludes it', async () => {
      const city = tag();
      const emails = ['n0', 'n1', 'n2'].map((p) => `${p}.${city}@cust.example`.toLowerCase());
      for (const e of emails) await lead(city, e);
      await grant([emails[2]!]); // only one has recorded eligibility
      const all = await preview({ cities: [city], statuses: ['NEW'] });
      expect(all.eligible).toBe(1);
      expect(all.recipientsTotal).toBe(3);
      expect(
        all.recipients.map((r: { email: string; excluded: boolean; ineligible: string | null }) => [
          r.email,
          r.excluded,
          r.ineligible,
        ]),
      ).toEqual([
        [emails[0], false, 'NO_CONSENT'],
        [emails[1], false, 'NO_CONSENT'],
        [emails[2], false, null],
      ]);
      const some = await preview({ cities: [city], statuses: ['NEW'], excludeEmails: [emails[0]] });
      expect(some.recipients.find((r: { email: string }) => r.email === emails[0])).toMatchObject({
        excluded: true,
        ineligible: 'NO_CONSENT',
      });
      expect(some.eligible).toBe(1); // the one who may receive it is unaffected
    });

    it('a custom list: exactly the typed addresses, linked to existing leads, under the same eligibility rules', async () => {
      const city = tag();
      const known = `known.${city}@cust.example`.toLowerCase();
      const knownLeadId = await lead(city, known);
      const stranger = `new.${city}@elsewhere.example`.toLowerCase();
      // Another organization has a lead with this address: it must never be linked here.
      const otherOrgLead = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgB.owner.accessToken))
        .send({
          firstName: 'Other',
          lastName: 'Org',
          mobile: fixtureMobile(),
          email: stranger,
          city,
          source: 'Website',
          priority: 'MEDIUM',
          nextFollowUpAt: new Date(Date.now() + 86_400_000).toISOString(),
        });
      expect(otherOrgLead.status).toBe(201);
      const custom = { source: 'CUSTOM', customEmails: [known.toUpperCase(), stranger, known] };

      const before = await preview(custom);
      expect(before).toMatchObject({ selected: 2, eligible: 0 });
      expect(before.excluded.NO_CONSENT).toBe(2);

      await grant([known, stranger]);
      const after = await preview({ ...custom, statuses: ['LOST'], cities: ['Nowhere'] });
      // Lead filters are ignored for a custom list.
      expect(after).toMatchObject({ selected: 2, eligible: 2 });
      expect(after.recipients.map((r: { email: string }) => r.email).sort()).toEqual(
        [known, stranger].sort(),
      );

      const id = await draft(city, { filter: custom });
      expect((await confirm(id, 2)).status).toBe(200);
      const rows = await recipients(id);
      expect(rows.map((r) => [r.email, r.leadId])).toEqual(
        [
          [known, knownLeadId],
          [stranger, null],
        ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
      );
    });

    it('a custom list over 1,000 addresses, or with non-text entries, is refused', async () => {
      ctx.redis.flush();
      const many = Array.from({ length: 1001 }, (_, i) => `p${i}@x.example`);
      const res = await ctx
        .http()
        .post('/api/v1/email/campaigns/audience')
        .set(owner())
        .send({ purpose: 'PROMOTIONAL', filter: { source: 'CUSTOM', customEmails: many } });
      expect(res.status).toBe(400);
      ctx.redis.flush();
      const bad = await ctx
        .http()
        .post('/api/v1/email/campaigns/audience')
        .set(owner())
        .send({ purpose: 'PROMOTIONAL', filter: { source: 'SOMEWHERE', customEmails: [] } });
      expect(bad.status).toBe(400);
    });

    it('contact history: not contacted yet versus contacted before', async () => {
      const city = tag();
      const fresh = `fresh.${city}@cust.example`.toLowerCase();
      const spoken = `spoken.${city}@cust.example`.toLowerCase();
      await lead(city, fresh);
      const spokenId = await lead(city, spoken);
      await grant([fresh, spoken]);
      await asSystem(() =>
        prisma().lead.update({ where: { id: spokenId }, data: { lastContactedAt: new Date() } }),
      );
      const never = await preview({ cities: [city], contacted: ['NEVER'] });
      expect(never.recipients.map((r: { email: string }) => r.email)).toEqual([fresh]);
      const before = await preview({ cities: [city], contacted: ['CONTACTED'] });
      expect(before.recipients.map((r: { email: string }) => r.email)).toEqual([spoken]);
      expect((await preview({ cities: [city], contacted: ['NEVER', 'CONTACTED'] })).eligible).toBe(
        2,
      );
      ctx.redis.flush();
      const bad = await ctx
        .http()
        .post('/api/v1/email/campaigns/audience')
        .set(owner())
        .send({ purpose: 'PROMOTIONAL', filter: { contacted: ['SOMETIMES'] } });
      expect(bad.status).toBe(400);
    });

    it('city options come from this organization’s own leads, merged across spellings, for campaign managers only', async () => {
      const city = tag();
      await lead(city, `c1.${city}@cust.example`.toLowerCase());
      await lead(city.toLowerCase(), `c2.${city}@cust.example`.toLowerCase());
      const res = await ctx.http().get('/api/v1/email/campaigns/audience/options').set(owner());
      expect(res.status).toBe(200);
      const entry = res.body.data.cities.find(
        (c: { name: string }) => c.name.toLowerCase() === city.toLowerCase(),
      );
      expect(entry?.count).toBe(2);
      expect(res.body.data.contacted.never).toBeGreaterThanOrEqual(2);
      expect(
        (
          await ctx
            .http()
            .get('/api/v1/email/campaigns/audience/options')
            .set(auth(ctx.orgA.rep.accessToken))
        ).status,
      ).toBe(403);
      const other = await ctx
        .http()
        .get('/api/v1/email/campaigns/audience/options')
        .set(auth(ctx.orgB.owner.accessToken));
      expect(other.status).toBe(200);
      expect(
        other.body.data.cities.some(
          (c: { name: string }) => c.name.toLowerCase() === city.toLowerCase(),
        ),
      ).toBe(false);
    });
  });
});
