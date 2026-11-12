import { createTestContext, type TestContext } from './helpers/test-app';
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

/**
 * Email Settings: the organization's own mailbox.
 *
 *   only Owner/Admin may see or change it;
 *   the password goes in and never comes out — not in a response, not in the
 *   database in plaintext, not in the audit log;
 *   hosts that resolve into a private network are refused;
 *   connection tests prove TLS + sign-in and change nothing (no mail sent, the
 *   inbox opened read-only);
 *   changing where or as whom LeadFlow connects switches the mailbox off until
 *   both connections are tested again.
 */
describe('Email settings (mailbox)', () => {
  let ctx: TestContext;
  let tls: TestCertificate;
  let smtp: FakeSmtp;
  let imap: FakeImap;
  const PASSWORD = 'Mailbox-Secret-2026!';
  const USER = 'sales@leadflow-test.example';

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const owner = () => auth(ctx.orgA.owner.accessToken);
  const prisma = () => ctx.app.get(PrismaService).client;
  const asSystem = <T>(run: () => Promise<T>) =>
    ctx.app.get(TenantContextService).runAsSystem('e2e', run);

  const settings = (over: Record<string, unknown> = {}) => ({
    emailAddress: USER,
    description: 'Sales inbox',
    imapHost: TEST_MAIL_HOST,
    imapPort: 993,
    imapSecurity: 'SSL_TLS',
    smtpHost: TEST_MAIL_HOST,
    smtpPort: 465,
    smtpSecurity: 'SSL_TLS',
    password: PASSWORD,
    ...over,
  });
  const save = (body: Record<string, unknown>, headers = owner()) =>
    ctx.http().put('/api/v1/email/mailbox').set(headers).send(body);

  beforeAll(async () => {
    ctx = await createTestContext();
    tls = generateTestCertificate();
    smtp = await startFakeSmtp(tls, { user: USER, pass: PASSWORD });
    imap = await startFakeImap(tls, { user: USER, pass: PASSWORD });
    ctx.app.get(MailboxService).useConnectionDeps({
      resolveHost: async () => '127.0.0.1',
      testPorts: { smtp: smtp.port, imap: imap.port },
      testCa: tls.cert,
    });
  });

  afterAll(async () => {
    await smtp?.close();
    await imap?.close();
    await ctx?.close();
  });

  it('starts unconfigured, with sending switched off on the platform', async () => {
    const res = await ctx.http().get('/api/v1/email/mailbox').set(owner());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      configured: false,
      enabled: false,
      passwordSet: false,
      platform: { sendingEnabled: false },
    });
  });

  it('is Owner/Admin only', async () => {
    const rep = auth(ctx.orgA.rep.accessToken);
    expect((await ctx.http().get('/api/v1/email/mailbox').set(rep)).status).toBe(403);
    expect((await save(settings(), rep)).status).toBe(403);
    expect((await ctx.http().post('/api/v1/email/mailbox/test/smtp').set(rep)).status).toBe(403);
  });

  it('requires a password on the first save', async () => {
    const res = await save(settings({ password: undefined }));
    expect(res.status).toBe(400);
  });

  it.each([
    ['localhost', 400],
    ['127.0.0.1', 400],
    ['postgres-17.railway.internal', 400],
    ['169.254.169.254', 400],
    ['mail.example.com:25', 400],
  ])('refuses SMTP host %s', async (smtpHost, status) => {
    expect((await save(settings({ smtpHost }))).status).toBe(status);
  });

  it('refuses a port that contradicts the secure connection type, and plaintext ports', async () => {
    expect((await save(settings({ smtpPort: 587, smtpSecurity: 'SSL_TLS' }))).status).toBe(400);
    expect((await save(settings({ imapPort: 143, imapSecurity: 'SSL_TLS' }))).status).toBe(400);
    expect((await save(settings({ smtpPort: 25 }))).status).toBe(400);
    expect((await save(settings({ imapSecurity: 'NONE' }))).status).toBe(400);
  });

  it('saves the account; the password is sealed and never returned', async () => {
    const res = await save(settings());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      configured: true,
      emailAddress: USER,
      username: USER,
      imapHost: TEST_MAIL_HOST,
      imapPort: 993,
      smtpPort: 465,
      passwordSet: true,
      enabled: false,
    });
    expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
    expect(Object.keys(res.body.data)).not.toContain('password');
    expect(Object.keys(res.body.data)).not.toContain('encryptedPassword');

    const row = await asSystem(() =>
      prisma().emailMailbox.findFirst({ where: { organizationId: ctx.orgA.id } }),
    );
    expect(row!.encryptedPassword.startsWith('v1.')).toBe(true);
    expect(row!.encryptedPassword).not.toContain(PASSWORD);

    const audit = await asSystem(() =>
      prisma().auditLog.findMany({
        where: { organizationId: ctx.orgA.id, action: { startsWith: 'email.mailbox' } },
      }),
    );
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain(PASSWORD);
    expect(JSON.stringify(audit)).toContain('"password":"changed"');
  });

  it('cannot be turned on before both connections have been tested', async () => {
    const res = await ctx
      .http()
      .patch('/api/v1/email/mailbox/sending')
      .set(owner())
      .send({ enabled: true });
    expect(res.status).toBe(400);
  });

  it('tests SMTP over verified TLS with sign-in, and sends no email', async () => {
    const res = await ctx.http().post('/api/v1/email/mailbox/test/smtp').set(owner());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ ok: true });
    expect(smtp.logins).toBe(1);
    expect(smtp.messages).toHaveLength(0);
  });

  it('tests IMAP: signs in and opens the inbox READ-ONLY, issuing no command that changes anything', async () => {
    const res = await ctx.http().post('/api/v1/email/mailbox/test/imap').set(owner());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ ok: true });
    expect(imap.logins).toBe(1);
    expect(imap.commands.some((c) => / EXAMINE /i.test(c))).toBe(true);
    expect(
      imap.commands.some((c) =>
        / (SELECT|STORE|EXPUNGE|DELETE|APPEND|COPY|MOVE|CREATE|RENAME) /i.test(c),
      ),
    ).toBe(false);
    expect(imap.commands.join('\n')).not.toContain(PASSWORD);
  });

  it('can be turned on once both tests passed, with limits', async () => {
    const res = await ctx
      .http()
      .patch('/api/v1/email/mailbox/sending')
      .set(owner())
      .send({ enabled: true, hourlyLimit: 40, dailyLimit: 200 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ enabled: true, hourlyLimit: 40, dailyLimit: 200 });
    expect(
      (
        await ctx
          .http()
          .patch('/api/v1/email/mailbox/sending')
          .set(owner())
          .send({ hourlyLimit: 500, dailyLimit: 100 })
      ).status,
    ).toBe(400);
  });

  it('a wrong password fails the test with a safe message', async () => {
    expect((await save(settings({ password: 'wrong-password-123' }))).status).toBe(200);
    const res = await ctx.http().post('/api/v1/email/mailbox/test/smtp').set(owner());
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.message).toContain('rejected the username or password');
    expect(res.body.data.message).not.toContain('wrong-password-123');
    const imapRes = await ctx.http().post('/api/v1/email/mailbox/test/imap').set(owner());
    expect(imapRes.body.data.ok).toBe(false);
  });

  it('changing the password switched sending off and forgot the old test results', async () => {
    const view = (await ctx.http().get('/api/v1/email/mailbox').set(owner())).body.data;
    expect(view.enabled).toBe(false);
    expect(view.smtp.okAt).toBeNull();
    expect(view.imap.okAt).toBeNull();
    expect(view.smtp.error).toContain('username or password');
  });

  it('keeps the stored password when an update leaves it out', async () => {
    expect((await save(settings())).status).toBe(200); // correct password again
    expect((await save(settings({ password: undefined, description: 'Renamed' }))).status).toBe(
      200,
    );
    const res = await ctx.http().post('/api/v1/email/mailbox/test/smtp').set(owner());
    expect(res.body.data.ok).toBe(true);
  });

  it('refuses a certificate that does not match the hostname', async () => {
    expect(
      (await save(settings({ smtpHost: 'other.leadflow-test.example', password: undefined })))
        .status,
    ).toBe(200);
    const res = await ctx.http().post('/api/v1/email/mailbox/test/smtp').set(owner());
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.message).toContain('certificate');
    expect((await save(settings({ password: undefined }))).status).toBe(200);
  });

  it('another organization sees nothing of it', async () => {
    const res = await ctx.http().get('/api/v1/email/mailbox').set(auth(ctx.orgB.owner.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data.configured).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(USER);
  });
});
