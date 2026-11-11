// Must be first: the config module reads the environment on import.
import { restoreEmailBroadcastsEnv, EMAIL_BROADCASTS_ENV } from './helpers/email-broadcasts-env';
import { randomBytes, randomUUID } from 'node:crypto';
import { createTestContext, type TestContext } from './helpers/test-app';
import { fixtureMobile } from './helpers/phone-fixtures';
import {
  generateTestCertificate,
  startFakeImap,
  startFakeSmtp,
  TEST_MAIL_HOST,
  type FakeImap,
  type FakeSmtp,
} from './helpers/fake-mail-servers';
import { createFakeResend, verifiedDomainDns, type FakeResend } from './helpers/fake-resend';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { MailboxService } from '../src/modules/campaigns/mailbox/mailbox.service';
import { BroadcastService } from '../src/modules/campaigns/broadcast/broadcast.service';
import { EmailDispatcher } from '../src/modules/campaigns/dispatch/email-dispatcher.service';
import { signSvix } from '../src/modules/campaigns/mailbox/svix-signature';

/**
 * Promotional campaigns through Resend Broadcasts, against an in-memory Resend.
 *
 *   one send per broadcast — an answer lost after Resend took the send is
 *   resolved by READING the broadcast, never by sending again;
 *   eligibility, consent, suppression and exact segment membership are checked
 *   again immediately before the send; if the audience cannot be guaranteed,
 *   nothing is sent;
 *   LeadFlow never resubscribes anyone at Resend, and an unsubscribe is
 *   permanent in its ledger;
 *   webhooks are verified (signature, timestamp, replay) and stay inside the
 *   mailbox's own organization;
 *   the platform's transactional key is never used for campaigns.
 */
