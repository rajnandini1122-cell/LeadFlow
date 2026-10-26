// BOTH env helpers MUST come first, before anything pulls in AppModule:
// @nestjs/config snapshots process.env when the config module is imported, not
// when the application is created.
import { INTAKE_ORGANIZATION_ID, INTAKE_SECRET } from './helpers/website-intake-env';
import './helpers/intake-processing-env';
import { createHmac } from 'node:crypto';
import { createTestContext, PASSWORD, type TestContext } from './helpers/test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { MetricsService } from '../src/common/observability/metrics.service';
import { jobPrincipal } from '../src/queues/job-context';
import {
  IntakeProcessingService,
  type ProcessOutcome,
} from '../src/modules/integrations/intake-processing/intake-processing.service';
import { signingBase } from '../src/modules/integrations/website/intake-signature';

/**
 * Hardening the enquiry boundary, and tracing what came through it.
 *
 * Four claims, and every case here is one of them:
 *
 *   THE CONTRACT IS CLOSED. A website sending a field this version does not
 *   understand is told so, at once, rather than watching it vanish. `subject`
 *   is the specific field that prompted this — it was asked for, considered,
 *   and deliberately not added — so it is asserted by name.
 *
 *   ONE SUBMISSION IS TRACEABLE. Support can answer "did submission X reach
 *   LeadFlow?" without database access. Previously impossible: the sender's id
 *   was stored and never returned.
 *
 *   AN EMAIL IS A DUPLICATE KEY. An enquiry carrying an address and no phone
 *   number used to have none at all, so two submissions from one person who
 *   left the phone field blank became two active leads.
 *
 *   THE FUNNEL IS COUNTABLE. How many arrived, and how many became work,
 *   without labels that would make the cardinality unbounded.
 */
