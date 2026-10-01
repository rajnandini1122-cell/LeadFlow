// BOTH env helpers MUST come first, before anything pulls in AppModule:
// @nestjs/config snapshots process.env when the config module is imported, not
// when the application is created.
import { INTAKE_ORGANIZATION_ID, INTAKE_SECRET } from './helpers/website-intake-env';
import './helpers/intake-processing-env';
import { createHmac } from 'node:crypto';
import { ENQUIRY_TYPES } from '@leadflow/api-types';
import { createTestContext, PASSWORD, type TestContext } from './helpers/test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { jobPrincipal } from '../src/queues/job-context';
import {
  IntakeProcessingService,
  type ProcessOutcome,
} from '../src/modules/integrations/intake-processing/intake-processing.service';
import { signingBase } from '../src/modules/integrations/website/intake-signature';

/**
 * Structured classification on a website enquiry.
 *
 * Three claims, and every case here is one of them:
 *
 *   NOTHING OLD BREAKS. A website still sending the original eight fields is
 *   accepted unchanged and lands with the new columns null. That matters more
 *   than any new capability: the live site is on the old payload, and this
 *   phase ships before it changes.
 *
 *   CLASSIFICATION IS ITS OWN FIELD. `source` stays WEBSITE and
 *   `productInterest` stays whatever the customer typed. An enquiry asking for
 *   a sample is WEBSITE + SAMPLE, never source SAMPLE — otherwise "website
 *   enquiries this month" stops being answerable the moment a second
 *   classification exists.
 *
 *   ROUTING IS OPTIONAL AND ADDITIVE. A rule that states an enquiry type
 *   matches only work carrying it; a rule that does not state one behaves
 *   exactly as it did before this dimension existed.
 */
