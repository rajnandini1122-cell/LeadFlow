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
import { AppConfig } from '../src/common/config/config.module';

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

  /** Ticks until the broadcast stops changing (each tick is one step, or one wait). */
  const run = async (id: string, now = new Date()) => {
    let last = '';
    for (let i = 0; i < 12; i++) {
      await broadcasts().tick(now);
      const c = await campaign(id);
      const signature = `${c!.status}/${c!.broadcastState}/${c!.broadcastError}`;
      if (signature === last) return c!;
      last = signature;
    }
    return (await campaign(id))!;
  };

  /** The campaign as the page sees it (API view, including the broadcast section). */
  const view = async (id: string, as = owner()) =>
    (await ctx.http().get(`/api/v1/email/campaigns/${id}`).set(as)).body.data;
  /** A decision made from the page: sends the version the page was showing unless told otherwise. */
  const resolve = async (id: string, body: Record<string, unknown>, as = owner()) => {
    const expectedVersion =
      'expectedVersion' in body ? body['expectedVersion'] : (await view(id)).broadcast?.version;
    return ctx
      .http()
      .post(`/api/v1/email/campaigns/${id}/broadcast/resolve`)
      .set(as)
      .send({ ...body, expectedVersion });
  };
  /** A broadcast whose send got no answer and still reads "draft" after the settle period. */
  const inReview = async (count: number) => {
    const made = await confirmedCampaign(count);
    const now = new Date();
    // Up to the draft, then fail THIS broadcast's send (other suites' campaigns may be in flight).
    for (let i = 0; i < 8 && (await campaign(made.id))!.broadcastState !== 'DRAFT_CREATED'; i++) {
      await broadcasts().tick(now);
    }
    const draft = (await campaign(made.id))!;
    expect(draft.broadcastState).toBe('DRAFT_CREATED');
    resend.fault('POST', new RegExp(`^/broadcasts/${draft.providerBroadcastId}/send$`), 'network');
    await run(made.id, now);
    const c = await run(made.id, new Date(now.getTime() + 5 * 60_000));
    expect(c).toMatchObject({ status: 'PAUSED', broadcastState: 'NEEDS_REVIEW' });
    return { ...made, campaign: c };
  };
  const reviewRows = (campaignId: string) =>
    asSystem(() =>
      prisma().emailBroadcastReview.findMany({
        where: { campaignId },
        orderBy: { createdAt: 'asc' },
      }),
    );

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
      resendMinIntervalMs: 0,
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
    resend.staleMembershipReads = 0;
    resend.deliverOnSend = true;
    resend.clearFaults();
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

    it('an ambiguous send that still reads "draft" is NOT sent again automatically: it waits for a person (NEEDS_REVIEW)', async () => {
      const { id } = await confirmedCampaign(1);
      resend.fault('POST', /^\/broadcasts\/[^/]+\/send$/, 'network');
      const now = new Date();
      let c = await run(id, now);
      expect(c.broadcastState).toBe('SEND_REQUESTED');
      // Too soon to conclude anything.
      c = await run(id, new Date(now.getTime() + 30_000));
      expect(c.broadcastState).toBe('SEND_REQUESTED');
      // After the settle period: still a draft. LeadFlow stops and asks a person.
      c = await run(id, new Date(now.getTime() + 5 * 60_000));
      expect(c).toMatchObject({ status: 'PAUSED', broadcastState: 'NEEDS_REVIEW' });
      expect(c.pauseReason).toContain('will not ask again on its own');
      // Hours of ticks change nothing: exactly one send request, ever.
      c = await run(id, new Date(now.getTime() + 6 * 3_600_000));
      expect(c.broadcastState).toBe('NEEDS_REVIEW');
      expect(sends(c.providerBroadcastId)).toBe(1);
      expect(resend.broadcasts.get(c.providerBroadcastId!)!.status).toBe('draft');
      expect(
        resend.broadcastDeliveries.filter((d) => d.broadcastId === c.providerBroadcastId),
      ).toHaveLength(0);

      // Resume is refused; the decision is explicit, with a reason, and audited.
      const resumed = await ctx.http().post(`/api/v1/email/campaigns/${id}/resume`).set(owner());
      expect(resumed.status).toBe(409);
      const noReason = await resolve(id, { action: 'retry' });
      expect(noReason.status).toBe(400);
      const resolved = await resolve(id, {
        action: 'retry',
        reason: 'Checked Resend: still a draft, nothing sent',
      });
      expect(resolved.status).toBe(200);
      c = (await campaign(id))!;
      expect(c).toMatchObject({ status: 'SENDING', broadcastState: 'DRAFT_CREATED' });
      // The normal path: precheck again, then one send request.
      c = await run(id, new Date(now.getTime() + 6 * 3_600_000 + 60_000));
      expect(c.broadcastState).toBe('HANDED_OFF');
      expect(sends(c.providerBroadcastId)).toBe(2);
      expect(
        resend.broadcastDeliveries.filter((d) => d.broadcastId === c.providerBroadcastId),
      ).toHaveLength(1);
      const audit = await asSystem(() =>
        prisma().auditLog.findFirst({
          where: { entityId: id, action: 'email.campaign.broadcast_resolved' },
        }),
      );
      expect(audit?.after).toMatchObject({
        action: 'retry',
        reason: 'Checked Resend: still a draft, nothing sent',
        outcome: 'retrying',
        providerStatus: 'draft',
      });
    });

    it('a manual retry never re-sends a broadcast Resend has queued: the live status wins', async () => {
      const { id } = await confirmedCampaign(1);
      resend.fault('POST', /^\/broadcasts\/[^/]+\/send$/, 'network');
      const now = new Date();
      await run(id, now);
      let c = await run(id, new Date(now.getTime() + 5 * 60_000));
      expect(c.broadcastState).toBe('NEEDS_REVIEW');
      // Meanwhile the broadcast was sent from Resend's dashboard.
      resend.broadcasts.get(c.providerBroadcastId!)!.status = 'queued';
      const resolved = await resolve(id, { action: 'retry', reason: 'Try again' });
      expect(resolved.status).toBe(200);
      c = (await campaign(id))!;
      expect(c).toMatchObject({ status: 'SENDING', broadcastState: 'HANDED_OFF' });
      expect(sends(c.providerBroadcastId)).toBe(1);
      expect((await recipients(id)).every((r) => r.status === 'SENDING')).toBe(true);
    });

    it('a broadcast status that cannot be read for 15 minutes goes to NEEDS_REVIEW; abandoning it then marks recipients UNCERTAIN, not cancelled', async () => {
      const { id } = await confirmedCampaign(2);
      resend.fault('POST', /^\/broadcasts\/[^/]+\/send$/, 'lost-answer');
      const now = new Date();
      for (let i = 0; i < 6 && (await campaign(id))!.broadcastState !== 'SEND_REQUESTED'; i++) {
        await broadcasts().tick(now);
      }
      resend.fault('GET', /^\/broadcasts\/[^/]+$/, 'network', 5);
      await broadcasts().tick(new Date(now.getTime() + 60_000));
      let c = (await campaign(id))!;
      expect(c).toMatchObject({ status: 'SENDING', broadcastState: 'SEND_REQUESTED' });
      expect(c.broadcastRetrySince).not.toBeNull();
      await broadcasts().tick(new Date(now.getTime() + 10 * 60_000));
      expect((await campaign(id))!.broadcastState).toBe('SEND_REQUESTED');
      await broadcasts().tick(new Date(now.getTime() + 17 * 60_000));
      c = (await campaign(id))!;
      expect(c).toMatchObject({ status: 'PAUSED', broadcastState: 'NEEDS_REVIEW' });
      expect(c.pauseReason).toContain('Could not read the broadcast status');

      // Retry needs a live read; with Resend unreadable it is refused and nothing changes.
      const retry = await resolve(id, { action: 'retry', reason: 'Try again' });
      expect(retry.status).toBe(409);
      expect((await campaign(id))!.broadcastState).toBe('NEEDS_REVIEW');
      const abandoned = await resolve(id, {
        action: 'abandon',
        reason: 'Resend unreachable, will check by hand',
      });
      expect(abandoned.status).toBe(200);
      expect((await campaign(id))!.status).toBe('CANCELLED');
      const rows = await recipients(id);
      expect(rows.every((r) => r.status === 'UNCERTAIN')).toBe(true);
      expect(rows[0]!.lastResponse).toContain('may have received');
      expect(sends(c.providerBroadcastId)).toBe(1);
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
      const now = new Date();
      const waiting = await run(second.id, now);
      // Not sent, not given up yet: the removal is tried again every tick.
      expect(waiting).toMatchObject({ status: 'SENDING', broadcastState: 'SEGMENT_READY' });
      expect(waiting.broadcastError).toContain('Could not remove');
      expect(waiting.providerBroadcastId).toBeNull();
      // Still failing 15 minutes later: a person decides. Nothing was sent.
      await broadcasts().tick(new Date(now.getTime() + 16 * 60_000));
      const review = (await campaign(second.id))!;
      expect(review).toMatchObject({ status: 'PAUSED', broadcastState: 'NEEDS_REVIEW' });
      expect(review.pauseReason).toContain('Could not remove');
      expect(review.providerBroadcastId).toBeNull();
      expect(resend.broadcastDeliveries.some((d) => d.email === other)).toBe(false);
      const removals = resend.log.filter(
        (l) =>
          l.method === 'DELETE' &&
          l.path === `/contacts/${encodeURIComponent(other)}/segments/${segment}`,
      );
      expect(removals.length).toBeGreaterThanOrEqual(2);
    });

    it('membership is verified contact by contact; a change not yet visible is corrected and re-verified, never sent on the same pass', async () => {
      const { id, emails } = await confirmedCampaign(2);
      await broadcasts().tick(); // contacts synced
      await broadcasts().tick(); // segment built
      // Resend has not caught up: the next membership read shows the contact in no segment.
      resend.staleMembershipReads = 1;
      await broadcasts().tick();
      let c = (await campaign(id))!;
      expect(c).toMatchObject({ broadcastState: 'SEGMENT_READY', providerBroadcastId: null });
      expect(c.broadcastError).toContain('was corrected');
      const segmentReads = resend.log.filter(
        (l) => l.method === 'GET' && /^\/contacts\/[^/]+\/segments/.test(l.path),
      );
      expect(segmentReads.map((l) => decodeURIComponent(l.path.split('/')[2]!)).sort()).toEqual(
        expect.arrayContaining(emails),
      );
      c = await run(id);
      expect(c.broadcastState).toBe('HANDED_OFF');
      expect(sends(c.providerBroadcastId)).toBe(1);
      expect(
        resend.broadcastDeliveries
          .filter((d) => d.broadcastId === c.providerBroadcastId)
          .map((d) => d.email)
          .sort(),
      ).toEqual([...emails].sort());
    });

    it('a recipient who became ineligible after the segment was built is removed by the documented DELETE before the send', async () => {
      const { id, emails } = await confirmedCampaign(2);
      await broadcasts().tick();
      await broadcasts().tick(); // both in the segment
      const segment = (await campaign(id))!.providerSegmentId!;
      await ctx
        .http()
        .post('/api/v1/email/eligibility/withdraw')
        .set(owner())
        .send({ emails: [emails[0]] });
      const c = await run(id);
      expect(c.broadcastState).toBe('HANDED_OFF');
      expect(
        resend.log.some(
          (l) =>
            l.method === 'DELETE' &&
            l.path === `/contacts/${encodeURIComponent(emails[0]!)}/segments/${segment}`,
        ),
      ).toBe(true);
      expect(
        resend.broadcastDeliveries
          .filter((d) => d.broadcastId === c.providerBroadcastId)
          .map((d) => d.email),
      ).toEqual([emails[1]]);
    });

    it('nobody without recorded eligibility is ever sent to Resend: leads with an email but no grant stay in LeadFlow', async () => {
      const city = tag();
      const granted = `ok.${city}@cust.example`;
      const notGranted = [`no1.${city}@cust.example`, `no2.${city}@cust.example`];
      for (const email of [granted, ...notGranted]) await lead(city, email);
      expect((await grant([granted])).status).toBe(200);
      const draft = await ctx
        .http()
        .post('/api/v1/email/campaigns')
        .set(owner())
        .send({
          name: `Offer ${city}`,
          category: 'PROMOTIONAL_OFFER',
          purpose: 'PROMOTIONAL',
          subject: 'Our new catalogue',
          html: '<p>Dear {{first_name}}</p>',
          filter: { cities: [city] },
        });
      const id = draft.body.data.id as string;
      const preview = await ctx
        .http()
        .post('/api/v1/email/campaigns/audience')
        .set(owner())
        .send({ purpose: 'PROMOTIONAL', filter: { cities: [city] } });
      expect(preview.body.data).toMatchObject({ selected: 3, eligible: 1 });
      const confirmed = await ctx
        .http()
        .post(`/api/v1/email/campaigns/${id}/confirm`)
        .set(owner())
        .send({ submitKey: randomUUID().replace(/-/g, ''), eligibleCount: 1 });
      expect(confirmed.status).toBe(200);
      const c = await run(id);
      expect(c.broadcastState).toBe('HANDED_OFF');
      for (const email of notGranted) {
        expect(resend.contacts.has(email)).toBe(false);
        expect(
          resend.log.some(
            (l) =>
              l.path.includes(encodeURIComponent(email)) ||
              JSON.stringify(l.body ?? {}).includes(email),
          ),
        ).toBe(false);
      }
      expect((await recipients(id)).map((r) => r.email)).toEqual([granted]);
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

    it('once handed to Resend it cannot be paused; a SENT broadcast cannot be cancelled or recalled', async () => {
      const { id } = await confirmedCampaign(1);
      const c = await run(id);
      const paused = await ctx.http().post(`/api/v1/email/campaigns/${id}/pause`).set(owner());
      expect(paused.status).toBe(409);
      expect(paused.body.error.message).toContain('cannot be recalled');
      resend.broadcasts.get(c.providerBroadcastId!)!.status = 'sent';
      const cancelled = await ctx.http().post(`/api/v1/email/campaigns/${id}/cancel`).set(owner());
      expect(cancelled.status).toBe(409);
      expect(cancelled.body.error.message).toContain('cannot be recalled');
      expect(resend.log.some((l) => l.path === `/broadcasts/${c.providerBroadcastId}/cancel`)).toBe(
        false,
      );
      expect((await campaign(id))!).toMatchObject({
        status: 'SENDING',
        broadcastState: 'HANDED_OFF',
      });
    });

    it('cancelling a QUEUED broadcast uses Resend’s cancel API; recipients stay UNCERTAIN, and a later "sent" report still wins', async () => {
      resend.deliverOnSend = false; // queued at Resend, not yet delivered
      const { id, emails, leadIds } = await confirmedCampaign(2);
      const c = await run(id);
      expect(c.broadcastState).toBe('HANDED_OFF');
      expect(resend.broadcasts.get(c.providerBroadcastId!)!.status).toBe('queued');
      const res = await ctx.http().post(`/api/v1/email/campaigns/${id}/cancel`).set(owner());
      expect(res.status).toBe(200);
      expect(
        resend.log.filter(
          (l) => l.method === 'POST' && l.path === `/broadcasts/${c.providerBroadcastId}/cancel`,
        ),
      ).toHaveLength(1);
      expect(resend.broadcasts.get(c.providerBroadcastId!)!.status).toBe('canceled');
      expect((await campaign(id))!).toMatchObject({
        status: 'CANCELLED',
        broadcastState: 'CANCELLED_AT_PROVIDER',
      });
      const rows = await recipients(id);
      expect(rows.every((r) => r.status === 'UNCERTAIN')).toBe(true);
      expect(rows[0]!.lastResponse).toContain('cannot be recalled');
      const audit = await asSystem(() =>
        prisma().auditLog.findFirst({
          where: { entityId: id, action: 'email.campaign.cancelled' },
        }),
      );
      expect(audit?.after).toMatchObject({
        atProvider: true,
        providerStatusBefore: 'queued',
        providerStatusAfter: 'canceled',
        recipientsClosed: 2,
      });
      // Resend had already sent one before the cancel took effect: its report is the truth.
      const sent = await webhook({
        type: 'email.sent',
        created_at: new Date().toISOString(),
        data: {
          broadcast_id: c.providerBroadcastId,
          email_id: randomUUID(),
          message_id: `<${randomUUID()}@news.leadflow-test.example>`,
          to: [emails[0]],
        },
      });
      expect(sent.status).toBe(200);
      const after = await recipients(id);
      expect(after.find((r) => r.email === emails[0])!.status).toBe('ACCEPTED');
      expect(after.find((r) => r.email === emails[1])!.status).toBe('UNCERTAIN');
      const history = await asSystem(() =>
        prisma().leadActivity.count({ where: { leadId: leadIds[0]!, activityType: 'EMAIL_SENT' } }),
      );
      expect(history).toBe(1);
    });

    it('a cancel Resend refuses changes nothing in LeadFlow', async () => {
      resend.deliverOnSend = false;
      const { id } = await confirmedCampaign(1);
      const c = await run(id);
      resend.fault('POST', /^\/broadcasts\/[^/]+\/cancel$/, 500);
      const res = await ctx.http().post(`/api/v1/email/campaigns/${id}/cancel`).set(owner());
      expect(res.status).toBe(409);
      expect(res.body.error.message).toContain('did not cancel');
      expect(resend.broadcasts.get(c.providerBroadcastId!)!.status).toBe('queued');
      expect((await campaign(id))!).toMatchObject({
        status: 'SENDING',
        broadcastState: 'HANDED_OFF',
      });
      expect((await recipients(id)).every((r) => r.status === 'SENDING')).toBe(true);
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

  describe('NEEDS_REVIEW recovery (campaign page)', () => {
    it('the campaign view shows the broadcast state, last provider check, failure reason, Resend id and whether anyone may have the email', async () => {
      const { id, campaign: c } = await inReview(1);
      const b = (await view(id)).broadcast;
      expect(b).toMatchObject({
        state: 'NEEDS_REVIEW',
        needsReview: true,
        providerBroadcastId: c.providerBroadcastId,
        lastProviderStatus: 'draft',
        exposure: 'MAY_HAVE_BEEN_SENT',
        reviews: [],
      });
      expect(b.error).toContain('will not ask again on its own');
      expect(b.lastCheckedAt).not.toBeNull();
      expect(b.sendRequestedAt).not.toBeNull();
      expect(typeof b.version).toBe('number');
    });

    it('safe retry: reads the live status, continues from the confirmed draft once, and leaves an immutable record of who, why, before and after', async () => {
      const { id, campaign: c } = await inReview(1);
      const res = await resolve(id, {
        action: 'retry',
        reason: 'Resend shows a draft; nothing sent',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.broadcast).toMatchObject({ state: 'DRAFT_CREATED', needsReview: false });
      const [row, ...more] = await reviewRows(id);
      expect(more).toHaveLength(0);
      expect(row).toMatchObject({
        action: 'retry',
        reason: 'Resend shows a draft; nothing sent',
        outcome: 'retrying',
        previousState: 'NEEDS_REVIEW',
        previousStatus: 'PAUSED',
        resultingState: 'DRAFT_CREATED',
        resultingStatus: 'SENDING',
        providerStatus: 'draft',
      });
      expect(row!.actorUserId).not.toBeNull();
      expect(res.body.data.broadcast.reviews[0]).toMatchObject({
        outcome: 'retrying',
        actorUserId: row!.actorUserId,
      });
      expect(res.body.data.broadcast.reviews[0].actorName).toBeTruthy();
      const done = await run(id);
      expect(done.broadcastState).toBe('HANDED_OFF');
      expect(sends(c.providerBroadcastId)).toBe(2);
      expect(
        resend.broadcastDeliveries.filter((d) => d.broadcastId === c.providerBroadcastId),
      ).toHaveLength(1);
    });

    it('unsafe retry is rejected: with the live status unreadable nothing changes, and the refusal is recorded', async () => {
      const { id, campaign: c } = await inReview(1);
      resend.fault('GET', /^\/broadcasts\/[^/]+$/, 'network', 1);
      const res = await resolve(id, { action: 'retry', reason: 'Try again' });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toContain('not safe');
      expect((await campaign(id))!).toMatchObject({
        status: 'PAUSED',
        broadcastState: 'NEEDS_REVIEW',
      });
      expect(sends(c.providerBroadcastId)).toBe(1);
      const [row] = await reviewRows(id);
      expect(row).toMatchObject({
        action: 'retry',
        outcome: 'refused',
        previousState: 'NEEDS_REVIEW',
        resultingState: 'NEEDS_REVIEW',
        resultingStatus: 'PAUSED',
      });
      expect(row!.refusal).toContain('not safe');
      const audit = await asSystem(() =>
        prisma().auditLog.findFirst({
          where: { entityId: id, action: 'email.campaign.broadcast_resolve_refused' },
        }),
      );
      expect(audit?.actorUserId).toBe(row!.actorUserId);
    });

    it('abandon: a confirmed draft is never sent; the campaign is cancelled and recipients are cancelled', async () => {
      const { id, campaign: c } = await inReview(2);
      const res = await resolve(id, { action: 'abandon', reason: 'Offer withdrawn' });
      expect(res.status).toBe(200);
      expect((await campaign(id))!).toMatchObject({ status: 'CANCELLED' });
      expect((await recipients(id)).every((r) => r.status === 'CANCELLED')).toBe(true);
      expect(await reviewRows(id)).toMatchObject([
        {
          action: 'abandon',
          outcome: 'abandoned',
          resultingStatus: 'CANCELLED',
          recipientsClosed: 2,
        },
      ]);
      await run(id, new Date(Date.now() + 3_600_000));
      expect(sends(c.providerBroadcastId)).toBe(1);
      expect(
        resend.broadcastDeliveries.filter((d) => d.broadcastId === c.providerBroadcastId),
      ).toHaveLength(0);
    });

    it('a stale page and a repeated click are refused before anything happens', async () => {
      const { id } = await inReview(1);
      const version = (await view(id)).broadcast.version as number;
      const stale = await resolve(id, {
        action: 'abandon',
        reason: 'old page',
        expectedVersion: version - 1,
      });
      expect(stale.status).toBe(409);
      expect(stale.body.error.message).toContain('changed since the page was loaded');
      expect((await campaign(id))!.broadcastState).toBe('NEEDS_REVIEW');

      const first = await resolve(id, {
        action: 'retry',
        reason: 'go ahead',
        expectedVersion: version,
      });
      const again = await resolve(id, {
        action: 'retry',
        reason: 'go ahead',
        expectedVersion: version,
      });
      expect([first.status, again.status]).toEqual([200, 409]);
      expect((await reviewRows(id)).map((r) => r.outcome)).toEqual([
        'refused',
        'retrying',
        'refused',
      ]);
    });

    it('two operators deciding at the same moment: exactly one decision applies, the other is refused', async () => {
      const { id, campaign: c } = await inReview(1);
      const version = (await view(id)).broadcast.version as number;
      const results = await Promise.all([
        resolve(id, { action: 'retry', reason: 'operator 1', expectedVersion: version }),
        resolve(id, { action: 'abandon', reason: 'operator 2', expectedVersion: version }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const rows = await reviewRows(id);
      expect(rows.filter((r) => r.outcome !== 'refused')).toHaveLength(1);
      expect(rows.filter((r) => r.outcome === 'refused')).toHaveLength(1);
      const winner = rows.find((r) => r.outcome !== 'refused')!;
      expect((await campaign(id))!.status).toBe(winner.resultingStatus);
      await run(id);
      expect(sends(c.providerBroadcastId)).toBeLessThanOrEqual(2);
      expect(
        resend.broadcastDeliveries.filter((d) => d.broadcastId === c.providerBroadcastId).length,
      ).toBeLessThanOrEqual(1);
    });

    it('only organisation administrators may decide: a sales rep is refused by the server', async () => {
      const { id } = await inReview(1);
      const version = (await view(id)).broadcast.version as number;
      const rep = auth(ctx.orgA.rep.accessToken);
      const res = await resolve(
        id,
        { action: 'abandon', reason: 'rep', expectedVersion: version },
        rep,
      );
      expect(res.status).toBe(403);
      expect((await campaign(id))!.broadcastState).toBe('NEEDS_REVIEW');
      expect(await reviewRows(id)).toHaveLength(0);
    });

    it('another organisation cannot see or decide this broadcast, and cannot read its review history', async () => {
      const { id } = await inReview(1);
      const version = (await view(id)).broadcast.version as number;
      expect((await resolve(id, { action: 'retry', reason: 'mine' })).status).toBe(200);
      const other = auth(ctx.orgB.owner.accessToken);
      expect((await ctx.http().get(`/api/v1/email/campaigns/${id}`).set(other)).status).toBe(404);
      const res = await resolve(
        id,
        { action: 'abandon', reason: 'not mine', expectedVersion: version + 1 },
        other,
      );
      expect(res.status).toBe(404);
      expect((await campaign(id))!.broadcastState).toBe('DRAFT_CREATED');
      const seenByB = await ctx.app
        .get(TenantContextService)
        .runForOrganization(ctx.orgB.id, 'e2e', () =>
          prisma().emailBroadcastReview.findMany({ where: { campaignId: id } }),
        );
      expect(seenByB).toEqual([]);
      expect(await reviewRows(id)).toHaveLength(1);
    });

    it('the review record is append-only: the database refuses to change or delete it', async () => {
      const { id } = await inReview(1);
      await resolve(id, { action: 'abandon', reason: 'append-only check' });
      await expect(
        asSystem(() =>
          prisma().emailBroadcastReview.updateMany({
            where: { campaignId: id },
            data: { reason: 'rewritten' },
          }),
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        asSystem(() => prisma().emailBroadcastReview.deleteMany({ where: { campaignId: id } })),
      ).rejects.toThrow(/append-only/);
      // (The row being unchanged afterwards is verified on PostgreSQL 17; the in-process test
      // server drops its connection after a trigger error, so it is not re-read here.)
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
      const bView = await ctx.http().put('/api/v1/email/mailbox/provider').set(bOwner).send({
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

  describe('test emails through Resend', () => {
    /** The two email switches as given (undefined = not set), for what the service reads per request. */
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
    const draftCampaign = async () => {
      const res = await ctx
        .http()
        .post('/api/v1/email/campaigns')
        .set(owner())
        .send({
          name: `Test send ${tag()}`,
          category: 'PROMOTIONAL_OFFER',
          purpose: 'PROMOTIONAL',
          subject: 'Our new catalogue',
          html: '<p>Dear {{first_name}}</p>',
          filter: { cities: [tag()] },
        });
      expect(res.status).toBe(201);
      return res.body.data.id as string;
    };
    const testSend = (id: string) => {
      ctx.redis.flush(); // the route allows 5 a minute; these tests are about the switches
      return ctx.http().post(`/api/v1/email/campaigns/${id}/test`).set(owner()).send({});
    };
    const resendCalls = () => resend.log.length;

    it.each([
      ['dispatch off, sending off', false, false],
      ['dispatch on, sending off', true, false],
      ['dispatch off, sending on', false, true],
      ['both unset', undefined, undefined],
    ])('are refused with %s — no Resend request at all', async (_label, dispatch, sending) => {
      const id = await draftCampaign();
      const before = resendCalls();
      const emails = resend.emails.length;
      const res = await withSwitches(dispatch, sending, () => testSend(id));
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Test emails are switched off');
      expect(resendCalls()).toBe(before);
      expect(resend.emails).toHaveLength(emails);
    });

    it('with both switches on, one [TEST] email goes to the signed-in user through the marketing key', async () => {
      const id = await draftCampaign();
      const emails = resend.emails.length;
      const res = await withSwitches(true, true, () => testSend(id));
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ sentTo: ctx.orgA.owner.email, accepted: true });
      expect(resend.emails).toHaveLength(emails + 1);
      const sent = resend.emails[resend.emails.length - 1]!;
      expect(sent.to.toLowerCase()).toBe(ctx.orgA.owner.email.toLowerCase());
      expect(String(sent.body['subject'])).toContain('[TEST]');
      expect(resend.log[resend.log.length - 1]!.auth).toBe(`Bearer ${MARKETING_KEY}`);
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
