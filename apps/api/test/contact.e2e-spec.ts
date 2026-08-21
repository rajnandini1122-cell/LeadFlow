import { ThrottlerStorage } from '@nestjs/throttler';
import { createTestContext, type TestContext } from './helpers/test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';

/**
 * The public contact form.
 *
 * This is the only unauthenticated WRITE in the application, and it causes mail
 * to be sent from our domain on behalf of a stranger. That combination is what
 * every case below is really about: it must accept a genuine enquiry, refuse
 * rubbish, never let the caller choose who the mail goes to, and never lose an
 * enquiry just because the mail provider had a bad day.
 */
describe('Contact form', () => {
  let ctx: TestContext;

  const unique = (prefix: string): string =>
    `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`;

  const enquiry = (overrides: Record<string, unknown> = {}) => ({
    name: 'Dana Whitfield',
    email: `${unique('buyer')}@example.test`,
    company: 'Kestrel Interiors',
    phone: '+14155550100',
    message: 'We are a team of six and want to stop losing enquiries. Can we see a demo?',
    source: 'pricing',
    ...overrides,
  });

  /** Reads enquiries directly — there is deliberately no API to list them. */
  const storedEnquiries = async (email: string) => {
    const tenantContext = ctx.app.get(TenantContextService);
    const prisma = ctx.app.get(PrismaService);

    return tenantContext.runAsSystem('e2e contact fixture', () =>
      prisma.client.contactEnquiry.findMany({ where: { email } }),
    );
  };

  /**
   * Clears the rate-limiter between cases.
   *
   * The endpoint allows five submissions an hour per IP, and every test here
   * arrives from the same loopback address — so without this the sixth case
   * onwards would fail with 429 and prove nothing about what it meant to test.
   * The limit itself is asserted deliberately in its own case below, which
   * opts out of the reset.
   */
  const resetRateLimit = (): void => {
    const storage = ctx.app.get<ThrottlerStorage & { _storage?: Map<string, unknown> }>(
      ThrottlerStorage,
    );
    storage._storage?.clear();
  };

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  beforeEach(() => {
    resetRateLimit();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ---------------------------------------------------------------------------
  // The happy path
  // ---------------------------------------------------------------------------

  describe('submitting', () => {
    it('accepts an enquiry with no authentication', async () => {
      const body = enquiry();

      const response = await ctx.http().post('/api/v1/contact').send(body).expect(200);

      // A reference the visitor can quote, and one address to reply to.
      expect(response.body.data.reference).toMatch(/^[0-9A-F]{8}$/);
      expect(response.body.data.salesEmail).toContain('@');
    });

    it('stores the enquiry, not just emails it', async () => {
      const body = enquiry();
      await ctx.http().post('/api/v1/contact').send(body).expect(200);

      // Email is best-effort and the provider is configurable. An enquiry lost
      // to a misconfigured SMTP host is a customer nobody knows they missed.
      const rows = await storedEnquiries(body.email);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe('Dana Whitfield');
      expect(rows[0]?.message).toContain('team of six');
      expect(rows[0]?.status).toBe('NEW');
      expect(rows[0]?.source).toBe('pricing');
    });

    it('records that the sales team was notified', async () => {
      const body = enquiry();
      await ctx.http().post('/api/v1/contact').send(body).expect(200);

      const rows = await storedEnquiries(body.email);
      // NULL here would mean the enquiry arrived and nobody was told, which is
      // the case an operator needs to see.
      expect(rows[0]?.notifiedAt).not.toBeNull();
    });

    it('accepts an enquiry with only the required fields', async () => {
      const body = {
        name: 'Sam Ellis',
        email: `${unique('minimal')}@example.test`,
        message: 'Please send me pricing information for a team of twelve.',
      };

      await ctx.http().post('/api/v1/contact').send(body).expect(200);

      const rows = await storedEnquiries(body.email);
      expect(rows[0]?.company).toBeNull();
      expect(rows[0]?.phone).toBeNull();
    });

    it('normalises the email address', async () => {
      const address = `${unique('MiXeD')}@Example.TEST`;
      await ctx
        .http()
        .post('/api/v1/contact')
        .send(enquiry({ email: address, name: '  Padded Name  ' }))
        .expect(200);

      const rows = await storedEnquiries(address.toLowerCase());
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe('Padded Name');
    });
  });

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  describe('validation', () => {
    it.each([
      ['a missing name', { name: undefined }],
      ['a one-character name', { name: 'X' }],
      ['a missing email', { email: undefined }],
      ['a malformed email', { email: 'not-an-email' }],
      ['a missing message', { message: undefined }],
      ['a message that says nothing', { message: 'hi' }],
      ['an over-long message', { message: 'x'.repeat(4001) }],
      ['an over-long name', { name: 'x'.repeat(151) }],
    ])('rejects %s', async (_label, overrides) => {
      const body = enquiry(overrides as Record<string, unknown>);
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete (body as Record<string, unknown>)[key];
      }

      await ctx.http().post('/api/v1/contact').send(body).expect(400);
    });

    it('stores nothing when validation fails', async () => {
      const address = `${unique('rejected')}@example.test`;

      await ctx
        .http()
        .post('/api/v1/contact')
        .send(enquiry({ email: address, message: 'no' }))
        .expect(400);

      expect(await storedEnquiries(address)).toHaveLength(0);
    });

    it('REFUSES a caller-supplied destination address', async () => {
      // The single most important case here. If the recipient could be set by
      // the request, this becomes an open relay for sending mail from our
      // domain to anyone at all.
      for (const field of ['to', 'recipient', 'salesEmail', 'notifyEmail']) {
        resetRateLimit();
        await ctx
          .http()
          .post('/api/v1/contact')
          .send(enquiry({ [field]: 'attacker@example.test' }))
          .expect(400);
      }
    });

    it('refuses any other unexpected field rather than ignoring it', async () => {
      await ctx
        .http()
        .post('/api/v1/contact')
        .send(enquiry({ status: 'RESPONDED', notifiedAt: '2020-01-01T00:00:00.000Z' }))
        .expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Abuse
  // ---------------------------------------------------------------------------

  describe('abuse handling', () => {
    it('silently discards a submission that fills the honeypot', async () => {
      const address = `${unique('bot')}@example.test`;

      const response = await ctx
        .http()
        .post('/api/v1/contact')
        .send(enquiry({ email: address, website: 'http://spam.example' }))
        .expect(200);

      // Answered as though it worked. Telling a bot it was caught only teaches
      // whoever wrote it to stop filling that field.
      expect(response.body.data.reference).toBeTruthy();
      expect(await storedEnquiries(address)).toHaveLength(0);
    });

    it('accepts a submission that leaves the honeypot empty', async () => {
      const address = `${unique('human')}@example.test`;

      await ctx
        .http()
        .post('/api/v1/contact')
        .send(enquiry({ email: address, website: '' }))
        .expect(200);

      expect(await storedEnquiries(address)).toHaveLength(1);
    });

    it('rate-limits repeated submissions from one address', async () => {
      // Deliberately does NOT reset between attempts. This endpoint sends mail
      // on behalf of an anonymous caller, which makes it the most attractive
      // thing in the API to abuse; five an hour is generous for a person and
      // useless for a spammer.
      const statuses: number[] = [];

      for (let attempt = 0; attempt < 7; attempt += 1) {
        const response = await ctx
          .http()
          .post('/api/v1/contact')
          .send(enquiry({ email: `${unique('flood')}@example.test` }));
        statuses.push(response.status);
      }

      expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
      expect(statuses.slice(5)).toEqual([429, 429]);
    });

    it('does not escape HTML into the stored message', async () => {
      const address = `${unique('xss')}@example.test`;
      const payload = '<script>alert(1)</script> Please call me about pricing.';

      await ctx
        .http()
        .post('/api/v1/contact')
        .send(enquiry({ email: address, message: payload }))
        .expect(200);

      // Stored verbatim; escaping happens where it matters, at render time in
      // the email template. Escaping on the way in would corrupt the data and
      // still not protect a client that renders it a second way.
      const rows = await storedEnquiries(address);
      expect(rows[0]?.message).toBe(payload);
    });
  });

  // ---------------------------------------------------------------------------
  // It is not a way into anything else
  // ---------------------------------------------------------------------------

  describe('exposure', () => {
    it('exposes no route for reading enquiries', async () => {
      // Listing them would need a platform-administrator concept that does not
      // exist. Exposing them to organization admins would show every tenant
      // everybody else's sales conversations.
      for (const path of ['/api/v1/contact', '/api/v1/contact/enquiries']) {
        resetRateLimit();
        await ctx
          .http()
          .get(path)
          .set({ Authorization: `Bearer ${ctx.orgA.owner.accessToken}` })
          .expect(404);
      }
    });

    it('leaks nothing about any tenant in its response', async () => {
      const response = await ctx.http().post('/api/v1/contact').send(enquiry()).expect(200);

      const body = JSON.stringify(response.body);
      expect(body).not.toContain(ctx.orgA.id);
      expect(body).not.toContain(ctx.orgB.id);
      expect(Object.keys(response.body.data).sort()).toEqual(['reference', 'salesEmail']);
    });

    it('creates no organization, user or session', async () => {
      const tenantContext = ctx.app.get(TenantContextService);
      const prisma = ctx.app.get(PrismaService);

      const before = await tenantContext.runAsSystem('e2e count', () =>
        Promise.all([prisma.client.organization.count(), prisma.client.user.count()]),
      );

      await ctx.http().post('/api/v1/contact').send(enquiry()).expect(200);

      const after = await tenantContext.runAsSystem('e2e count', () =>
        Promise.all([prisma.client.organization.count(), prisma.client.user.count()]),
      );

      expect(after).toEqual(before);
    });
  });
});