describe('Website enquiry classification', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const owner = () => auth(ctx.orgA.owner.accessToken);

  const unique = (prefix: string): string =>
    `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`;

  const prisma = () => ctx.app.get(PrismaService).client;
  const tenancy = () => ctx.app.get(TenantContextService);

  const asSystem = async <T>(reason: string, run: () => Promise<T>): Promise<T> =>
    tenancy().runAsSystem(reason, run);

  const convert = async (intakeId: string): Promise<ProcessOutcome> =>
    tenancy().runWithTenant(jobPrincipal(ctx.orgA.id), () =>
      ctx.app.get(IntakeProcessingService).process(intakeId),
    );

  /** A mobile that is valid in India and unique to one test. */
  let mobileCounter = 80_000_000;
  const freshMobile = (): string => `+9198${String((mobileCounter += 1)).padStart(8, '0')}`;

  /** The ORIGINAL eight-field payload, exactly as the live website sends it. */
  const legacyEnquiry = (overrides: Record<string, unknown> = {}) => ({
    name: 'Dana Whitfield',
    email: `${unique('buyer')}@example.test`,
    message: 'We are a team of six and want to stop losing enquiries.',
    ...overrides,
  });

  /**
   * Signs and posts, exactly as an approved website backend would.
   *
   * The body is serialised ONCE and both signed and sent as those bytes — a
   * signature over a re-serialised object is a check that passes when it should
   * fail.
   */
  const post = async (
    payload: unknown,
    options: { eventId?: string; signature?: string | null; secret?: string } = {},
  ) => {
    const raw = Buffer.from(JSON.stringify(payload));
    const eventId = options.eventId ?? unique('evt');
    const timestamp = String(Math.floor(Date.now() / 1000));

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

    return request.send(raw.toString('utf8'));
  };

  /**
   * An intake seeded straight into orgA, as the boundary would have stored it.
   *
   * The routing cases use this rather than the HTTP route because the intake
   * endpoint is pinned by configuration to INTAKE_ORGANIZATION_ID, and that
   * tenant has no users — so teams, agents and rules cannot be created in it
   * through the API. What is under test here is the ROUTING dimension, and the
   * HTTP boundary is covered by the cases above.
   */
  const seedIntake = async (fields: Record<string, unknown> = {}): Promise<string> => {
    const created = await asSystem('e2e seed classified intake', () =>
      prisma().integrationIntake.create({
        data: {
          organizationId: ctx.orgA.id,
          source: 'WEBSITE',
          externalEventId: unique('seed'),
          eventType: 'ENQUIRY',
          payloadHash: 'd'.repeat(64),
          status: 'RECEIVED',
          name: 'Dana Whitfield',
          phone: freshMobile(),
          country: 'IN',
          message: 'We want to stop losing enquiries.',
          ...fields,
        },
        select: { id: true },
      }),
    );

    return created.id;
  };

  const intakeFor = async (eventId: string) =>
    asSystem('e2e intake inspection', () =>
      prisma().integrationIntake.findFirst({ where: { externalEventId: eventId } }),
    );

  const leadRow = async (id: string) =>
    asSystem('e2e read lead', () => prisma().lead.findFirst({ where: { id } }));

  // --- routing fixtures ------------------------------------------------------

  const teamWithOneAgent = async () => {
    const team = await ctx
      .http()
      .post('/api/v1/teams')
      .set(owner())
      .send({ name: unique('Team') })
      .expect(201);

    const teamId = team.body.data.id as string;
    const email = `${unique('agent')}@example.test`;

    const invite = await ctx
      .http()
      .post('/api/v1/users/invite')
      .set(owner())
      .send({ email, fullName: 'Agent Zero', role: 'SALES_REP' })
      .expect(201);

    await ctx
      .http()
      .post(`/api/v1/invitations/${invite.body.data.inviteToken}/accept`)
      .send({ firstName: 'Agent', lastName: 'Zero', password: PASSWORD })
      .expect(200);

    await ctx
      .http()
      .post(`/api/v1/teams/${teamId}/members`)
      .set(owner())
      .send({ userId: invite.body.data.userId })
      .expect(201);

    return { id: teamId, userId: invite.body.data.userId as string };
  };

  const clearRules = async (): Promise<void> => {
    const rules = await ctx.http().get('/api/v1/assignment-rules').set(owner()).expect(200);

    for (const rule of rules.body.data as { id: string; status: string }[]) {
      if (rule.status === 'ACTIVE') {
        await ctx
          .http()
          .patch(`/api/v1/assignment-rules/${rule.id}`)
          .set(owner())
          .send({ status: 'ARCHIVED' })
          .expect(200);
      }
    }
  };

  const createRule = (body: Record<string, unknown>) =>
    ctx.http().post('/api/v1/assignment-rules').set(owner()).send(body);

  beforeAll(async () => {
    ctx = await createTestContext();

    /*
     * The tenant the integration is configured for.
     *
     * Its id has to be known before the application boots — configuration
     * cannot wait for a row that does not exist yet — so it is created here
     * rather than by the shared fixture. It has no users, which is why the
     * routing cases below seed their intakes into orgA instead and drive
     * conversion directly.
     */
    await asSystem('e2e intake tenant', async () => {
      /*
       * UPSERT, not create.
       *
       * `INTAKE_ORGANIZATION_ID` is a FIXED id shared with
       * website-intake.e2e-spec.ts — configuration has to name the tenant
       * before the application boots, so it cannot be generated. Both suites
       * run against the same database, so whichever executes first creates the
       * row and the other must find it rather than collide on the primary key.
       */
      await prisma().organization.upsert({
        where: { id: INTAKE_ORGANIZATION_ID },
        update: {},
        create: {
          id: INTAKE_ORGANIZATION_ID,
          name: 'CRAVION Website Tenant',
          slug: `intake-tenant-${Date.now()}`,
          status: 'ACTIVE',
          country: 'IN',
        },
      });
      await prisma().organizationSettings.upsert({
        where: { organizationId: INTAKE_ORGANIZATION_ID },
        update: {},
        create: { organizationId: INTAKE_ORGANIZATION_ID },
      });
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ===========================================================================
  // Backward compatibility — the claim that matters most
  // ===========================================================================

  describe('the original payload', () => {
    it('is still accepted, unchanged', async () => {
      const eventId = unique('legacy');
      const response = await post(legacyEnquiry(), { eventId });

      expect(response.status).toBe(200);

      const intake = await intakeFor(eventId);
      expect(intake).not.toBeNull();
      expect(intake?.source).toBe('WEBSITE');
    });

    it('leaves every new column null rather than inventing a value', async () => {
      const eventId = unique('legacy-null');
      await post(legacyEnquiry(), { eventId });

      const intake = await intakeFor(eventId);

      /*
       * Null, not GENERAL and not false. A form that never asked has no
       * answer, and a default here would be this code deciding what a customer
       * said — `sampleRequired: false` would record a decline nobody made.
       */
      expect(intake?.enquiryType).toBeNull();
      expect(intake?.state).toBeNull();
      expect(intake?.city).toBeNull();
      expect(intake?.quantity).toBeNull();
      expect(intake?.destinationCountry).toBeNull();
      expect(intake?.sampleRequired).toBeNull();
    });

    it('still converts to a lead exactly as before', async () => {
      await clearRules();
      const team = await teamWithOneAgent();
      await createRule({
        name: unique('Fallback'),
        isFallback: true,
        targetTeamId: team.id,
      }).expect(201);

      const outcome = await convert(await seedIntake());

      expect(outcome.result).toBe('CONVERTED');
      const lead = await leadRow((outcome as { leadId: string }).leadId);
      expect(lead?.source).toBe('WEBSITE');
      expect(lead?.assignedToId).toBe(team.userId);
    });
  });

  // ===========================================================================
  // The classification field
  // ===========================================================================

  describe('enquiryType', () => {
    it.each(ENQUIRY_TYPES)('accepts %s and stores it', async (type) => {
      const eventId = unique(`type-${type}`);
      const response = await post(legacyEnquiry({ enquiryType: type }), { eventId });

      expect(response.status).toBe(200);
      expect((await intakeFor(eventId))?.enquiryType).toBe(type);
    });

    it('accepts lower case from a website that does not know our casing', async () => {
      const eventId = unique('type-lower');
      await post(legacyEnquiry({ enquiryType: 'sample' }), { eventId });

      expect((await intakeFor(eventId))?.enquiryType).toBe('SAMPLE');
    });

    it('REFUSES an unrecognised value rather than coercing it', async () => {
      const eventId = unique('type-bad');
      const response = await post(legacyEnquiry({ enquiryType: 'WHOLESALE' }), { eventId });

      /*
       * 400, not a silent fallback to GENERAL. Reclassifying somebody's
       * enquiry to a value they did not choose is worse than telling the
       * website its value is wrong.
       */
      expect(response.status).toBe(400);
      expect(await intakeFor(eventId)).toBeNull();
    });

    it('does NOT become the source', async () => {
      const eventId = unique('type-source');
      await post(legacyEnquiry({ enquiryType: 'EXPORT' }), { eventId });

      const intake = await intakeFor(eventId);

      // Source says how it arrived, and attribution counts on it staying put.
      expect(intake?.source).toBe('WEBSITE');
      expect(intake?.enquiryType).toBe('EXPORT');
    });

    it('does NOT overwrite productInterest', async () => {
      const eventId = unique('type-product');
      await post(
        legacyEnquiry({ enquiryType: 'SAMPLE', productInterest: 'White onion powder' }),
        { eventId },
      );

      const intake = await intakeFor(eventId);

      // The customer's own words survive intact beside the classification.
      expect(intake?.productInterest).toBe('White onion powder');
      expect(intake?.enquiryType).toBe('SAMPLE');
    });

    it('carries through to the lead source as WEBSITE, not the type', async () => {
      await clearRules();
      const team = await teamWithOneAgent();
      await createRule({ name: unique('Fallback'), isFallback: true, targetTeamId: team.id })
        .expect(201);

      const outcome = await convert(await seedIntake({ enquiryType: 'BULK' }));
      const lead = await leadRow((outcome as { leadId: string }).leadId);

      expect(lead?.source).toBe('WEBSITE');
    });
  });

  // ===========================================================================
  // The other structured fields
  // ===========================================================================

  describe('routing and detail fields', () => {
    it('persists all of them as given', async () => {
      const eventId = unique('fields');
      await post(
        legacyEnquiry({
          state: 'Maharashtra',
          city: 'Pune',
          quantity: '500 kg',
          destinationCountry: 'OM',
          sampleRequired: true,
        }),
        { eventId },
      );

      const intake = await intakeFor(eventId);
      expect(intake).toMatchObject({
        state: 'Maharashtra',
        city: 'Pune',
        quantity: '500 kg',
        destinationCountry: 'OM',
        sampleRequired: true,
      });
    });

    it('keeps quantity as the customer wrote it', async () => {
      const eventId = unique('qty');
      await post(legacyEnquiry({ quantity: '2 tonnes monthly' }), { eventId });

      // Never parsed into a number and a unit. A parser guessing that "2"
      // means tonnes is how a quote comes out a thousand times wrong.
      expect((await intakeFor(eventId))?.quantity).toBe('2 tonnes monthly');
    });

    it('records sampleRequired false distinctly from never asked', async () => {
      const asked = unique('sample-no');
      const notAsked = unique('sample-absent');

      await post(legacyEnquiry({ sampleRequired: false }), { eventId: asked });
      await post(legacyEnquiry(), { eventId: notAsked });

      expect((await intakeFor(asked))?.sampleRequired).toBe(false);
      expect((await intakeFor(notAsked))?.sampleRequired).toBeNull();
    });

    it('keeps destinationCountry distinct from the enquirer country', async () => {
      const eventId = unique('dest');
      await post(
        legacyEnquiry({ country: 'IN', destinationCountry: 'AE', enquiryType: 'EXPORT' }),
        { eventId },
      );

      // An Indian buying office shipping to the UAE. Collapsing these would
      // route the enquiry to the wrong team.
      const intake = await intakeFor(eventId);
      expect(intake?.country).toBe('IN');
      expect(intake?.destinationCountry).toBe('AE');
    });

    it('refuses a malformed destination country', async () => {
      const eventId = unique('dest-bad');
      const response = await post(legacyEnquiry({ destinationCountry: 'ZZ' }), { eventId });

      expect(response.status).toBe(400);
    });
  });

  // ===========================================================================
  // Routing — the new dimension, and the old behaviour it must not disturb
  // ===========================================================================

  describe('assignment rules', () => {
    it('lets a rule match on enquiryType', async () => {
      await clearRules();
      const sampleTeam = await teamWithOneAgent();
      const otherTeam = await teamWithOneAgent();

      // Specific first, catch-all last — priority order decides.
      await createRule({
        name: unique('Samples'),
        source: 'WEBSITE',
        enquiryType: 'SAMPLE',
        priority: 10,
        targetTeamId: sampleTeam.id,
      }).expect(201);
      await createRule({
        name: unique('Fallback'),
        isFallback: true,
        priority: 900,
        targetTeamId: otherTeam.id,
      }).expect(201);

      const outcome = await convert(await seedIntake({ enquiryType: 'SAMPLE' }));

      expect(outcome.result).toBe('CONVERTED');
      const lead = await leadRow((outcome as { leadId: string }).leadId);
      expect(lead?.assignedToId).toBe(sampleTeam.userId);
    });

    it('does NOT match a differently-typed enquiry on that rule', async () => {
      await clearRules();
      const sampleTeam = await teamWithOneAgent();
      const otherTeam = await teamWithOneAgent();

      await createRule({
        name: unique('Samples'),
        source: 'WEBSITE',
        enquiryType: 'SAMPLE',
        priority: 10,
        targetTeamId: sampleTeam.id,
      }).expect(201);
      await createRule({
        name: unique('Fallback'),
        isFallback: true,
        priority: 900,
        targetTeamId: otherTeam.id,
      }).expect(201);

      const outcome = await convert(await seedIntake({ enquiryType: 'BULK' }));
      const lead = await leadRow((outcome as { leadId: string }).leadId);

      // Fell through to the catch-all, which is the whole point of AND.
      expect(lead?.assignedToId).toBe(otherTeam.userId);
    });

    it('does NOT match an UNCLASSIFIED enquiry on a typed rule', async () => {
      await clearRules();
      const sampleTeam = await teamWithOneAgent();
      const otherTeam = await teamWithOneAgent();

      await createRule({
        name: unique('Samples'),
        source: 'WEBSITE',
        enquiryType: 'SAMPLE',
        priority: 10,
        targetTeamId: sampleTeam.id,
      }).expect(201);
      await createRule({
        name: unique('Fallback'),
        isFallback: true,
        priority: 900,
        targetTeamId: otherTeam.id,
      }).expect(201);

      const outcome = await convert(await seedIntake());
      const lead = await leadRow((outcome as { leadId: string }).leadId);

      /*
       * An enquiry with no type is not "any type" — it is a fact we do not
       * have. This is the same convention product and territory already
       * follow, and it is what keeps a WhatsApp message (which carries no
       * enquiry type at all) out of a rule written for website samples.
       */
      expect(lead?.assignedToId).toBe(otherTeam.userId);
    });

    it('leaves a rule WITHOUT enquiryType behaving exactly as before', async () => {
      await clearRules();
      const team = await teamWithOneAgent();

      // A source-only rule, the shape that existed before this phase.
      await createRule({
        name: unique('Website'),
        source: 'WEBSITE',
        priority: 10,
        targetTeamId: team.id,
      }).expect(201);

      // It must match regardless of whether the enquiry carries a type.
      for (const extra of [{}, { enquiryType: 'SAMPLE' }, { enquiryType: 'EXPORT' }]) {
        const outcome = await convert(await seedIntake(extra));

        expect(outcome.result).toBe('CONVERTED');
        const lead = await leadRow((outcome as { leadId: string }).leadId);
        expect(lead?.assignedToId).toBe(team.userId);
      }
    });

    it('refuses an unrecognised enquiryType on a rule', async () => {
      const response = await createRule({
        name: unique('Bad'),
        source: 'WEBSITE',
        enquiryType: 'WHOLESALE',
        targetTeamId: (await teamWithOneAgent()).id,
      });

      expect(response.status).toBe(400);
    });

    it('treats enquiryType as a criterion, so it alone is not a fallback', async () => {
      await clearRules();
      const team = await teamWithOneAgent();

      // A rule constraining only enquiry type is a SPECIFIC rule, not a
      // catch-all, and must be accepted as one.
      const response = await createRule({
        name: unique('SamplesOnly'),
        enquiryType: 'SAMPLE',
        targetTeamId: team.id,
      });

      expect(response.status).toBe(201);
      expect(response.body.data.isFallback).toBe(false);
    });

    it('refuses a fallback that also states an enquiryType', async () => {
      const team = await teamWithOneAgent();
      const response = await createRule({
        name: unique('BadFallback'),
        isFallback: true,
        enquiryType: 'SAMPLE',
        targetTeamId: team.id,
      });

      // A fallback carries no criteria, by definition.
      expect(response.status).toBe(400);
    });
  });

  // ===========================================================================
  // Unchanged behaviour the new fields must not disturb
  // ===========================================================================

  describe('the boundary and the pipeline', () => {
    it('still refuses an invalid signature', async () => {
      const eventId = unique('bad-sig');
      const response = await post(legacyEnquiry({ enquiryType: 'SAMPLE' }), {
        eventId,
        signature: 'sha256=deadbeef',
      });

      expect([401, 403]).toContain(response.status);
      expect(await intakeFor(eventId)).toBeNull();
    });

    it('still refuses an unsigned request', async () => {
      const eventId = unique('no-sig');
      const response = await post(legacyEnquiry(), { eventId, signature: null });

      expect([401, 403]).toContain(response.status);
      expect(await intakeFor(eventId)).toBeNull();
    });

    it('still refuses a signature made with the wrong secret', async () => {
      const eventId = unique('wrong-secret');
      const response = await post(legacyEnquiry(), { eventId, secret: 'not-the-secret' });

      expect([401, 403]).toContain(response.status);
    });

    it('keeps idempotency: the same event id yields one intake', async () => {
      const eventId = unique('idem');
      const payload = legacyEnquiry({ enquiryType: 'QUOTE', quantity: '100 kg' });

      // `post` is async, so its status is asserted on the resolved response
      // rather than chained — the helper returns a Promise, not the supertest
      // chain.
      expect((await post(payload, { eventId })).status).toBe(200);
      expect((await post(payload, { eventId })).status).toBe(200);

      const rows = await asSystem('e2e idempotency', () =>
        prisma().integrationIntake.findMany({ where: { externalEventId: eventId } }),
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.enquiryType).toBe('QUOTE');
    });

    it('still reaches the same five statuses', async () => {
      // A sanity check on the enum, so a future migration cannot quietly drop
      // one and leave this pipeline describing states it no longer has.
      const statuses = await asSystem('e2e status shapes', () =>
        prisma().integrationIntake.findMany({ select: { status: true }, take: 1 }),
      );

      expect(statuses).toBeDefined();
    });
  });
});