describe('Intake hardening and traceability', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const owner = () => auth(ctx.orgA.owner.accessToken);

  const unique = (prefix: string): string =>
    `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`;

  const prisma = () => ctx.app.get(PrismaService).client;
  const tenancy = () => ctx.app.get(TenantContextService);
  const metrics = () => ctx.app.get(MetricsService);

  const asSystem = async <T>(reason: string, run: () => Promise<T>): Promise<T> =>
    tenancy().runAsSystem(reason, run);

  const convert = async (intakeId: string): Promise<ProcessOutcome> =>
    tenancy().runWithTenant(jobPrincipal(ctx.orgA.id), () =>
      ctx.app.get(IntakeProcessingService).process(intakeId),
    );

  /**
   * A mobile valid in India and unique to one test in this file.
   *
   * The 50M band is this file's alone. The bands are a DIRECTORY-WIDE
   * allocation, not a per-file one: the test database persists across spec
   * files within a run, and `leads_org_mobile_uniq` plus several unscoped
   * `findMany({ where: { mobile } })` reads mean a number another suite is
   * also using turns into a failure in whichever file happens to run second.
   *
   * In use elsewhere: 60M intake-processing, 70M intake-operations and
   * whatsapp-auto-lead, 80M website-intake-classification, 90M
   * lead-number-allocation.
   */
  let mobileCounter = 50_000_000;
  const freshMobile = (): string => `+9198${String((mobileCounter += 1)).padStart(8, '0')}`;

  /** An address nobody else in the suite is using. */
  const freshEmail = (prefix = 'buyer'): string => `${unique(prefix)}@example.test`;

  /**
   * A lead somebody types in by hand, with an email and NO phone number.
   *
   * `nextFollowUpAt` is required rather than incidental: the
   * `leads_active_requires_followup` CHECK refuses an active lead without one,
   * so a payload missing it is rejected before the duplicate guard is reached —
   * which would make these cases pass for the wrong reason.
   */
  const manualLead = (email: string): Record<string, unknown> => ({
    firstName: 'Dana',
    lastName: 'Whitfield',
    email,
    status: 'NEW',
    nextFollowUpAt: new Date(Date.now() + 86_400_000).toISOString(),
  });

  /**
   * Signs and posts, exactly as an approved website backend would.
   *
   * The body is serialised ONCE and both signed and sent as those bytes — a
   * signature over a re-serialised object is a check that passes when it
   * should fail.
   */
  const post = async (
    payload: unknown,
    options: { eventId?: string } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const raw = Buffer.from(JSON.stringify(payload));
    const eventId = options.eventId ?? unique('evt');
    const timestamp = String(Math.floor(Date.now() / 1000));

    const signature = `sha256=${createHmac('sha256', INTAKE_SECRET)
      .update(signingBase({ timestamp, eventId, rawBody: raw }))
      .digest('hex')}`;

    const response = await ctx
      .http()
      .post('/api/v1/integrations/website/intake')
      .set('Content-Type', 'application/json')
      .set('x-leadflow-timestamp', timestamp)
      .set('x-leadflow-event-id', eventId)
      .set('x-leadflow-signature', signature)
      .send(raw.toString('utf8'));

    return { status: response.status, body: response.body as Record<string, unknown> };
  };

  /**
   * An intake seeded straight into orgA, as the boundary would have stored it.
   *
   * The conversion cases use this rather than the HTTP route because the intake
   * endpoint is pinned by configuration to INTAKE_ORGANIZATION_ID, and that
   * tenant has no users — so teams, agents and rules cannot be created in it
   * through the API.
   */
  const seedIntake = async (
    fields: Record<string, unknown> = {},
    organizationId = ctx.orgA.id,
  ): Promise<{ id: string; submissionId: string }> => {
    const submissionId = unique('sub');

    const created = await asSystem('e2e seed intake', () =>
      prisma().integrationIntake.create({
        data: {
          organizationId,
          source: 'WEBSITE',
          externalEventId: submissionId,
          eventType: 'ENQUIRY',
          payloadHash: 'e'.repeat(64),
          status: 'RECEIVED',
          name: 'Dana Whitfield',
          country: 'IN',
          message: 'We lose enquiries every week. Can we see a demo?',
          ...fields,
        },
        select: { id: true },
      }),
    );

    return { id: created.id, submissionId };
  };

  const intakeRow = async (id: string) =>
    asSystem('e2e read intake', () => prisma().integrationIntake.findFirst({ where: { id } }));

  const intakeByEvent = async (eventId: string) =>
    asSystem('e2e read intake by event', () =>
      prisma().integrationIntake.findFirst({ where: { externalEventId: eventId } }),
    );

  const leadsWithEmail = async (email: string, organizationId = ctx.orgA.id) =>
    asSystem('e2e count leads by email', () =>
      prisma().lead.findMany({
        where: { organizationId, email: { equals: email, mode: 'insensitive' }, deletedAt: null },
        select: { id: true, leadNumber: true, email: true },
      }),
    );

  // --- routing fixtures ------------------------------------------------------

  const teamWithOneAgent = async (): Promise<{ id: string; userId: string }> => {
    const team = await ctx
      .http()
      .post('/api/v1/teams')
      .set(owner())
      .send({ name: unique('Team') })
      .expect(201);

    const teamId = team.body.data.id as string;
    const email = freshEmail('agent');

    const invite = await ctx
      .http()
      .post('/api/v1/users/invite')
      .set(owner())
      .send({ email, fullName: 'Agent One', role: 'SALES_REP' })
      .expect(201);

    await ctx
      .http()
      .post(`/api/v1/invitations/${invite.body.data.inviteToken}/accept`)
      .send({ firstName: 'Agent', lastName: 'One', password: PASSWORD })
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

  /** A fallback rule pointing at a staffed team: the minimum for CONVERTED. */
  const routeEverythingSomewhere = async (): Promise<void> => {
    await clearRules();
    const team = await teamWithOneAgent();
    await ctx
      .http()
      .post('/api/v1/assignment-rules')
      .set(owner())
      .send({ name: unique('Fallback'), isFallback: true, targetTeamId: team.id })
      .expect(201);
  };

  beforeAll(async () => {
    ctx = await createTestContext();

    /*
     * UPSERT, not create.
     *
     * `INTAKE_ORGANIZATION_ID` is a FIXED id shared with
     * website-intake.e2e-spec.ts and website-intake-classification.e2e-spec.ts
     * — configuration has to name the tenant before the application boots, so
     * it cannot be generated. All three suites run against the same database,
     * so whichever executes first creates the row and the others must find it
     * rather than collide on the primary key.
     */
    await asSystem('e2e intake tenant', async () => {
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
  // A. The contract is closed
  // ===========================================================================

  describe('the closed payload contract', () => {
    const valid = (overrides: Record<string, unknown> = {}) => ({
      name: 'Dana Whitfield',
      email: freshEmail(),
      message: 'We are a team of six and want to stop losing enquiries.',
      ...overrides,
    });

    it('refuses `subject`, the field that was asked for and deliberately left out', async () => {
      const eventId = unique('subject');
      const response = await post(valid({ subject: 'Bulk enquiry' }), { eventId });

      /*
       * 400, not 200-and-ignored. A website that silently loses a field finds
       * out months later from a customer who says they told us something.
       *
       * `subject` was considered on its merits and refused: `message` already
       * holds what the customer wrote, and a second free-text field that
       * routing does not read is a place for information to go and die. The
       * structured `enquiryType` carries the part of "subject" that is
       * actionable.
       */
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).toContain('subject');
    });

    it('stores nothing at all when a field is refused', async () => {
      const eventId = unique('subject-nothing');
      await post(valid({ subject: 'Bulk enquiry' }), { eventId });

      // The whole submission is rejected, not partially accepted. A stored row
      // missing the field the sender thought mattered is worse than no row.
      expect(await intakeByEvent(eventId)).toBeNull();
    });

    /*
     * organizationId is STRIPPED, not refused — and that is deliberate.
     *
     * `StripTenantFieldsInterceptor` deletes every tenant-naming field from
     * every request body before validation, with no exemptions. So this payload
     * is accepted and the field simply never existed by the time the DTO saw
     * it. The security property is not the status code: it is that the enquiry
     * lands in the tenant CONFIGURATION names, never the one the caller does.
     *
     * Asserted here rather than left to the interceptor's own tests because
     * this is the route where getting it wrong would let one valid signature
     * write into any tenant — a signature proves who is calling, not what they
     * may touch.
     */
    it('ignores a caller-supplied organizationId and uses the configured tenant', async () => {
      const eventId = unique('forged-tenant');
      const response = await post(
        valid({ organizationId: ctx.orgA.id }),
        { eventId },
      );

      expect(response.status).toBe(200);
      expect((await intakeByEvent(eventId))?.organizationId).toBe(INTAKE_ORGANIZATION_ID);
    });

    it.each([
      ['externalEventId', { externalEventId: 'forged' }],
      ['source', { source: 'MANUAL' }],
      ['status', { status: 'PROCESSED' }],
      ['assignedToId', { assignedToId: '00000000-0000-7000-8000-000000000001' }],
      ['productInterestId', { productInterestId: 'nope' }],
      ['tags', { tags: ['vip'] }],
    ])('refuses the unknown field %s', async (_label, extra) => {
      const response = await post(valid(extra));

      /*
       * The first two matter beyond tidiness.
       *
       * `externalEventId` lives in a SIGNED header, and a body copy would be a
       * second place one value can live — the first time they disagreed, the
       * question would be which one decided. `source` is what attribution is
       * counted on, and a caller that could set it could claim to be anything.
       */
      expect(response.status).toBe(400);
    });

    it('accepts the whole documented contract — all fourteen fields', async () => {
      const eventId = unique('full');
      const email = freshEmail('full');

      const response = await post(
        {
          name: 'Mateo Rivas',
          email,
          phone: '98200 11099',
          country: 'IN',
          company: 'Rivas Trading',
          message: 'We need a quote for 500 kg, shipped to Oman.',
          productInterest: 'White onion powder',
          sourcePage: '/contact',
          enquiryType: 'quote',
          state: 'Maharashtra',
          city: 'Pune',
          quantity: '500 kg',
          destinationCountry: 'OM',
          sampleRequired: true,
        },
        { eventId },
      );

      // 200, not 202: the enquiry is durably stored before the response is
      // written, so the website is told it arrived and not that it might.
      expect(response.status).toBe(200);

      const intake = await intakeByEvent(eventId);
      expect(intake).toMatchObject({
        name: 'Mateo Rivas',
        email,
        company: 'Rivas Trading',
        productInterest: 'White onion powder',
        sourcePage: '/contact',
        // Lowercase in, uppercase stored: the website should not have to know
        // our casing.
        enquiryType: 'QUOTE',
        state: 'Maharashtra',
        city: 'Pune',
        quantity: '500 kg',
        destinationCountry: 'OM',
        sampleRequired: true,
      });
      // The classification is its own field. `source` says how the enquiry
      // arrived; folding one into the other makes "website enquiries this
      // month" unanswerable.
      expect(intake?.source).toBe('WEBSITE');
    });

    it('says which field it did not understand, and nothing about the secret', async () => {
      const response = await post(valid({ subject: 'Bulk enquiry' }));
      const serialised = JSON.stringify(response.body);

      expect(serialised).toContain('subject');
      // A validation error is the one place a boundary is chatty. It must not
      // be chatty about signing material.
      expect(serialised).not.toContain(INTAKE_SECRET);
      expect(serialised).not.toMatch(/signature|hmac|secret/i);
    });
  });

  // ===========================================================================
  // B. One submission is traceable
  // ===========================================================================

  describe('tracing one submission', () => {
    it('returns the sender’s own reference on the list', async () => {
      const seeded = await seedIntake({ email: freshEmail() });

      const response = await ctx
        .http()
        .get('/api/v1/integration-intakes')
        .set(owner())
        .expect(200);

      const found = (response.body.data.items as { id: string; submissionId: string }[]).find(
        (item) => item.id === seeded.id,
      );
      expect(found?.submissionId).toBe(seeded.submissionId);
    });

    it('finds one enquiry by that reference', async () => {
      const seeded = await seedIntake({ email: freshEmail() });

      const response = await ctx
        .http()
        .get(`/api/v1/integration-intakes?submissionId=${seeded.submissionId}`)
        .set(owner())
        .expect(200);

      // This is the whole point: support answers "did submission X reach
      // LeadFlow?" from the operations screen, with no database access.
      expect(response.body.data.total).toBe(1);
      expect(response.body.data.items[0].id).toBe(seeded.id);
    });

    it('matches the reference exactly, not as a prefix', async () => {
      const seeded = await seedIntake({ email: freshEmail() });

      const response = await ctx
        .http()
        .get(`/api/v1/integration-intakes?submissionId=${seeded.submissionId.slice(0, 8)}`)
        .set(owner())
        .expect(200);

      /*
       * Exact, deliberately. A prefix or contains match would answer "yes,
       * something like that arrived", and the question is about one submission.
       * It would also be a way to enumerate the queue one character at a time.
       */
      expect(response.body.data.total).toBe(0);
    });

    it('does not find another organization’s submission', async () => {
      const seeded = await seedIntake({ email: freshEmail() }, ctx.orgB.id);

      const response = await ctx
        .http()
        .get(`/api/v1/integration-intakes?submissionId=${seeded.submissionId}`)
        .set(owner())
        .expect(200);

      // Empty, and the answer says nothing about whether it exists elsewhere.
      expect(response.body.data.total).toBe(0);
    });

    it('returns the reference on the detail as well', async () => {
      const seeded = await seedIntake({ email: freshEmail() });

      const response = await ctx
        .http()
        .get(`/api/v1/integration-intakes/${seeded.id}`)
        .set(owner())
        .expect(200);

      expect(response.body.data.submissionId).toBe(seeded.submissionId);
    });

    it('exposes nothing else from the signed envelope', async () => {
      const seeded = await seedIntake({ email: freshEmail() });

      const response = await ctx
        .http()
        .get(`/api/v1/integration-intakes/${seeded.id}`)
        .set(owner())
        .expect(200);

      /*
       * The submission id is safe to show: an opaque reference the sender
       * chose. The payload hash and the signature are not — they are HMAC
       * material, and a control surface that returns them is a surface whose
       * compromise returns them.
       */
      const serialised = JSON.stringify(response.body);
      expect(serialised).not.toContain('payloadHash');
      expect(serialised).not.toContain('e'.repeat(64));
      expect(serialised).not.toMatch(/signature/i);
    });

    it('filters the queue by enquiry type', async () => {
      const sampled = await seedIntake({ email: freshEmail(), enquiryType: 'SAMPLE' });
      const general = await seedIntake({ email: freshEmail(), enquiryType: 'GENERAL' });

      const response = await ctx
        .http()
        .get('/api/v1/integration-intakes?enquiryType=SAMPLE')
        .set(owner())
        .expect(200);

      const ids = (response.body.data.items as { id: string }[]).map((item) => item.id);
      expect(ids).toContain(sampled.id);
      expect(ids).not.toContain(general.id);
    });

    it('refuses an enquiry type that is not one of the eight', async () => {
      // Coercing an unrecognised filter to GENERAL would quietly answer a
      // different question than the one asked.
      await ctx
        .http()
        .get('/api/v1/integration-intakes?enquiryType=SUPPORT')
        .set(owner())
        .expect(400);
    });
  });

  // ===========================================================================
  // D. An email address is a duplicate key
  // ===========================================================================

  describe('duplicate leads by email', () => {
    beforeAll(async () => {
      await routeEverythingSomewhere();
    });

    it('converts an enquiry that carries an email and no phone', async () => {
      const email = freshEmail('first');
      const outcome = await convert((await seedIntake({ email, phone: null })).id);

      // The baseline. Nothing here refuses a legitimate first enquiry.
      expect(outcome.result).toBe('CONVERTED');
      expect(await leadsWithEmail(email)).toHaveLength(1);
    });

    it('holds a second enquiry from the same address for review', async () => {
      const email = freshEmail('repeat');
      expect((await convert((await seedIntake({ email, phone: null })).id)).result).toBe(
        'CONVERTED',
      );

      const second = await seedIntake({ email, phone: null });
      const outcome = await convert(second.id);

      /*
       * THE GAP THIS CLOSES. Both of these used to convert: the mobile
       * pre-check is guarded by `if (mobile)` and was skipped, and no
       * constraint covered email — so one person who left the phone field blank
       * ended up as two active leads with two owners and two conversations.
       */
      expect(outcome.result).toBe('DUPLICATE');
      expect(await leadsWithEmail(email)).toHaveLength(1);
    });

    it('names the lead the enquiry lost to, so a person can look', async () => {
      const email = freshEmail('named');
      await convert((await seedIntake({ email, phone: null })).id);
      const second = await seedIntake({ email, phone: null });
      await convert(second.id);

      const row = await intakeRow(second.id);
      const existing = (await leadsWithEmail(email))[0];

      expect(row?.status).toBe('DUPLICATE');
      expect(row?.matchedLeadId).toBe(existing?.id);
      // Said in words, and specific about WHICH key matched — reporting an
      // email collision as a mobile one sends somebody looking for a phone
      // number that was never the problem.
      expect(row?.failureReason).toContain('email address');
      expect(row?.failureReason).toContain(existing?.leadNumber as string);
    });

    it('treats a different casing as the same customer', async () => {
      const local = unique('casing');
      await convert((await seedIntake({ email: `${local}@example.test`, phone: null })).id);

      const second = await seedIntake({ email: `${local.toUpperCase()}@EXAMPLE.TEST`, phone: null });
      const outcome = await convert(second.id);

      // Email is case-insensitive in practice, and this database does not hold
      // it consistently. Comparing raw strings would miss exactly the duplicate
      // the check exists to find.
      expect(outcome.result).toBe('DUPLICATE');
    });

    it('normalises casing and whitespace at the boundary', async () => {
      const eventId = unique('normalised');
      const local = unique('spaced');

      await post(
        {
          name: 'Dana Whitfield',
          email: `  ${local.toUpperCase()}@EXAMPLE.TEST  `,
          message: 'We would like a quote, please.',
        },
        { eventId },
      );

      // Stored lowercase and trimmed, so what the index sees and what a person
      // reads are the same string.
      expect((await intakeByEvent(eventId))?.email).toBe(`${local.toLowerCase()}@example.test`);
    });

    it('keeps the key inside one organization', async () => {
      const email = freshEmail('shared');

      await asSystem('e2e seed other tenant lead', () =>
        prisma().lead.create({
          data: {
            organizationId: ctx.orgB.id,
            leadNumber: unique('LD').slice(0, 20),
            status: 'NEW',
            email,
            nextFollowUpAt: new Date(),
          },
        }),
      );

      const outcome = await convert((await seedIntake({ email, phone: null })).id);

      /*
       * Two tenants may both be talking to the same buyer, and one tenant's
       * customer list must not shape another's duplicate decisions. A global
       * key would also be an information leak: "this address is taken" tells
       * you somebody else is talking to them.
       */
      expect(outcome.result).toBe('CONVERTED');
    });

    it('leaves the existing mobile check exactly as it was', async () => {
      const mobile = freshMobile();
      expect(
        (await convert((await seedIntake({ phone: mobile, email: freshEmail() })).id)).result,
      ).toBe('CONVERTED');

      const outcome = await convert(
        (await seedIntake({ phone: mobile, email: freshEmail() })).id,
      );

      // Same number, DIFFERENT address. The new key must not have displaced
      // the stronger one.
      expect(outcome.result).toBe('DUPLICATE');
      const row = await intakeRow((await seedIntake({ phone: mobile })).id);
      expect(row).not.toBeNull();
    });

    it('lets a customer who went quiet come back', async () => {
      const email = freshEmail('returning');
      await convert((await seedIntake({ email, phone: null })).id);

      const existing = (await leadsWithEmail(email))[0];
      await asSystem('e2e close lead as lost', () =>
        prisma().lead.update({
          where: { id: existing?.id },
          data: { status: 'LOST', lostAt: new Date(), nextFollowUpAt: null },
        }),
      );

      const outcome = await convert((await seedIntake({ email, phone: null })).id);

      // A LOST lead releases the address. A second enquiry from somebody we
      // failed to win is a new opportunity, not a duplicate.
      expect(outcome.result).toBe('CONVERTED');
    });

    it('is idempotent on the same submission', async () => {
      const email = freshEmail('idempotent');
      const eventId = unique('same-event');

      const first = await post(
        { name: 'Dana Whitfield', email, message: 'Please send a quote.' },
        { eventId },
      );
      const second = await post(
        { name: 'Dana Whitfield', email, message: 'Please send a quote.' },
        { eventId },
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      // One row, because the signed event id is the idempotency key. A retrying
      // website must not create a second enquiry.
      const stored = await asSystem('e2e count by event', () =>
        prisma().integrationIntake.count({ where: { externalEventId: eventId } }),
      );
      expect(stored).toBe(1);
    });

    it('converts only once when two submissions race', async () => {
      /*
       * HONEST CAVEAT, the same one concurrency.e2e-spec.ts carries.
       *
       * These promises are genuinely parallel, but PGlite — the local
       * development database — serves ONE connection at a time, so locally they
       * interleave rather than truly overlap and the in-transaction pre-check
       * is what refuses the second. CI runs real PostgreSQL, where they can
       * overlap and `leads_org_email_uniq` is what refuses it. The assertion is
       * the same either way, and that is the point: one lead, whichever layer
       * caught it.
       */
      const email = freshEmail('race');
      const one = await seedIntake({ email, phone: null });
      const two = await seedIntake({ email, phone: null });

      const outcomes = await Promise.all([convert(one.id), convert(two.id)]);
      const results = outcomes.map((outcome) => outcome.result).sort();

      expect(await leadsWithEmail(email)).toHaveLength(1);
      expect(results).toContain('CONVERTED');
      // The loser reports what happened rather than throwing a constraint
      // error at whoever was processing the queue.
      expect(results.filter((result) => result === 'CONVERTED')).toHaveLength(1);
    });

    it('refuses a manual lead whose email already belongs to an active one', async () => {
      const email = freshEmail('manual');

      await ctx.http().post('/api/v1/leads').set(owner()).send(manualLead(email)).expect(201);

      const response = await ctx
        .http()
        .post('/api/v1/leads')
        .set(owner())
        .send(manualLead(email));

      expect(response.status).toBe(409);
      // Named by the key that matched, and carrying the existing lead so the
      // client can offer "open it" without a second round trip.
      expect(response.body.error.message).toContain('email');
      expect(response.body.error.details.existingLeadNumber).toBeDefined();
    });

    it('still lets a person create a second lead on purpose', async () => {
      const email = freshEmail('deliberate');

      await ctx.http().post('/api/v1/leads').set(owner()).send(manualLead(email)).expect(201);

      // The duplicate guard is a safety net, not a wall. Somebody who looked at
      // the existing lead and decided this is separate work may say so, and the
      // acknowledged row is excluded from the index so it can.
      await ctx
        .http()
        .post('/api/v1/leads')
        .set(owner())
        .send({ ...manualLead(email), allowDuplicate: true })
        .expect(201);

      expect(await leadsWithEmail(email)).toHaveLength(2);
    });

    it('does not treat two leads with no email as the same person', async () => {
      const before = await asSystem('e2e count emailless leads', () =>
        prisma().lead.count({ where: { organizationId: ctx.orgA.id, email: null } }),
      );

      await convert((await seedIntake({ phone: freshMobile() })).id);
      await convert((await seedIntake({ phone: freshMobile() })).id);

      const after = await asSystem('e2e count emailless leads', () =>
        prisma().lead.count({ where: { organizationId: ctx.orgA.id, email: null } }),
      );

      // NULL is not a duplicate of NULL. Most leads have no address, and
      // treating absence as a match would refuse the second phone-only enquiry
      // in every tenant.
      expect(after).toBe(before + 2);
    });

    it('never matches on company name', async () => {
      await convert(
        (await seedIntake({ email: freshEmail(), phone: null, company: 'Acme Trading' })).id,
      );
      const outcome = await convert(
        (await seedIntake({ email: freshEmail(), phone: null, company: 'Acme Trading' })).id,
      );

      /*
       * Deliberately NOT a duplicate key, and this was decided explicitly.
       * "Acme Trading" is two buyers at one company as often as it is one
       * person writing twice, and wrongly refusing a lead loses a real
       * customer — a far worse outcome than a duplicate somebody can merge.
       */
      expect(outcome.result).toBe('CONVERTED');
    });
  });

  // ===========================================================================
  // E. The funnel is countable
  // ===========================================================================

  describe('the enquiry funnel counters', () => {
    beforeAll(async () => {
      await routeEverythingSomewhere();
    });

    it('counts an enquiry when it arrives', async () => {
      const before = metrics().snapshot().intake.received;
      await post({
        name: 'Dana Whitfield',
        email: freshEmail('counted'),
        message: 'Please send a quote.',
      });

      expect(metrics().snapshot().intake.received).toBe(before + 1);
    });

    it('does not count a redelivery twice', async () => {
      const eventId = unique('redelivered');
      const payload = {
        name: 'Dana Whitfield',
        email: freshEmail('redelivered'),
        message: 'Please send a quote.',
      };

      await post(payload, { eventId });
      const after = metrics().snapshot().intake.received;
      await post(payload, { eventId });

      // A website retrying a request it already delivered must not inflate the
      // funnel — the second call stores nothing, so it counts nothing.
      expect(metrics().snapshot().intake.received).toBe(after);
    });

    it('counts a conversion', async () => {
      const before = metrics().snapshot().intake.converted;
      await convert((await seedIntake({ email: freshEmail('conv'), phone: null })).id);

      expect(metrics().snapshot().intake.converted).toBe(before + 1);
    });

    it('counts a duplicate as a duplicate, not a conversion', async () => {
      const email = freshEmail('dupcount');
      await convert((await seedIntake({ email, phone: null })).id);

      const before = metrics().snapshot().intake;
      await convert((await seedIntake({ email, phone: null })).id);
      const after = metrics().snapshot().intake;

      expect(after.duplicate).toBe(before.duplicate + 1);
      expect(after.converted).toBe(before.converted);
    });

    it('counts a blocked enquiry', async () => {
      await clearRules();
      const before = metrics().snapshot().intake.blocked;

      const outcome = await convert((await seedIntake({ email: freshEmail('blocked') })).id);
      expect(outcome.result).toBe('BLOCKED');

      expect(metrics().snapshot().intake.blocked).toBe(before + 1);
      await routeEverythingSomewhere();
    });

    it('does not count an already-processed retry as a second conversion', async () => {
      const intake = await seedIntake({ email: freshEmail('retried'), phone: null });
      await convert(intake.id);

      const before = metrics().snapshot().intake.converted;
      const again = await convert(intake.id);

      // ALREADY_PROCESSED is a retry finding work already done. Counting it
      // would overstate the funnel with conversions that never happened.
      expect(again.result).not.toBe('CONVERTED');
      expect(metrics().snapshot().intake.converted).toBe(before);
    });

    it('carries no per-enquiry labels', async () => {
      const email = freshEmail('nolabel');
      const seeded = await seedIntake({ email, phone: null });
      await convert(seeded.id);

      /*
       * Five flat counters and no labels, deliberately.
       *
       * Labelling by submission id, email, phone or lead id would make the
       * cardinality unbounded — one series per customer — and these are
       * in-process counters held in a Map, so an unbounded key space is a
       * memory leak rather than a dashboard. "Which enquiry" is the intake
       * list's job, and it is queryable by submission id.
       */
      const serialised = JSON.stringify(metrics().snapshot().intake);
      expect(serialised).not.toContain(email);
      expect(serialised).not.toContain(seeded.submissionId);
      expect(Object.keys(metrics().snapshot().intake).sort()).toEqual([
        'blocked',
        'converted',
        'duplicate',
        'failed',
        'received',
      ]);
    });

    it('reports failed as zero, because nothing writes that status', async () => {
      /*
       * Declared and never incremented, on purpose.
       *
       * FAILED is a real IntakeStatus that retry accepts and the Admin Control
       * summary counts, but no code path writes it today. Inventing a
       * transition to make this counter move would report failures the pipeline
       * does not have. If this assertion ever fails, something started writing
       * FAILED and this comment is the thing to read first.
       */
      expect(metrics().snapshot().intake.failed).toBe(0);
    });
  });
});
