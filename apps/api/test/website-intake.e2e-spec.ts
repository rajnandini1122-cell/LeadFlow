// MUST be first: it configures the integration into process.env, which
// @nestjs/config reads when the next import pulls in the config module.
import { INTAKE_ORGANIZATION_ID, INTAKE_SECRET } from './helpers/website-intake-env';
import { createHmac } from 'node:crypto';
import { createTestContext, type TestContext } from './helpers/test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { signingBase } from '../src/modules/integrations/website/intake-signature';

/**
 * The website intake boundary.
 *
 * This is the one endpoint in the product that accepts writes from a machine
 * rather than a person, from the open internet, with no session. Three things
 * therefore have to hold, and every case here is one of them:
 *
 *   nothing unsigned is believed;
 *   the tenant is ours to decide, never the caller's;
 *   a submission sent twice is one customer, not two.
 */
describe('Website intake', () => {
  let ctx: TestContext;

  const unique = (prefix: string): string =>
    `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`;

  /** Runs a query with scoping disabled, to inspect what was written. */
  const asSystem = async <T>(reason: string, run: () => Promise<T>): Promise<T> =>
    ctx.app.get(TenantContextService).runAsSystem(reason, run);

  const prisma = () => ctx.app.get(PrismaService).client;

  const enquiry = (overrides: Record<string, unknown> = {}) => ({
    name: 'Dana Whitfield',
    email: `${unique('buyer')}@example.test`,
    message: 'We are a team of six and want to stop losing enquiries. Can we see a demo?',
    ...overrides,
  });

  /**
   * Signs and posts, exactly as an approved website backend would.
   *
   * The body is serialised ONCE and both signed and sent as those bytes: a
   * signature over a re-serialised object is a check that passes when it
   * should fail.
   */
  const post = async (
    payload: Record<string, unknown>,
    options: {
      eventId?: string;
      timestamp?: number;
      secret?: string;
      signature?: string | null;
    } = {},
  ) => {
    const raw = Buffer.from(JSON.stringify(payload));
    const eventId = options.eventId ?? unique('evt');
    const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));

    const signature =
      options.signature === undefined
        ? `sha256=${createHmac('sha256', options.secret ?? INTAKE_SECRET)
            .update(signingBase({ timestamp, eventId, rawBody: raw }))
            .digest('hex')}`
        : options.signature;

    const request = ctx
      .http()
      .post('/api/v1/integrations/website/intake')
      .set('Content-Type', 'application/json')
      .set('x-leadflow-timestamp', timestamp)
      .set('x-leadflow-event-id', eventId);

    if (signature !== null) request.set('x-leadflow-signature', signature);

    // The exact bytes that were signed, as a string: handed a Buffer,
    // superagent serialises the Buffer OBJECT — {"type":"Buffer","data":[...]}
    // — which is not the payload and would never verify.
    return request.send(raw.toString('utf8'));
  };

  const intakeRows = async (eventId: string) =>
    asSystem('e2e intake inspection', () =>
      prisma().integrationIntake.findMany({ where: { externalEventId: eventId } }),
    );

  beforeAll(async () => {
    ctx = await createTestContext();

    /*
     * The tenant the integration is configured for.
     *
     * Created here rather than seeded by the shared fixture because its id has
     * to be known before the application boots — configuration cannot wait for
     * a row that does not exist yet.
     */
    await asSystem('e2e intake tenant', async () => {
      await prisma().organization.create({
        data: {
          id: INTAKE_ORGANIZATION_ID,
          name: 'CRAVION Website Tenant',
          slug: `intake-${Date.now()}`,
          status: 'ACTIVE',
          country: 'IN',
        },
      });
      await prisma().organizationSettings.create({
        data: { organizationId: INTAKE_ORGANIZATION_ID },
      });
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ---------------------------------------------------------------------------
  // 1. Authenticity
  // ---------------------------------------------------------------------------

  describe('authenticity', () => {
    it('accepts a correctly signed submission', async () => {
      const response = await post(enquiry());

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ created: true, status: 'RECEIVED' });
      expect(response.body.data.intakeId).toEqual(expect.any(String));
    });

    it('refuses a request with no signature', async () => {
      const response = await post(enquiry(), { signature: null });

      expect(response.status).toBe(401);
    });

    it('refuses a wrong signature', async () => {
      const response = await post(enquiry(), { signature: `sha256=${'0'.repeat(64)}` });

      expect(response.status).toBe(401);
    });

    it('refuses a signature made with the wrong secret', async () => {
      const response = await post(enquiry(), {
        secret: 'an-entirely-different-secret-of-length-32',
      });

      expect(response.status).toBe(401);
    });

    it('refuses a stale timestamp', async () => {
      // A captured request must stop working. Ten minutes is outside the
      // five-minute window either way.
      const response = await post(enquiry(), {
        timestamp: Math.floor(Date.now() / 1000) - 600,
      });

      expect(response.status).toBe(401);
    });

    it('refuses a malformed timestamp', async () => {
      const response = await post(enquiry(), { timestamp: Number.NaN });

      expect(response.status).toBe(401);
    });

    it('writes nothing at all when authentication fails', async () => {
      const eventId = unique('evt-unsigned');
      await post(enquiry(), { eventId, signature: null });

      // The row is the point: an unauthenticated request must not reach the
      // database, not even as a rejected record.
      expect(await intakeRows(eventId)).toHaveLength(0);
    });

    it('never says which part of the signature was wrong', async () => {
      /*
       * One message for every failure. A caller debugging their integration
       * learns that the request failed; a caller probing it learns nothing
       * about whether the secret was close, how long the window is, or
       * whether that event id already exists.
       */
      const bodies = await Promise.all(
        [
          post(enquiry(), { signature: null }),
          post(enquiry(), { signature: `sha256=${'0'.repeat(64)}` }),
          post(enquiry(), { timestamp: Math.floor(Date.now() / 1000) - 600 }),
        ].map(async (request) => JSON.stringify((await request).body)),
      );

      const messages = bodies.map((body) => JSON.parse(body).error.message as string);
      expect(new Set(messages).size).toBe(1);

      for (const message of messages) {
        // The envelope carries its own meta.timestamp, so the assertion is on
        // the message a caller reads, not on the whole response.
        expect(message.toLowerCase()).not.toContain('timestamp');
        expect(message.toLowerCase()).not.toContain('signature');
        expect(message.toLowerCase()).not.toContain('hmac');
        expect(message.toLowerCase()).not.toContain('secret');
      }
      for (const body of bodies) expect(body).not.toContain(INTAKE_SECRET);
    });

    it('never leaks the signing secret, however it fails', async () => {
      for (const response of [
        await post(enquiry(), { signature: null }),
        await post(enquiry()),
        await post({ message: 'x' }),
      ]) {
        expect(JSON.stringify(response.body)).not.toContain(INTAKE_SECRET);
        expect(JSON.stringify(response.headers)).not.toContain(INTAKE_SECRET);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Idempotency
  // ---------------------------------------------------------------------------

  describe('idempotency', () => {
    it('returns the first receipt when the same submission is sent again', async () => {
      const eventId = unique('evt-retry');
      const payload = enquiry();

      const first = await post(payload, { eventId });
      const second = await post(payload, { eventId });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      // Same record, and the second answer says so rather than pretending to
      // have created something.
      expect(second.body.data.intakeId).toBe(first.body.data.intakeId);
      expect(first.body.data.created).toBe(true);
      expect(second.body.data.created).toBe(false);
    });

    it('stores exactly one row for a retried submission', async () => {
      const eventId = unique('evt-once');
      const payload = enquiry();

      await post(payload, { eventId });
      await post(payload, { eventId });
      await post(payload, { eventId });

      expect(await intakeRows(eventId)).toHaveLength(1);
    });

    it('refuses the same event id carrying a different submission', async () => {
      const eventId = unique('evt-conflict');

      await post(enquiry({ message: 'The first thing they asked about.' }), { eventId });
      const second = await post(enquiry({ message: 'Something else entirely.' }), { eventId });

      /*
       * Not "accept and ignore" and not "overwrite": one of the two is not
       * what the website thinks it sent, and silently keeping either would
       * lose whichever was real.
       */
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('CONFLICT');
      expect(await intakeRows(eventId)).toHaveLength(1);
    });

    it('survives two identical requests arriving together', async () => {
      const eventId = unique('evt-concurrent');
      const payload = enquiry();

      /*
       * The case a prior read cannot handle: both requests look up the event
       * id, both find nothing, and both insert. Only the unique index decides.
       * Against real PostgreSQL in CI this is a genuine race.
       */
      const [first, second] = await Promise.all([
        post(payload, { eventId }),
        post(payload, { eventId }),
      ]);

      expect([first.status, second.status]).toEqual([200, 200]);
      expect(first.body.data.intakeId).toBe(second.body.data.intakeId);
      expect(await intakeRows(eventId)).toHaveLength(1);

      // Exactly one of them created it; the other answered with its receipt.
      expect([first.body.data.created, second.body.data.created].sort()).toEqual([false, true]);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Tenancy
  // ---------------------------------------------------------------------------

  describe('tenancy', () => {
    it('files the submission under the CONFIGURED organization', async () => {
      const eventId = unique('evt-tenant');
      await post(enquiry(), { eventId });

      const [row] = await intakeRows(eventId);
      expect(row?.organizationId).toBe(INTAKE_ORGANIZATION_ID);
    });

    it('ignores an organization the caller names in the body', async () => {
      const eventId = unique('evt-injection');

      /*
       * The attack a signature does NOT prevent: a valid signature proves who
       * is calling, not which tenant they may write to. The field is stripped
       * before validation ever sees it, so the submission lands where
       * configuration says and nowhere else.
       */
      const response = await post(
        { ...enquiry(), organizationId: ctx.orgB.id },
        { eventId },
      );

      expect(response.status).toBe(200);
      const [row] = await intakeRows(eventId);
      expect(row?.organizationId).toBe(INTAKE_ORGANIZATION_ID);
      expect(row?.organizationId).not.toBe(ctx.orgB.id);
    });

    it('is invisible to other tenants', async () => {
      const eventId = unique('evt-isolation');
      await post(enquiry(), { eventId });

      // Read as another organization, through the same scoped client every
      // request uses: the row must not be there.
      const visible = await ctx.app
        .get(TenantContextService)
        .runForOrganization(ctx.orgA.id, 'e2e isolation check', () =>
          prisma().integrationIntake.findMany({ where: { externalEventId: eventId } }),
        );

      expect(visible).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. The submission itself
  // ---------------------------------------------------------------------------

  describe('what gets stored', () => {
    it('canonicalises the phone number the way the CRM does', async () => {
      const eventId = unique('evt-phone');

      // A local Indian number with the country stated: the same parser every
      // other write path uses, not a second one.
      await post(enquiry({ phone: '98765 43210', country: 'IN' }), { eventId });

      const [row] = await intakeRows(eventId);
      expect(row?.phone).toBe('+919876543210');
      expect(row?.country).toBe('IN');
    });

    it('falls back to the tenant country when the caller states none', async () => {
      const eventId = unique('evt-phone-default');
      await post(enquiry({ phone: '9876543211' }), { eventId });

      // The configured tenant is in India, so a bare local number resolves
      // there — the same order of precedence the CRM applies.
      const [row] = await intakeRows(eventId);
      expect(row?.phone).toBe('+919876543211');
    });

    it('keeps an international number in its own country', async () => {
      const eventId = unique('evt-phone-intl');
      await post(enquiry({ phone: '+44 7911 123456', country: 'IN' }), { eventId });

      const [row] = await intakeRows(eventId);
      expect(row?.phone).toBe('+447911123456');
    });

    it('accepts the enquiry even when the phone number is unusable', async () => {
      const eventId = unique('evt-phone-junk');

      // A website visitor cannot be asked to try again. Losing the number is
      // better than losing the customer.
      const response = await post(enquiry({ phone: 'call me after 6' }), { eventId });

      expect(response.status).toBe(200);
      const [row] = await intakeRows(eventId);
      expect(row?.phone).toBeNull();
      expect(row?.message).toContain('team of six');
    });

    it.each(['ZZ', 'IND', 'India', '1'])('refuses the malformed country %s', async (country) => {
      const response = await post(enquiry({ country }));

      expect(response.status).toBe(400);
    });

    it('refuses a submission with nothing in it', async () => {
      const response = await post({ name: 'Nobody' });

      expect(response.status).toBe(400);
    });

    it('refuses a field it does not understand rather than dropping it', async () => {
      const response = await post({ ...enquiry(), status: 'PROCESSED' });

      expect(response.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Duplicates — a signal, never an edit
  // ---------------------------------------------------------------------------

  describe('a submission from somebody already in the CRM', () => {
    it('records the match and changes nothing about the existing customer', async () => {
      const phone = '+919812300045';

      const contact = await ctx.app
        .get(TenantContextService)
        .runForOrganization(INTAKE_ORGANIZATION_ID, 'e2e duplicate fixture', () =>
          prisma().contact.create({
            data: {
              organizationId: INTAKE_ORGANIZATION_ID,
              firstName: 'Existing',
              lastName: 'Customer',
              mobile: phone,
              companyName: 'Kestrel Interiors',
            },
          }),
        );

      const eventId = unique('evt-duplicate');
      const response = await post(
        enquiry({ phone: '98123 00045', country: 'IN', company: 'A Different Company Ltd' }),
        { eventId },
      );

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('DUPLICATE');

      const [row] = await intakeRows(eventId);
      expect(row?.matchedContactId).toBe(contact.id);

      /*
       * The existing customer is UNTOUCHED. A website form is a stranger
       * typing a phone number; letting it rewrite a real relationship — the
       * company, the name, anything — is how a customer record quietly
       * becomes wrong with no audit trail of who changed it.
       */
      const after = await asSystem('e2e duplicate check', () =>
        prisma().contact.findFirst({ where: { id: contact.id } }),
      );
      expect(after?.companyName).toBe('Kestrel Interiors');
      expect(after?.firstName).toBe('Existing');
      expect(after?.updatedAt).toEqual(contact.updatedAt);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. What intake deliberately does NOT do
  // ---------------------------------------------------------------------------

  describe('lead conversion', () => {
    it('creates no Lead in this phase', async () => {
      const eventId = unique('evt-no-lead');

      const before = await asSystem('e2e lead count', () =>
        prisma().lead.count({ where: { organizationId: INTAKE_ORGANIZATION_ID } }),
      );

      await post(enquiry({ phone: '9812300099', country: 'IN' }), { eventId });
      await post(enquiry({ phone: '9812300099', country: 'IN' }), { eventId });

      const after = await asSystem('e2e lead count', () =>
        prisma().lead.count({ where: { organizationId: INTAKE_ORGANIZATION_ID } }),
      );

      /*
       * Deliberate, and documented on the service.
       *
       * An active lead must carry a next follow-up date — the database says so
       * — and it needs an owner to be anybody's job. Both are policy: how soon
       * somebody calls a website enquiry, and who. Inventing either here would
       * put a date nobody agreed to on every website lead. The intake is
       * durable and the conversion phase will answer those questions.
       */
      expect(after).toBe(before);

      const [row] = await intakeRows(eventId);
      expect(row?.createdLeadId).toBeNull();
      expect(row?.processedAt).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Everything that must NOT have changed
  // ---------------------------------------------------------------------------

  describe('the rest of the application', () => {
    it('leaves the public contact form exactly as it was', async () => {
      ctx.redis.flush();

      const response = await ctx
        .http()
        .post('/api/v1/contact')
        .send({
          name: 'Public Visitor',
          email: `${unique('public')}@example.test`,
          message: 'Please send me pricing information for a team of twelve.',
        })
        .expect(200);

      // Same anonymous, unsigned, honeypot-guarded endpoint it always was —
      // intake is a second door, not a replacement for this one.
      expect(response.body.data.reference).toMatch(/^[0-9A-F]{8}$/);
      expect(response.body.data.salesEmail).toContain('@');
    });

    it('is not governed by the credential rate limit', async () => {
      ctx.redis.flush();

      // Spend the credential allowance from this address.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await ctx
          .http()
          .post('/api/v1/auth/login')
          .send({ email: 'nobody@example.test', password: 'wrong', platform: 'WEB' });
      }

      // A trusted backend must keep working. Five attempts per quarter hour is
      // a password-guessing limit; applying it here would throttle a working
      // integration into silence.
      const response = await post(enquiry());
      expect(response.status).toBe(200);
    });
  });
});
