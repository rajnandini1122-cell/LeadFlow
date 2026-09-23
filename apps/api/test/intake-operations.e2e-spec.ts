import './helpers/intake-processing-env';
import { createTestContext, PASSWORD, type TestContext } from './helpers/test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';

/**
 * The website enquiry queue, over HTTP.
 *
 * An operations surface with exactly one action. Three things every case here
 * is really about:
 *
 *   it READS. There is no create, no edit, no delete, and retry takes no
 *   payload — the customer's submission is the record;
 *
 *   it is scoped. Another organization's enquiry is not found, and the answer
 *   says nothing about whether it exists;
 *
 *   it does not override a decision. A duplicate is refused rather than
 *   converted, because a person is meant to look at it.
 */
describe('Website enquiry operations', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const unique = (prefix: string): string =>
    `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`;

  const owner = () => auth(ctx.orgA.owner.accessToken);
  const prisma = () => ctx.app.get(PrismaService).client;

  const asSystem = async <T>(reason: string, run: () => Promise<T>): Promise<T> =>
    ctx.app.get(TenantContextService).runAsSystem(reason, run);

  let mobileCounter = 70_000_000;
  const freshMobile = (): string => `+9198${String((mobileCounter += 1)).padStart(8, '0')}`;

  const seedIntake = async (
    overrides: Record<string, unknown> = {},
    organizationId = ctx.orgA.id,
  ): Promise<string> => {
    const created = await asSystem('e2e seed intake', () =>
      prisma().integrationIntake.create({
        data: {
          organizationId,
          source: 'WEBSITE',
          externalEventId: unique('evt'),
          eventType: 'ENQUIRY',
          payloadHash: 'b'.repeat(64),
          status: 'RECEIVED',
          name: 'Dana Whitfield',
          email: `${unique('buyer')}@example.test`,
          phone: freshMobile(),
          country: 'IN',
          company: 'Whitfield Foods',
          message: 'We lose enquiries every week. Can we see a demo?',
          productInterest: 'White onion powder',
          sourcePage: '/contact',
          ...overrides,
        },
        select: { id: true },
      }),
    );

    return created.id;
  };

  const teamWithAgent = async () => {
    const team = await ctx
      .http()
      .post('/api/v1/teams')
      .set(owner())
      .send({ name: unique('Team') })
      .expect(201);

    const email = `${unique('agent')}@example.test`;
    const invite = await ctx
      .http()
      .post('/api/v1/users/invite')
      .set(owner())
      .send({ email, fullName: 'Routed Agent', role: 'SALES_REP' })
      .expect(201);

    await ctx
      .http()
      .post(`/api/v1/invitations/${invite.body.data.inviteToken}/accept`)
      .send({ firstName: 'Routed', lastName: 'Agent', password: PASSWORD })
      .expect(200);

    await ctx
      .http()
      .post(`/api/v1/teams/${team.body.data.id}/members`)
      .set(owner())
      .send({ userId: invite.body.data.userId })
      .expect(201);

    return team.body.data.id as string;
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

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await clearRules();
  });

  // ---------------------------------------------------------------------------

  describe('the queue', () => {
    it('lists enquiries newest first, without the signing data', async () => {
      await seedIntake();

      const response = await ctx.http().get('/api/v1/integration-intakes').set(owner()).expect(200);

      expect(response.body.data.total).toBeGreaterThanOrEqual(1);
      const [first] = response.body.data.items;

      expect(first).toMatchObject({ source: 'WEBSITE', status: 'RECEIVED' });
      // Nothing from the public boundary: a signature and a payload hash
      // authenticate a caller and mean nothing to a person reading a queue.
      expect(first).not.toHaveProperty('payloadHash');
      expect(first).not.toHaveProperty('externalEventId');
      // And no message in the LIST: a list is scanned, and the customer's
      // words belong on the record somebody opens deliberately.
      expect(first).not.toHaveProperty('message');
    });

    it('filters by status', async () => {
      await seedIntake();
      await seedIntake({ status: 'PROCESSED' });

      const response = await ctx
        .http()
        .get('/api/v1/integration-intakes?status=PROCESSED')
        .set(owner())
        .expect(200);

      for (const item of response.body.data.items as { status: string }[]) {
        expect(item.status).toBe('PROCESSED');
      }
    });

    it('refuses a status that is not one', async () => {
      await ctx
        .http()
        .get('/api/v1/integration-intakes?status=WHATEVER')
        .set(owner())
        .expect(400);
    });

    it('returns the customer’s own words on the detail', async () => {
      const intakeId = await seedIntake();

      const response = await ctx
        .http()
        .get(`/api/v1/integration-intakes/${intakeId}`)
        .set(owner())
        .expect(200);

      expect(response.body.data.message).toContain('We lose enquiries every week');
      expect(response.body.data).not.toHaveProperty('payloadHash');
    });

    it('offers no delete', async () => {
      const intakeId = await seedIntake();

      const response = await ctx
        .http()
        .delete(`/api/v1/integration-intakes/${intakeId}`)
        .set(owner());

      expect(response.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------

  describe('retry', () => {
    it('converts an enquiry once the configuration is fixed', async () => {
      const intakeId = await seedIntake();

      // No routing yet: the sweep would block it.
      const blocked = await ctx
        .http()
        .post(`/api/v1/integration-intakes/${intakeId}/retry`)
        .set(owner())
        .expect(200);
      expect(blocked.body.data.result).toBe('BLOCKED');
      expect(blocked.body.data.intake.status).toBe('BLOCKED');

      // The administrator adds the missing rule and presses retry.
      const teamId = await teamWithAgent();
      await ctx
        .http()
        .post('/api/v1/assignment-rules')
        .set(owner())
        .send({ name: unique('Website'), isFallback: true, targetTeamId: teamId })
        .expect(201);

      const converted = await ctx
        .http()
        .post(`/api/v1/integration-intakes/${intakeId}/retry`)
        .set(owner())
        .expect(200);

      expect(converted.body.data.result).toBe('CONVERTED');
      expect(converted.body.data.intake.status).toBe('PROCESSED');
      expect(converted.body.data.intake.createdLead).not.toBeNull();
    });

    it('reports the existing lead rather than making a second', async () => {
      const teamId = await teamWithAgent();
      await ctx
        .http()
        .post('/api/v1/assignment-rules')
        .set(owner())
        .send({ name: unique('Website'), isFallback: true, targetTeamId: teamId })
        .expect(201);

      const intakeId = await seedIntake();
      const first = await ctx
        .http()
        .post(`/api/v1/integration-intakes/${intakeId}/retry`)
        .set(owner())
        .expect(200);

      const second = await ctx
        .http()
        .post(`/api/v1/integration-intakes/${intakeId}/retry`)
        .set(owner())
        .expect(200);

      expect(second.body.data.result).toBe('ALREADY_PROCESSED');
      expect(second.body.data.intake.createdLead.id).toBe(
        first.body.data.intake.createdLead.id,
      );

      const leads = await asSystem('e2e lead count', () =>
        prisma().lead.count({
          where: { organizationId: ctx.orgA.id, id: first.body.data.intake.createdLead.id },
        }),
      );
      expect(leads).toBe(1);
    });

    it('refuses to retry a duplicate', async () => {
      const intakeId = await seedIntake({ status: 'DUPLICATE' });

      const response = await ctx
        .http()
        .post(`/api/v1/integration-intakes/${intakeId}/retry`)
        .set(owner());

      // A duplicate is a decision waiting for a person. Retrying it would
      // either do nothing or overrule the review.
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body.error)).toMatch(/duplicate/i);
    });

    it('refuses a body, rather than silently ignoring it', async () => {
      const intakeId = await seedIntake();

      const response = await ctx
        .http()
        .post(`/api/v1/integration-intakes/${intakeId}/retry`)
        .set(owner())
        .send({ name: 'Somebody Else', message: 'rewritten' });

      // Retry re-evaluates what the customer sent. An endpoint that quietly
      // dropped an attempt to change it would be one somebody kept trying.
      expect(response.status).toBe(400);

      const unchanged = await asSystem('e2e unchanged', () =>
        prisma().integrationIntake.findFirst({ where: { id: intakeId } }),
      );
      expect(unchanged?.name).toBe('Dana Whitfield');
    });
  });

  // ---------------------------------------------------------------------------

  describe('who may do what', () => {
    it('refuses a sales rep the queue entirely', async () => {
      const rep = auth(ctx.orgA.rep.accessToken);
      const intakeId = await seedIntake();

      expect((await ctx.http().get('/api/v1/integration-intakes').set(rep)).status).toBe(403);
      expect(
        (await ctx.http().get(`/api/v1/integration-intakes/${intakeId}`).set(rep)).status,
      ).toBe(403);
      expect(
        (await ctx.http().post(`/api/v1/integration-intakes/${intakeId}/retry`).set(rep)).status,
      ).toBe(403);
    });

    it('refuses an unauthenticated caller', async () => {
      expect((await ctx.http().get('/api/v1/integration-intakes')).status).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------

  describe('one organization cannot reach another', () => {
    it('lists only its own enquiries', async () => {
      const mine = await seedIntake();
      const theirs = await seedIntake({}, ctx.orgB.id);

      const response = await ctx
        .http()
        .get('/api/v1/integration-intakes?limit=100')
        .set(owner())
        .expect(200);

      const ids = (response.body.data.items as { id: string }[]).map((item) => item.id);
      expect(ids).toContain(mine);
      expect(ids).not.toContain(theirs);
    });

    it('cannot read or retry another organization’s enquiry', async () => {
      const theirs = await seedIntake({}, ctx.orgB.id);

      // 404 rather than 403: a different answer for a foreign id would confirm
      // that it exists.
      expect(
        (await ctx.http().get(`/api/v1/integration-intakes/${theirs}`).set(owner())).status,
      ).toBe(404);
      expect(
        (await ctx.http().post(`/api/v1/integration-intakes/${theirs}/retry`).set(owner())).status,
      ).toBe(404);

      const untouched = await asSystem('e2e foreign untouched', () =>
        prisma().integrationIntake.findFirst({ where: { id: theirs } }),
      );
      expect(untouched?.status).toBe('RECEIVED');
      expect(untouched?.processingAttempts).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------

  describe('the enquiry behind a lead', () => {
    it('is readable by somebody who can see the lead', async () => {
      const teamId = await teamWithAgent();
      await ctx
        .http()
        .post('/api/v1/assignment-rules')
        .set(owner())
        .send({ name: unique('Website'), isFallback: true, targetTeamId: teamId })
        .expect(201);

      const intakeId = await seedIntake();
      const converted = await ctx
        .http()
        .post(`/api/v1/integration-intakes/${intakeId}/retry`)
        .set(owner())
        .expect(200);

      const leadId = converted.body.data.intake.createdLead.id as string;

      const response = await ctx
        .http()
        .get(`/api/v1/leads/${leadId}/source-intake`)
        .set(owner())
        .expect(200);

      expect(response.body.data).toMatchObject({
        source: 'WEBSITE',
        sourcePage: '/contact',
        productInterest: 'White onion powder',
      });
      expect(response.body.data.message).toContain('We lose enquiries every week');
    });

    it('is null for a lead somebody created by hand', async () => {
      const lead = await ctx
        .http()
        .post('/api/v1/leads')
        .set(owner())
        .send({
          firstName: 'Manual',
          mobile: freshMobile(),
          nextFollowUpAt: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .expect(201);

      const response = await ctx
        .http()
        .get(`/api/v1/leads/${lead.body.data.id}/source-intake`)
        .set(owner())
        .expect(200);

      // Null, not 404: "no enquiry behind it" is an answer, not a missing
      // resource.
      expect(response.body.data).toBeNull();
    });
  });
});
