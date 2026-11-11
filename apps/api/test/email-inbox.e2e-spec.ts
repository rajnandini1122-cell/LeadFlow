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
import { InboxSyncService } from '../src/modules/campaigns/inbox/inbox-sync.service';

/**
 * Replies and bounces, read from the organization's inbox over IMAP.
 *
 *   the mailbox is only ever opened read-only;
 *   the first run starts from now — history is not imported;
 *   a reply to one of OUR messages lands on that lead's history (text only)
 *   and prompts its owner to follow up; anything else is attached to nobody;
 *   a bounce report fails the recipient and suppresses the address;
 *   reading the same messages again — after a crash — adds nothing twice.
 */
describe('Email inbox: replies and bounces', () => {
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
  /**
   * This organization's inbox only. Suites share one database in CI, and
   * syncAll would also visit mailboxes other suites left behind.
   */
  const sync = async () => {
    const report = { mailboxes: 0, read: 0, replies: 0, bounces: 0, other: 0, errors: 0 };
    await ctx.app
      .get(TenantContextService)
      .runForOrganization(ctx.orgA.id, 'e2e inbox sync', () =>
        ctx.app.get(InboxSyncService).syncOne(new Date(), report),
      );
    return report;
  };
  let nextUid = 1;
  const deliver = (lines: string[]) =>
    imap.messages.push({ uid: nextUid++, source: lines.join('\r\n') });

  let campaignId: string;
  const sent: { email: string; leadId: string; messageId: string }[] = [];

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
    expect(
      (await ctx.http().patch('/api/v1/email/mailbox/sending').set(owner()).send({ enabled: true }))
        .status,
    ).toBe(200);

    // A campaign to two leads, actually sent through the fake SMTP server.
    const city = `Inbox${Date.now()}`;
    for (const name of ['reply', 'bounce']) {
      const email = `${name}.${city}@cust.example`.toLowerCase();
      const res = await ctx
        .http()
        .post('/api/v1/leads')
        .set(owner())
        .send({
          firstName: name,
          lastName: 'Customer',
          mobile: fixtureMobile(),
          email,
          city,
          source: 'Website',
          nextFollowUpAt: new Date(Date.now() + 86_400_000).toISOString(),
        });
      expect(res.status).toBe(201);
      sent.push({ email, leadId: res.body.data.id, messageId: '' });
    }
    await ctx
      .http()
      .post('/api/v1/email/eligibility/grant')
      .set(owner())
      .send({
        emails: sent.map((s) => s.email),
        basis: 'CONSENT',
        note: 'Asked for the catalogue',
      });
    const draft = await ctx
      .http()
      .post('/api/v1/email/campaigns')
      .set(owner())
      .send({
        name: 'Catalogue',
        category: 'PRODUCT_CATALOGUE',
        purpose: 'PROMOTIONAL',
        subject: 'Our catalogue',
        html: '<p>Hello {{first_name}}</p>',
        filter: { cities: [city] },
      });
    campaignId = draft.body.data.id;
    expect(
      (
        await ctx
          .http()
          .post(`/api/v1/email/campaigns/${campaignId}/confirm`)
          .set(owner())
          .send({ submitKey: randomUUID().replace(/-/g, ''), eligibleCount: 2 })
      ).status,
    ).toBe(200);
    expect((await ctx.app.get(EmailDispatcher).tick()).accepted).toBe(2);
    const rows = await asSystem(() =>
      prisma().emailCampaignRecipient.findMany({ where: { campaignId } }),
    );
    for (const s of sent) s.messageId = rows.find((r) => r.email === s.email)!.messageId;
  });

  afterAll(async () => {
    await smtp?.close();
    await imap?.close();
    await ctx?.close();
    restoreEmailCampaignsEnv();
  });

  const history = (leadId: string) =>
    asSystem(() =>
      prisma().leadActivity.findMany({
        where: { leadId, activityType: { in: ['EMAIL_REPLY_RECEIVED', 'EMAIL_FAILED'] } },
      }),
    );

  it('the first run starts from now: mail already in the inbox is not imported', async () => {
    deliver([
      'From: someone@else.example',
      'Subject: Old mail',
      `In-Reply-To: ${sent[0]!.messageId}`,
      '',
      'Old, from before LeadFlow was connected',
    ]);
    const report = await sync();
    expect(report).toMatchObject({ mailboxes: 1, read: 0, errors: 0 });
    expect(await history(sent[0]!.leadId)).toHaveLength(0);
  });

  it('a reply to our message lands on that lead’s history — as text — and asks its owner to follow up; other mail is attached to nobody', async () => {
    deliver([
      `From: Reply Customer <${sent[0]!.email}>`,
      `To: ${SENDER}`,
      'Subject: Re: Our catalogue',
      `Message-ID: <${randomUUID()}@cust.example>`,
      `In-Reply-To: ${sent[0]!.messageId}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Please send prices for 500 units.</p><script>steal()</script>',
    ]);
    deliver([
      'From: newsletter@vendor.example',
      'Subject: Weekly news',
      `Message-ID: <${randomUUID()}@vendor.example>`,
      '',
      'Unrelated',
    ]);

    const report = await sync();
    expect(report).toMatchObject({ read: 2, replies: 1, other: 1, errors: 0 });

    const [activity] = await history(sent[0]!.leadId);
    expect(activity).toMatchObject({ activityType: 'EMAIL_REPLY_RECEIVED' });
    expect(activity!.description).toContain('Please send prices for 500 units.');
    expect(activity!.description).not.toMatch(/<script|<p>/);
    expect(activity!.metadata).toMatchObject({ campaignId, suggestFollowUp: true });

    const recipient = await asSystem(() =>
      prisma().emailCampaignRecipient.findFirst({ where: { campaignId, email: sent[0]!.email } }),
    );
    expect(recipient!.repliedAt).not.toBeNull();

    const lead = await asSystem(() =>
      prisma().lead.findUnique({ where: { id: sent[0]!.leadId }, select: { assignedToId: true } }),
    );
    if (lead!.assignedToId) {
      const notes = await asSystem(() =>
        prisma().notification.findMany({
          where: { userId: lead!.assignedToId!, type: 'EMAIL_REPLY_RECEIVED' },
        }),
      );
      expect(notes).toHaveLength(1);
    }

    const replies = await ctx
      .http()
      .get(`/api/v1/email/campaigns/${campaignId}/replies`)
      .set(owner());
    expect(replies.body.data).toEqual([
      expect.objectContaining({
        leadId: sent[0]!.leadId,
        snippet: expect.stringContaining('500 units'),
      }),
    ]);
    const report2 = (await ctx.http().get(`/api/v1/email/campaigns/${campaignId}`).set(owner()))
      .body.data.counts;
    expect(report2).toMatchObject({ replies: 1, accepted: 2 });
  });

  it('a bounce report fails the recipient, suppresses the address and says so on the lead', async () => {
    const boundary = 'B0UND';
    deliver([
      'From: Mail Delivery System <MAILER-DAEMON@mx.cust.example>',
      `To: ${SENDER}`,
      'Subject: Undelivered Mail Returned to Sender',
      `Message-ID: <${randomUUID()}@mx.cust.example>`,
      `Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain',
      '',
      'Delivery failed.',
      `--${boundary}`,
      'Content-Type: message/delivery-status',
      '',
      `Final-Recipient: rfc822; ${sent[1]!.email}`,
      'Action: failed',
      'Status: 5.1.1',
      'Diagnostic-Code: smtp; 550 5.1.1 Mailbox does not exist',
      `--${boundary}`,
      'Content-Type: text/rfc822-headers',
      '',
      `Message-ID: ${sent[1]!.messageId}`,
      `--${boundary}--`,
    ]);
    expect(await sync()).toMatchObject({ bounces: 1, errors: 0 });
    const recipient = await asSystem(() =>
      prisma().emailCampaignRecipient.findFirst({ where: { campaignId, email: sent[1]!.email } }),
    );
    expect(recipient).toMatchObject({ status: 'FAILED' });
    expect(recipient!.lastResponse).toContain('5.1.1');
    expect(
      await asSystem(() =>
        prisma().emailSuppression.findFirst({ where: { email: sent[1]!.email } }),
      ),
    ).toMatchObject({ reason: 'BOUNCED' });
    expect((await history(sent[1]!.leadId))[0]).toMatchObject({
      activityType: 'EMAIL_FAILED',
      description: expect.stringContaining('bounced'),
    });
  });

  it('reading everything again after a crash adds nothing twice', async () => {
    const before =
      (await history(sent[0]!.leadId)).length + (await history(sent[1]!.leadId)).length;
    // The saved position is lost: the next run re-reads messages it already handled.
    await asSystem(() =>
      prisma().emailMailbox.updateMany({
        where: { organizationId: ctx.orgA.id },
        data: { imapLastUid: 1n },
      }),
    );
    const report = await sync();
    expect(report.errors).toBe(0);
    const after = (await history(sent[0]!.leadId)).length + (await history(sent[1]!.leadId)).length;
    expect(after).toBe(before);
  });

  it('never changes anything in the mailbox', () => {
    expect(imap.commands.some((c) => / EXAMINE INBOX/i.test(c))).toBe(true);
    expect(
      imap.commands.some((c) =>
        / (SELECT|STORE|EXPUNGE|DELETE|APPEND|COPY|MOVE|CREATE|RENAME)\b/i.test(c),
      ),
    ).toBe(false);
    expect(imap.commands.join('\n')).not.toContain(PASSWORD);
  });

  it('a renumbered folder (new UIDVALIDITY) restarts from now without reprocessing', async () => {
    imap.uidValidity = 99;
    deliver([
      'From: x@y.example',
      'Subject: after renumbering',
      `In-Reply-To: ${sent[0]!.messageId}`,
      '',
      'hello',
    ]);
    const before = (await history(sent[0]!.leadId)).length;
    expect(await sync()).toMatchObject({ read: 0, errors: 0 });
    expect((await history(sent[0]!.leadId)).length).toBe(before);
  });

  it('another organization’s data is untouched', async () => {
    expect(
      await asSystem(() =>
        prisma().emailInboundMessage.count({ where: { organizationId: ctx.orgB.id } }),
      ),
    ).toBe(0);
  });
});