describe('Email broadcasts (Resend Marketing)', () => {
  let ctx: TestContext;
  let smtp: FakeSmtp;
  let imap: FakeImap;
  let resend: FakeResend;
  const SENDER = 'sales@leadflow-test.example';
  const FROM = 'news@news.leadflow-test.example';
  const PASSWORD = 'Mailbox-Secret-2026!';
  const MARKETING_KEY = 're_marketing_full_access_key_001';
  const OTHER_ORG_KEY = 're_marketing_full_access_key_002';
  const secret = () => `whsec_${randomBytes(32).toString('base64')}`;
  let webhookSecret = secret();
  let mailboxId = '';

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const owner = () => auth(ctx.orgA.owner.accessToken);
  const prisma = () => ctx.app.get(PrismaService).client;
  const asSystem = <T>(run: () => Promise<T>) =>
    ctx.app.get(TenantContextService).runAsSystem('e2e', run);
  const broadcasts = () => ctx.app.get(BroadcastService);
  const tag = () => `b${Date.now()}${Math.floor(Math.random() * 1e6)}`;

  const lead = async (city: string, email: string, firstName = 'Asha') => {
    const res = await ctx
      .http()
      .post('/api/v1/leads')
      .set(owner())
      .send({
        firstName,
        lastName: 'Rao',
        mobile: fixtureMobile(),
        email,
        city,
        source: 'Website',
        nextFollowUpAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  };
  const grant = (emails: string[]) =>
    ctx
      .http()
      .post('/api/v1/email/eligibility/grant')
      .set(owner())
      .send({ emails, basis: 'CONSENT', note: 'Signed up for offers' });

  /** A confirmed promotional campaign to `count` consented people in a fresh city. */
  const confirmedCampaign = async (count: number, over: Record<string, unknown> = {}) => {
    const city = tag();
    const emails = Array.from({ length: count }, (_, i) =>
      `p${i}.${city}@cust.example`.toLowerCase(),
    );
    const leadIds: string[] = [];
    for (const [i, email] of emails.entries()) leadIds.push(await lead(city, email, `Name${i}`));
    expect((await grant(emails)).status).toBe(200);
    const draft = await ctx
      .http()
      .post('/api/v1/email/campaigns')
      .set(owner())
      .send({
        name: `Offer ${city}`,
        category: 'PROMOTIONAL_OFFER',
        purpose: 'PROMOTIONAL',
        subject: 'Our new catalogue',
        html: '<p>Dear {{first_name}}, the new range is out.</p>',
        filter: { cities: [city] },
        ...over,
      });
    expect(draft.status).toBe(201);
    const id = draft.body.data.id as string;
    const confirmed = await ctx
      .http()
      .post(`/api/v1/email/campaigns/${id}/confirm`)
      .set(owner())
      .send({ submitKey: randomUUID().replace(/-/g, ''), eligibleCount: count });
    return { id, emails, leadIds, confirmed };
  };

  const campaign = (id: string) =>
    asSystem(() => prisma().emailCampaign.findUnique({ where: { id } }));
  const recipients = (id: string) =>
    asSystem(() =>
      prisma().emailCampaignRecipient.findMany({
        where: { campaignId: id },
        orderBy: { email: 'asc' },
      }),
    );

  /** Ticks until the broadcast state stops changing (each tick is one step). */
  const run = async (id: string, now = new Date()) => {
    let last = '';
    for (let i = 0; i < 10; i++) {
      await broadcasts().tick(now);
      const c = await campaign(id);
      const signature = `${c!.status}/${c!.broadcastState}`;
      if (signature === last) return c!;
      last = signature;
    }
    return (await campaign(id))!;
  };

  const sends = (broadcastId: string | null) =>
    resend.log.filter((l) => l.method === 'POST' && l.path === `/broadcasts/${broadcastId}/send`)
      .length;

  const webhook = async (
    event: unknown,
    opts: { id?: string; at?: Date; secret?: string; mailbox?: string } = {},
  ) => {
    const raw = JSON.stringify(event);
    const id = opts.id ?? `msg_${randomUUID()}`;
    const ts = String(Math.floor((opts.at ?? new Date()).getTime() / 1000));
    return ctx
      .http()
      .post(`/api/v1/webhooks/email/resend/${opts.mailbox ?? mailboxId}`)
      .set('Content-Type', 'application/json')
      .set('svix-id', id)
      .set('svix-timestamp', ts)
      .set('svix-signature', signSvix(opts.secret ?? webhookSecret, id, ts, raw))
      .send(raw);
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    const tls = generateTestCertificate();
    smtp = await startFakeSmtp(tls, { user: SENDER, pass: PASSWORD });
    imap = await startFakeImap(tls, { user: SENDER, pass: PASSWORD });
    resend = createFakeResend({
      fullAccessKeys: [MARKETING_KEY, OTHER_ORG_KEY],
      domains: [{ name: 'news.leadflow-test.example', status: 'verified' }],
    });
    ctx.app.get(MailboxService).useConnectionDeps({
      resolveHost: async () => '127.0.0.1',
      testPorts: { smtp: smtp.port, imap: imap.port },
      testCa: tls.cert,
      fetchImpl: (url, init) => resend.fetch(url, init),
      dns: verifiedDomainDns('news.leadflow-test.example'),
    });

    const account = {
      emailAddress: SENDER,
      imapHost: TEST_MAIL_HOST,
      imapPort: 993,
      imapSecurity: 'SSL_TLS',
      smtpHost: TEST_MAIL_HOST,
      smtpPort: 465,
      smtpSecurity: 'SSL_TLS',
      password: PASSWORD,
    };
    expect((await ctx.http().put('/api/v1/email/mailbox').set(owner()).send(account)).status).toBe(
      200,
    );
    expect(
      (await ctx.http().post('/api/v1/email/mailbox/test/imap').set(owner())).body.data.ok,
    ).toBe(true);
    const provider = await ctx
      .http()
      .put('/api/v1/email/mailbox/provider')
      .set(owner())
      .send({ provider: 'RESEND', fromAddress: FROM, apiKey: MARKETING_KEY, webhookSecret });
    expect(provider.status).toBe(200);
    mailboxId = provider.body.data.resend.webhookUrl.split('/').pop();
    const tested = await ctx.http().post('/api/v1/email/mailbox/test/provider').set(owner());
    expect(tested.body.data).toMatchObject({ ok: true });
    expect(
      (await ctx.http().patch('/api/v1/email/mailbox/sending').set(owner()).send({ enabled: true }))
        .status,
    ).toBe(200);
  });

  beforeEach(() => {
    ctx.redis.flush();
    resend.removeFromSegmentSupported = true;
  });

  afterAll(async () => {
    await smtp?.close();
    await imap?.close();
    await ctx?.close();
    restoreEmailBroadcastsEnv();
  });

  describe('settings', () => {
    it('stores the marketing key sealed, reports it as full access, and never returns it', async () => {
      const view = (await ctx.http().get('/api/v1/email/mailbox').set(owner())).body.data;
      expect(view).toMatchObject({
        sendingProvider: 'RESEND',
        fromAddress: FROM,
        resend: { apiKeySet: true, webhookSecretSet: true },
      });
      expect(JSON.stringify(view)).not.toContain(MARKETING_KEY);
      expect(JSON.stringify(view)).not.toContain(webhookSecret);
      const row = await asSystem(() =>
        prisma().emailMailbox.findFirst({ where: { organizationId: ctx.orgA.id } }),
      );
      expect(row).toMatchObject({ apiKeyAccess: 'full' });
      expect(row!.encryptedApiKey).not.toContain(MARKETING_KEY);
    });

    it('refuses the platform’s transactional key for campaigns', async () => {
      const res = await ctx
        .http()
        .put('/api/v1/email/mailbox/provider')
        .set(owner())
        .send({ provider: 'RESEND', apiKey: EMAIL_BROADCASTS_ENV.RESEND_API_KEY });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('separate Resend API key');
    });
  });

  describe('sending', () => {
    it('syncs consented contacts, builds an exact segment, sends the broadcast ONCE, and hands every recipient to Resend', async () => {
      const { id, emails, confirmed } = await confirmedCampaign(3);
      expect(confirmed.status).toBe(200);
      const c = await run(id);
      expect(c).toMatchObject({
        deliveryChannel: 'RESEND_BROADCAST',
        broadcastState: 'HANDED_OFF',
        status: 'SENDING',
      });
      expect(sends(c.providerBroadcastId)).toBe(1);
      expect(
        resend.broadcastDeliveries
          .filter((d) => d.broadcastId === c.providerBroadcastId)
          .map((d) => d.email)
          .sort(),
      ).toEqual(emails.sort());

      const broadcast = resend.broadcasts.get(c.providerBroadcastId!)!;
      expect(broadcast.html).toContain('{{{contact.first_name}}}');
      expect(broadcast.html).toContain('{{{RESEND_UNSUBSCRIBE_URL}}}');
      expect(broadcast.from).toContain(FROM);
      expect(broadcast.replyTo).toBe(SENDER);
      expect((await recipients(id)).every((r) => r.status === 'SENDING')).toBe(true);
      expect(resend.resubscribeAttempts).toEqual([]);

      // More ticks never send again.
      await run(id);
      expect(sends(c.providerBroadcastId)).toBe(1);
    });

    it('an answer lost AFTER Resend accepted the send is resolved by reading the broadcast — never a second send', async () => {
      const { id } = await confirmedCampaign(2);
      resend.fault('POST', /^\/broadcasts\/[^/]+\/send$/, 'lost-answer');
      for (let i = 0; i < 6 && (await campaign(id))!.broadcastState !== 'SEND_REQUESTED'; i++) {
        await broadcasts().tick();
      }
      expect((await campaign(id))!.broadcastState).toBe('SEND_REQUESTED');
      const reads = () =>
        resend.log.filter((l) => l.method === 'GET' && l.path.startsWith('/broadcasts/')).length;
      const before = reads();
      await broadcasts().tick();
      const c = (await campaign(id))!;
      expect(c.broadcastState).toBe('HANDED_OFF');
      expect(reads()).toBe(before + 1);
      expect(sends(c.providerBroadcastId)).toBe(1);
      expect(
        resend.broadcastDeliveries.filter((d) => d.broadcastId === c.providerBroadcastId),
      ).toHaveLength(2);
    });

    it('a send that never reached Resend is sent once, after waiting and reading that it is still a draft', async () => {
      const { id } = await confirmedCampaign(1);
      resend.fault('POST', /^\/broadcasts\/[^/]+\/send$/, 'network');
      const now = new Date();
      let c = await run(id, now);
      expect(c.broadcastState).toBe('SEND_REQUESTED');
      // Too soon to conclude anything: still nothing sent.
      c = await run(id, new Date(now.getTime() + 30_000));
      expect(resend.broadcasts.get(c.providerBroadcastId!)!.status).toBe('draft');
      c = await run(id, new Date(now.getTime() + 5 * 60_000));
      expect(c.broadcastState).toBe('HANDED_OFF');
      expect(
        resend.broadcastDeliveries.filter((d) => d.broadcastId === c.providerBroadcastId),
      ).toHaveLength(1);
    });

    it('two workers advancing the same campaign at once send it once', async () => {
      const { id } = await confirmedCampaign(2);
      await Promise.all([broadcasts().tick(), broadcasts().tick(), broadcasts().tick()]);
      const c = await run(id);
      expect(c.broadcastState).toBe('HANDED_OFF');
      expect(
        resend.broadcastDeliveries.filter((d) => d.broadcastId === c.providerBroadcastId),
      ).toHaveLength(2);
    });

    it('rechecks eligibility immediately before sending: withdrawn consent and a Resend unsubscribe are both left out', async () => {
      const { id, emails } = await confirmedCampaign(3);
      await ctx
        .http()
        .post('/api/v1/email/eligibility/withdraw')
        .set(owner())
        .send({ emails: [emails[0]] });
      // Someone unsubscribes directly at Resend before the send.
      await broadcasts().tick(); // contacts synced
      resend.contacts.get(emails[1]!)!.unsubscribed = true;
      const c = await run(id);
      expect(c.broadcastState).toBe('HANDED_OFF');
      expect(
        resend.broadcastDeliveries
          .filter((d) => d.broadcastId === c.providerBroadcastId)
          .map((d) => d.email),
      ).toEqual([emails[2]]);
      const rows = await recipients(id);
      expect(rows.find((r) => r.email === emails[0])).toMatchObject({
        status: 'SKIPPED',
        skipReason: 'NO_CONSENT',
      });
      expect(rows.find((r) => r.email === emails[1])).toMatchObject({ status: 'SKIPPED' });
      expect(
        await asSystem(() => prisma().emailSuppression.findFirst({ where: { email: emails[1]! } })),
      ).toMatchObject({ reason: 'UNSUBSCRIBED' });
      expect(resend.resubscribeAttempts).toEqual([]);
    });

    it('a stranger in the segment is removed; if that cannot be done, NOTHING is sent and the campaign pauses', async () => {
      const first = await confirmedCampaign(1);
      await broadcasts().tick();
      await broadcasts().tick(); // segment built
      let c = await campaign(first.id);
      const stranger = `stranger.${tag()}@elsewhere.example`;
      resend.contacts.set(stranger, {
        id: randomUUID(),
        email: stranger,
        first_name: null,
        last_name: null,
        unsubscribed: false,
        segments: new Set([c!.providerSegmentId!]),
      });
      c = await run(first.id);
      expect(c.broadcastState).toBe('HANDED_OFF');
      expect(
        resend.broadcastDeliveries
          .filter((d) => d.broadcastId === c.providerBroadcastId)
          .map((d) => d.email),
      ).toEqual(first.emails);

      const second = await confirmedCampaign(1);
      await broadcasts().tick();
      await broadcasts().tick();
      const segment = (await campaign(second.id))!.providerSegmentId!;
      const other = `other.${tag()}@elsewhere.example`;
      resend.contacts.set(other, {
        id: randomUUID(),
        email: other,
        first_name: null,
        last_name: null,
        unsubscribed: false,
        segments: new Set([segment]),
      });
      resend.removeFromSegmentSupported = false;
      const blocked = await run(second.id);
      expect(blocked).toMatchObject({ status: 'PAUSED' });
      expect(blocked.pauseReason).toContain('could not be removed');
      expect(blocked.providerBroadcastId).toBeNull();
      expect(resend.broadcastDeliveries.some((d) => d.email === other)).toBe(false);
    });

    it('fails closed until a LeadFlow unsubscribe has reached Resend', async () => {
      // Someone already synced to Resend later unsubscribes in LeadFlow.
      const earlier = await confirmedCampaign(1);
      await run(earlier.id);
      await ctx
        .http()
        .post('/api/v1/email/suppressions')
        .set(owner())
        .send({ emails: earlier.emails, note: 'Asked by phone' });

      const { id } = await confirmedCampaign(1);
      resend.fault('PATCH', /^\/contacts\//, 500, 3);
      let c = await run(id);
      expect(c.broadcastState).toBe('PENDING');
      expect(c.broadcastError).toContain('unsubscribe');
      expect(resend.contacts.get(earlier.emails[0]!)!.unsubscribed).toBe(false);

      c = await run(id); // the push now succeeds
      expect(resend.contacts.get(earlier.emails[0]!)!.unsubscribed).toBe(true);
      expect(c.broadcastState).toBe('HANDED_OFF');
    });

    it('an unsubscribe in the ledger is permanent: the database refuses to clear it', async () => {
      const email = `ledger.${tag()}@cust.example`;
      await asSystem(() =>
        prisma().emailProviderContact.create({
          data: {
            organizationId: ctx.orgA.id,
            mailboxId,
            email,
            unsubscribed: true,
            unsubscribedAt: new Date(),
          },
        }),
      );
      await expect(
        asSystem(() =>
          prisma().emailProviderContact.updateMany({
            where: { email },
            data: { unsubscribed: false },
          }),
        ),
      ).rejects.toThrow(/cannot be resubscribed/);
      await expect(
        asSystem(() => prisma().emailProviderContact.deleteMany({ where: { email } })),
      ).rejects.toThrow(/never deleted/);
    });

    it('once handed to Resend it cannot be paused or cancelled from LeadFlow', async () => {
      const { id } = await confirmedCampaign(1);
      await run(id);
      for (const verb of ['pause', 'cancel']) {
        const res = await ctx.http().post(`/api/v1/email/campaigns/${id}/${verb}`).set(owner());
        expect(res.status).toBe(409);
        expect(res.body.error.message).toContain('cannot be recalled');
      }
    });

    it('refuses per-recipient fields a broadcast cannot fill, and attachments', async () => {
      const { confirmed } = await confirmedCampaign(1, { html: '<p>Hello {{company}}</p>' });
      expect(confirmed.status).toBe(400);
      expect(confirmed.body.error.message).toContain('{{company}}');
    });

    it('never uses the platform transactional key', () => {
      const keys = new Set(resend.log.map((l) => l.auth));
      expect([...keys]).toEqual([`Bearer ${MARKETING_KEY}`]);
    });

    it('the one-by-one dispatcher leaves broadcast campaigns alone', async () => {
      const { id } = await confirmedCampaign(1);
      await ctx.app.get(EmailDispatcher).tick();
      expect(smtp.messages).toHaveLength(0);
      expect(resend.emails).toHaveLength(0);
      expect((await recipients(id)).every((r) => r.attempts === 0)).toBe(true);
    });
  });

  describe('webhooks', () => {
    const sentEvent = (
      broadcastId: string,
      email: string,
      emailId = randomUUID(),
      messageId = `<${randomUUID()}@news.leadflow-test.example>`,
    ) => ({
      type: 'email.sent',
      created_at: new Date().toISOString(),
      data: {
        broadcast_id: broadcastId,
        email_id: emailId,
        message_id: messageId,
        to: [email],
        subject: 'Our new catalogue',
      },
    });

    it('email.sent marks the recipient accepted, keeps Resend’s email id and the RFC Message-ID apart, and writes lead history', async () => {
      const { id, emails, leadIds } = await confirmedCampaign(1);
      const c = await run(id);
      const emailId = randomUUID();
      const messageId = `<${randomUUID()}@news.leadflow-test.example>`;
      expect(
        (await webhook(sentEvent(c.providerBroadcastId!, emails[0]!, emailId, messageId))).body
          .data,
      ).toEqual({ applied: true });
      const [row] = await recipients(id);
      expect(row).toMatchObject({ status: 'ACCEPTED', providerMessageId: emailId, messageId });
      const history = await asSystem(() =>
        prisma().leadActivity.findMany({
          where: { leadId: leadIds[0]!, activityType: 'EMAIL_SENT' },
        }),
      );
      expect(history[0]!.description).toContain('accepted by Resend');

      await webhook({
        type: 'email.delivered',
        data: { broadcast_id: c.providerBroadcastId, email_id: emailId, to: [emails[0]] },
      });
      expect((await recipients(id))[0]!.deliveredAt).not.toBeNull();
      const done = await run(id);
      expect(done.status).toBe('COMPLETED');
    });

    it('bounce and complaint suppress the address; a complaint also withdraws eligibility', async () => {
      const { id, emails } = await confirmedCampaign(2);
      const c = await run(id);
      const [bounceId, complaintId] = [randomUUID(), randomUUID()];
      await webhook(sentEvent(c.providerBroadcastId!, emails[0]!, bounceId));
      await webhook(sentEvent(c.providerBroadcastId!, emails[1]!, complaintId));
      await webhook({
        type: 'email.bounced',
        data: {
          email_id: bounceId,
          to: [emails[0]],
          bounce: { type: 'Permanent', subType: 'General', message: 'mailbox does not exist' },
        },
      });
      await webhook({ type: 'email.complained', data: { email_id: complaintId, to: [emails[1]] } });
      const rows = await recipients(id);
      expect(rows.find((r) => r.email === emails[0])).toMatchObject({ status: 'FAILED' });
      const [bounce, complaint, consent] = await asSystem(() =>
        Promise.all([
          prisma().emailSuppression.findFirst({ where: { email: emails[0]! } }),
          prisma().emailSuppression.findFirst({ where: { email: emails[1]! } }),
          prisma().marketingConsent.findFirst({ where: { email: emails[1]! } }),
        ]),
      );
      expect(bounce!.reason).toBe('BOUNCED');
      expect(complaint!.reason).toBe('COMPLAINT');
      expect(consent!.status).toBe('WITHDRAWN');
    });

    it('contact.updated with unsubscribed:true becomes a permanent LeadFlow unsubscribe; nothing turns it back on', async () => {
      const email = `contact.${tag()}@cust.example`;
      await grant([email]);
      await webhook({ type: 'contact.updated', data: { email, unsubscribed: true } });
      await webhook({ type: 'contact.updated', data: { email, unsubscribed: false } });
      const [suppression, consent, ledger] = await asSystem(() =>
        Promise.all([
          prisma().emailSuppression.findFirst({ where: { email } }),
          prisma().marketingConsent.findFirst({ where: { email } }),
          prisma().emailProviderContact.findFirst({ where: { email } }),
        ]),
      );
      expect(suppression!.reason).toBe('UNSUBSCRIBED');
      expect(consent!.status).toBe('WITHDRAWN');
      expect(ledger).toMatchObject({ unsubscribed: true });
    });

    it('rejects a bad signature, a stale timestamp and an unknown mailbox; a replay is applied once', async () => {
      const event = {
        type: 'contact.updated',
        data: { email: `x.${tag()}@cust.example`, unsubscribed: true },
      };
      expect((await webhook(event, { secret: secret() })).status).toBe(401);
      expect((await webhook(event, { at: new Date(Date.now() - 10 * 60_000) })).status).toBe(401);
      expect((await webhook(event, { mailbox: randomUUID() })).status).toBe(404);
      const id = `msg_${randomUUID()}`;
      expect((await webhook(event, { id })).body.data).toEqual({ applied: true });
      expect((await webhook(event, { id })).body.data).toEqual({ applied: false });
    });

    it('rotating the webhook secret keeps the old one valid for the overlap', async () => {
      const old = webhookSecret;
      webhookSecret = secret();
      expect(
        (
          await ctx
            .http()
            .put('/api/v1/email/mailbox/provider')
            .set(owner())
            .send({ provider: 'RESEND', webhookSecret })
        ).status,
      ).toBe(200);
      const event = {
        type: 'contact.updated',
        data: { email: `r.${tag()}@cust.example`, unsubscribed: true },
      };
      expect((await webhook(event, { secret: old })).status).toBe(200);
      expect((await webhook(event)).status).toBe(200);
      // Re-prove the provider after the change (settings changes switch sending off).
      await ctx.http().post('/api/v1/email/mailbox/test/provider').set(owner());
      await ctx.http().patch('/api/v1/email/mailbox/sending').set(owner()).send({ enabled: true });
    });

    it('another organization’s webhook cannot touch this organization’s campaign', async () => {
      const { id, emails } = await confirmedCampaign(1);
      const c = await run(id);

      // Organization B has its own Resend mailbox and secret.
      const bSecret = secret();
      const bOwner = auth(ctx.orgB.owner.accessToken);
      await ctx.http().put('/api/v1/email/mailbox').set(bOwner).send({
        emailAddress: 'b@leadflow-test.example',
        imapHost: TEST_MAIL_HOST,
        imapPort: 993,
        imapSecurity: 'SSL_TLS',
        smtpHost: TEST_MAIL_HOST,
        smtpPort: 465,
        smtpSecurity: 'SSL_TLS',
        password: 'B-password-123',
      });
      const bView = await ctx
        .http()
        .put('/api/v1/email/mailbox/provider')
        .set(bOwner)
        .send({
          provider: 'RESEND',
          fromAddress: FROM,
          apiKey: OTHER_ORG_KEY,
          webhookSecret: bSecret,
        });
      const bMailbox = bView.body.data.resend.webhookUrl.split('/').pop();

      // A correctly signed B event naming A's broadcast and A's recipient.
      const res = await webhook(sentEvent(c.providerBroadcastId!, emails[0]!), {
        mailbox: bMailbox,
        secret: bSecret,
      });
      expect(res.body.data).toEqual({ applied: false });
      expect((await recipients(id))[0]).toMatchObject({
        status: 'SENDING',
        providerMessageId: null,
      });
      // And A's mailbox does not accept B's secret.
      expect(
        (await webhook(sentEvent(c.providerBroadcastId!, emails[0]!), { secret: bSecret })).status,
      ).toBe(401);
    });
  });

  describe('service messages (one email per recipient)', () => {
    it('go through the single-email API with the recipient’s idempotency key and Reply-To; a lost answer is retried without a duplicate', async () => {
      const city = tag();
      const email = `svc.${city}@cust.example`.toLowerCase();
      await lead(city, email);
      const draft = await ctx
        .http()
        .post('/api/v1/email/campaigns')
        .set(owner())
        .send({
          name: 'Holiday hours',
          category: 'CUSTOMER_UPDATE',
          purpose: 'TRANSACTIONAL',
          subject: 'Our holiday hours',
          html: '<p>We are closed on Monday.</p>',
          filter: { cities: [city] },
        });
      const id = draft.body.data.id;
      const confirmed = await ctx
        .http()
        .post(`/api/v1/email/campaigns/${id}/confirm`)
        .set(owner())
        .send({ submitKey: randomUUID().replace(/-/g, ''), eligibleCount: 1 });
      expect(confirmed.body.data).toMatchObject({ status: 'SENDING' });
      expect((await campaign(id))!.deliveryChannel).toBe('RESEND_EMAIL');

      resend.fault('POST', /^\/emails$/, 'lost-answer');
      const dispatcher = ctx.app.get(EmailDispatcher);
      expect((await dispatcher.tick()).retried).toBe(1);
      const [row] = await recipients(id);
      await asSystem(() =>
        prisma().emailCampaignRecipient.update({
          where: { id: row!.id },
          data: { nextAttemptAt: new Date(Date.now() - 1000) },
        }),
      );
      expect((await dispatcher.tick()).accepted).toBe(1);

      const sent = resend.emails.filter((e) => e.to === email);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.idempotencyKey).toBe(`leadflow-recipient-${row!.id}`);
      expect(sent[0]!.body).toMatchObject({ reply_to: SENDER });
      expect((await recipients(id))[0]).toMatchObject({
        status: 'ACCEPTED',
        providerMessageId: sent[0]!.id,
      });
    });
  });
});
