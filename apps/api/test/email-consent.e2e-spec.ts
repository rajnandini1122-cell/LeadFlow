import { randomUUID } from 'node:crypto';
import { createTestContext, type TestContext } from './helpers/test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { createUnsubscribeToken } from '../src/modules/campaigns/consent/unsubscribe-token';

/**
 * Marketing eligibility, suppression, unsubscribe, templates and attachments.
 *
 *   nobody is eligible until a person records why — not existing leads, not imports;
 *   an unsubscribe or complaint can never be overridden by an administrator;
 *   unsubscribing needs no login, a GET changes nothing, and a POST is idempotent;
 *   another organization's tokens, templates and files are unreachable;
 *   template HTML is sanitized on the server, and unknown merge fields are refused;
 *   attachments are checked by their bytes, not their names.
 */
describe('Email consent, unsubscribe, templates and attachments', () => {
  let ctx: TestContext;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const owner = () => auth(ctx.orgA.owner.accessToken);
  const rep = () => auth(ctx.orgA.rep.accessToken);
  const prisma = () => ctx.app.get(PrismaService).client;
  const asSystem = <T>(run: () => Promise<T>) =>
    ctx.app.get(TenantContextService).runAsSystem('e2e', run);
  const unique = (prefix: string) =>
    `${prefix}.${Date.now()}${Math.floor(Math.random() * 1e6)}@customer-test.example`;

  /** A queued campaign recipient, created the way the campaign service will, returning its raw token. */
  const recipient = async (organizationId: string, email: string) => {
    const { token, hash } = createUnsubscribeToken();
    await asSystem(async () => {
      const campaign = await prisma().emailCampaign.create({
        data: {
          organizationId,
          name: 'Seed',
          category: 'CUSTOM',
          purpose: 'PROMOTIONAL',
          status: 'SENDING',
          subject: 's',
          html: '<p>x</p>',
          text: 'x',
        },
      });
      await prisma().emailCampaignRecipient.create({
        data: {
          organizationId,
          campaignId: campaign.id,
          email,
          messageId: `<${randomUUID()}@test>`,
          unsubscribeTokenHash: hash,
        },
      });
    });
    return token;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx?.close();
  });

  describe('eligibility', () => {
    it('existing lead addresses are listed as UNKNOWN — not eligible — until someone records why', async () => {
      const email = unique('lead');
      await asSystem(() =>
        prisma().lead.update({ where: { id: ctx.orgA.leadId }, data: { email } }),
      );
      const res = await ctx
        .http()
        .get('/api/v1/email/eligibility')
        .query({ search: email })
        .set(owner());
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        expect.objectContaining({ email, status: 'UNKNOWN', sources: ['LEAD'], suppressed: null }),
      ]);
    });

    it('granting needs a basis and evidence, and is Owner/Admin only', async () => {
      const email = unique('grant');
      expect(
        (
          await ctx
            .http()
            .post('/api/v1/email/eligibility/grant')
            .set(owner())
            .send({ emails: [email], basis: 'CONSENT' })
        ).status,
      ).toBe(400);
      expect(
        (
          await ctx
            .http()
            .post('/api/v1/email/eligibility/grant')
            .set(owner())
            .send({ emails: [email], basis: 'VIBES', note: 'Signed up at expo' })
        ).status,
      ).toBe(400);
      expect(
        (
          await ctx
            .http()
            .post('/api/v1/email/eligibility/grant')
            .set(rep())
            .send({ emails: [email], basis: 'CONSENT', note: 'Signed up at expo' })
        ).status,
      ).toBe(403);
      const ok = await ctx
        .http()
        .post('/api/v1/email/eligibility/grant')
        .set(owner())
        .send({ emails: [email.toUpperCase()], basis: 'CONSENT', note: 'Signed up at expo stand' });
      expect(ok.status).toBe(200);
      expect(ok.body.data.granted).toEqual([email]);
      const row = await asSystem(() =>
        prisma().marketingConsent.findFirst({ where: { organizationId: ctx.orgA.id, email } }),
      );
      expect(row).toMatchObject({
        status: 'GRANTED',
        basis: 'CONSENT',
        note: 'Signed up at expo stand',
        recordedBy: ctx.orgA.owner.id,
      });
    });

    it('refuses addresses that are not single, plain addresses', async () => {
      const res = await ctx
        .http()
        .post('/api/v1/email/eligibility/grant')
        .set(owner())
        .send({
          emails: ['a@x.example, b@y.example'],
          basis: 'CONSENT',
          note: 'Signed up at expo',
        });
      expect(res.status).toBe(400);
    });

    it('withdrawing makes an address ineligible again', async () => {
      const email = unique('withdraw');
      await ctx
        .http()
        .post('/api/v1/email/eligibility/grant')
        .set(owner())
        .send({ emails: [email], basis: 'EXISTING_CUSTOMER', note: 'Bought in 2025' });
      expect(
        (
          await ctx
            .http()
            .post('/api/v1/email/eligibility/withdraw')
            .set(owner())
            .send({ emails: [email] })
        ).status,
      ).toBe(200);
      const row = await asSystem(() =>
        prisma().marketingConsent.findFirst({ where: { organizationId: ctx.orgA.id, email } }),
      );
      expect(row!.status).toBe('WITHDRAWN');
    });
  });

  describe('unsubscribe (public)', () => {
    it('GET shows the organization and changes nothing — a link scanner cannot unsubscribe anyone', async () => {
      const email = unique('scan');
      const token = await recipient(ctx.orgA.id, email);
      const res = await ctx.http().get(`/api/v1/email/unsubscribe/${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        organizationName: ctx.orgA.name,
        alreadyUnsubscribed: false,
      });
      expect(JSON.stringify(res.body)).not.toContain(email);
      expect(await asSystem(() => prisma().emailSuppression.count({ where: { email } }))).toBe(0);
    });

    it('POST unsubscribes without a login: suppressed, consent withdrawn, queued mail to them skipped; repeat is harmless', async () => {
      const email = unique('unsub');
      await ctx
        .http()
        .post('/api/v1/email/eligibility/grant')
        .set(owner())
        .send({ emails: [email], basis: 'CONSENT', note: 'Newsletter signup' });
      const token = await recipient(ctx.orgA.id, email);
      // A second campaign still queued for the same person.
      await recipient(ctx.orgA.id, email);

      const first = await ctx
        .http()
        .post(`/api/v1/email/unsubscribe/${token}`)
        .type('form')
        .send('List-Unsubscribe=One-Click');
      expect(first.status).toBe(200);
      expect(first.body.data.alreadyUnsubscribed).toBe(true);
      const second = await ctx.http().post(`/api/v1/email/unsubscribe/${token}`);
      expect(second.status).toBe(200);

      const [suppression, consent, queued] = await asSystem(() =>
        Promise.all([
          prisma().emailSuppression.findMany({ where: { email } }),
          prisma().marketingConsent.findFirst({ where: { email } }),
          prisma().emailCampaignRecipient.findMany({
            where: { email },
            select: { status: true, unsubscribedAt: true },
          }),
        ]),
      );
      expect(suppression).toEqual([
        expect.objectContaining({ organizationId: ctx.orgA.id, reason: 'UNSUBSCRIBED' }),
      ]);
      expect(consent!.status).toBe('WITHDRAWN');
      expect(queued.every((r) => r.status === 'SKIPPED')).toBe(true);
    });

    it('an administrator cannot re-grant or un-suppress someone who unsubscribed', async () => {
      const email = unique('regrant');
      const token = await recipient(ctx.orgA.id, email);
      await ctx.http().post(`/api/v1/email/unsubscribe/${token}`);
      const grant = await ctx
        .http()
        .post('/api/v1/email/eligibility/grant')
        .set(owner())
        .send({ emails: [email], basis: 'CONSENT', note: 'They said yes on the phone' });
      expect(grant.body.data).toEqual({
        granted: [],
        refused: [{ email, reason: 'unsubscribed' }],
      });
      expect(
        (
          await ctx
            .http()
            .post('/api/v1/email/suppressions/remove')
            .set(owner())
            .send({ email, note: 'Please re-add' })
        ).status,
      ).toBe(400);
    });

    it('unsubscribing in one organization does not touch another', async () => {
      const email = unique('cross');
      const tokenB = await recipient(ctx.orgB.id, email);
      await ctx.http().post(`/api/v1/email/unsubscribe/${tokenB}`);
      const inA = await asSystem(() =>
        prisma().emailSuppression.count({ where: { organizationId: ctx.orgA.id, email } }),
      );
      const inB = await asSystem(() =>
        prisma().emailSuppression.count({ where: { organizationId: ctx.orgB.id, email } }),
      );
      expect([inA, inB]).toEqual([0, 1]);
    });

    it.each(['not-a-token', 'A'.repeat(43), '../../etc/passwd'])(
      'an unknown or malformed token is a plain 404: %s',
      async (token) => {
        expect(
          (await ctx.http().get(`/api/v1/email/unsubscribe/${encodeURIComponent(token)}`)).status,
        ).toBe(404);
        expect(
          (await ctx.http().post(`/api/v1/email/unsubscribe/${encodeURIComponent(token)}`)).status,
        ).toBe(404);
      },
    );
  });

  describe('manual suppression', () => {
    it('suppresses and can lift a MANUAL suppression with a reason', async () => {
      const email = unique('manual');
      expect(
        (
          await ctx
            .http()
            .post('/api/v1/email/suppressions')
            .set(owner())
            .send({ emails: [email], note: 'Asked us by phone' })
        ).status,
      ).toBe(200);
      const list = await ctx.http().get('/api/v1/email/suppressions').set(owner());
      expect(list.body.data).toEqual(
        expect.arrayContaining([expect.objectContaining({ email, reason: 'MANUAL' })]),
      );
      expect(
        (
          await ctx
            .http()
            .post('/api/v1/email/suppressions/remove')
            .set(owner())
            .send({ email, note: 'Added by mistake' })
        ).status,
      ).toBe(204);
    });
  });

  describe('templates', () => {
    it('sanitizes HTML on the server and derives the plain-text part', async () => {
      const res = await ctx
        .http()
        .post('/api/v1/email/templates')
        .set(rep())
        .send({
          name: 'Diwali offer',
          category: 'PROMOTIONAL_OFFER',
          subject: 'Offer for {{company}}',
          html: '<p onclick="x()">Hi {{first_name}}</p><script>steal()</script><img src="https://cdn.example.com/a.png">',
        });
      expect(res.status).toBe(403); // Sales reps view campaigns only through their manager
      const ok = await ctx
        .http()
        .post('/api/v1/email/templates')
        .set(owner())
        .send({
          name: 'Diwali offer',
          category: 'PROMOTIONAL_OFFER',
          subject: 'Offer for {{company}}',
          html: '<p onclick="x()">Hi {{first_name}}</p><script>steal()</script><img src="https://cdn.example.com/a.png">',
        });
      expect(ok.status).toBe(201);
      expect(ok.body.data.html).toBe(
        '<p>Hi {{first_name}}</p><img src="https://cdn.example.com/a.png" />',
      );
      expect(ok.body.data.text).toBe('Hi {{first_name}}');
    });

    it('refuses unknown merge fields and multi-line subjects', async () => {
      const unknown = await ctx
        .http()
        .post('/api/v1/email/templates')
        .set(owner())
        .send({ name: 'Bad', category: 'CUSTOM', subject: 'Hi', html: '<p>{{password}}</p>' });
      expect(unknown.status).toBe(400);
      expect(JSON.stringify(unknown.body)).toContain('{{password}}');
      const header = await ctx
        .http()
        .post('/api/v1/email/templates')
        .set(owner())
        .send({
          name: 'Bad',
          category: 'CUSTOM',
          subject: 'Hi\r\nBcc: x@y.example',
          html: '<p>x</p>',
        });
      expect(header.status).toBe(400);
    });

    it('another organization cannot see or edit them', async () => {
      const created = await ctx
        .http()
        .post('/api/v1/email/templates')
        .set(owner())
        .send({
          name: 'Private',
          category: 'CUSTOM',
          subject: 'Private note',
          html: '<p>A only</p>',
        });
      const otherOwner = auth(ctx.orgB.owner.accessToken);
      const list = await ctx.http().get('/api/v1/email/templates').set(otherOwner);
      expect(JSON.stringify(list.body)).not.toContain('A only');
      const edit = await ctx
        .http()
        .put(`/api/v1/email/templates/${created.body.data.id}`)
        .set(otherOwner)
        .send({ name: 'Hijack', category: 'CUSTOM', subject: 'Hijacked', html: '<p>B</p>' });
      expect(edit.status).toBe(404);
    });
  });

  describe('attachments', () => {
    const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

    it('accepts a PDF by its bytes and stores it under a safe name', async () => {
      const res = await ctx
        .http()
        .post('/api/v1/email/assets')
        .set(owner())
        .attach('file', PDF, '../../Catalogue 2026.pdf');
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ mimeType: 'application/pdf', sizeBytes: PDF.length });
      expect(res.body.data.fileName).not.toContain('/');
    });

    it('refuses a disguised file and anything that is not PDF/PNG/JPEG', async () => {
      const fake = await ctx
        .http()
        .post('/api/v1/email/assets')
        .set(owner())
        .attach('file', Buffer.from('<script>alert(1)</script>'), 'catalogue.pdf');
      expect(fake.status).toBe(400);
    });

    it('another organization cannot see or delete them', async () => {
      const created = await ctx
        .http()
        .post('/api/v1/email/assets')
        .set(owner())
        .attach('file', PDF, 'a-only.pdf');
      const otherOwner = auth(ctx.orgB.owner.accessToken);
      expect(
        JSON.stringify((await ctx.http().get('/api/v1/email/assets').set(otherOwner)).body),
      ).not.toContain('a-only');
      expect(
        (await ctx.http().delete(`/api/v1/email/assets/${created.body.data.id}`).set(otherOwner))
          .status,
      ).toBe(404);
    });
  });
});
