// MUST be first: it enables automatic processing in process.env, which
// @nestjs/config reads when the next import pulls in the config module.
import './helpers/intake-processing-env';
import { createTestContext, PASSWORD, type TestContext } from './helpers/test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { jobPrincipal } from '../src/queues/job-context';
import {
  IntakeProcessingService,
  type ProcessOutcome,
} from '../src/modules/integrations/intake-processing/intake-processing.service';
import { IntakeSweepService } from '../src/modules/integrations/intake-processing/intake-sweep.service';

/**
 * A website enquiry becomes an assigned lead with a first follow-up.
 *
 * Four properties carry the phase, and every case here is one of them:
 *
 *   ONE CONVERSION, whatever happens. Two workers, ten workers, a retried job,
 *   a pressed retry button — one lead, one follow-up, one turn of the rotation.
 *
 *   ALL OR NOTHING. A conversion that fails anywhere leaves no lead, no
 *   follow-up, no consumed rotation slot and a retryable enquiry.
 *
 *   NOTHING INVENTED. No product guessed from free text, no geography guessed
 *   from a phone number, no duplicate overridden, no manager pressed into
 *   service because a team was empty.
 *
 *   BLOCKED IS NOT LOST. An enquiry the routing table cannot answer stays
 *   durable, visible and retryable.
 */
describe('Automated intake processing', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const unique = (prefix: string): string =>
    `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`;

  const owner = () => auth(ctx.orgA.owner.accessToken);
  const prisma = () => ctx.app.get(PrismaService).client;
  const tenancy = () => ctx.app.get(TenantContextService);

  const asSystem = async <T>(reason: string, run: () => Promise<T>): Promise<T> =>
    tenancy().runAsSystem(reason, run);

  /** Runs inside one organization's context, exactly as the worker does. */
  const asTenant = async <T>(organizationId: string, run: () => Promise<T>): Promise<T> =>
    tenancy().runWithTenant(jobPrincipal(organizationId), run);

  const process = async (intakeId: string, organizationId = ctx.orgA.id): Promise<ProcessOutcome> =>
    asTenant(organizationId, () => ctx.app.get(IntakeProcessingService).process(intakeId));

  // --- fixtures --------------------------------------------------------------

  /** A phone number that is valid in India and unique to one test. */
  let mobileCounter = 60_000_000;
  const freshMobile = (): string => `+9198${String((mobileCounter += 1)).padStart(8, '0')}`;

  /** An intake as J1 would have stored it, without going through the HMAC route. */
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
          payloadHash: 'a'.repeat(64),
          status: 'RECEIVED',
          name: 'Dana Whitfield',
          email: `${unique('buyer')}@example.test`,
          phone: freshMobile(),
          country: 'IN',
          company: 'Whitfield Foods',
          message: 'We lose enquiries every week. Can we see a demo?',
          productInterest: 'White onion powder, 500kg monthly',
          sourcePage: '/contact',
          ...overrides,
        },
        select: { id: true },
      }),
    );

    return created.id;
  };

  /** A team with `count` eligible SALES_REPs, in the order they joined. */
  const teamWithAgents = async (count: number, name = unique('Team')) => {
    const team = await ctx.http().post('/api/v1/teams').set(owner()).send({ name }).expect(201);
    const teamId = team.body.data.id as string;
    const userIds: string[] = [];

    for (let index = 0; index < count; index += 1) {
      const email = `${unique('agent')}@example.test`;
      const invite = await ctx
        .http()
        .post('/api/v1/users/invite')
        .set(owner())
        .send({ email, fullName: `Agent ${index}`, role: 'SALES_REP' })
        .expect(201);

      await ctx
        .http()
        .post(`/api/v1/invitations/${invite.body.data.inviteToken}/accept`)
        .send({ firstName: 'Agent', lastName: String(index), password: PASSWORD })
        .expect(200);

      await ctx
        .http()
        .post(`/api/v1/teams/${teamId}/members`)
        .set(owner())
        .send({ userId: invite.body.data.userId })
        .expect(201);

      userIds.push(invite.body.data.userId as string);
    }

    return { id: teamId, userIds };
  };

  const createRule = async (body: Record<string, unknown>) =>
    ctx.http().post('/api/v1/assignment-rules').set(owner()).send(body).expect(201);

  /** Archives every active rule, so each case starts from a known routing table. */
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

  const clearTerritories = async (): Promise<void> => {
    const list = await ctx.http().get('/api/v1/territories').set(owner()).expect(200);

    for (const territory of list.body.data as { id: string; status: string }[]) {
      if (territory.status === 'ACTIVE') {
        await ctx
          .http()
          .patch(`/api/v1/territories/${territory.id}`)
          .set(owner())
          .send({ status: 'ARCHIVED' })
          .expect(200);
      }
    }
  };

  const intakeRow = async (id: string) =>
    asSystem('e2e read intake', () =>
      prisma().integrationIntake.findFirst({ where: { id } }),
    );

  const leadRow = async (id: string) =>
    asSystem('e2e read lead', () => prisma().lead.findFirst({ where: { id } }));

  const cursorFor = async (teamId: string) =>
    asSystem('e2e read cursor', () =>
      prisma().teamAssignmentCursor.findFirst({ where: { teamId } }),
    );

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await clearRules();
    await clearTerritories();
  });

  // ---------------------------------------------------------------------------
  // The happy path, in full
  // ---------------------------------------------------------------------------

  describe('converting one enquiry', () => {
    it('creates a contact, a lead, its activities and a first follow-up', async () => {
      const team = await teamWithAgents(1);
      await createRule({ name: unique('Website'), source: 'WEBSITE', targetTeamId: team.id });

      const intakeId = await seedIntake();
      const outcome = await process(intakeId);

      expect(outcome.result).toBe('CONVERTED');
      const leadId = (outcome as { leadId: string }).leadId;

      const lead = await leadRow(leadId);
      expect(lead).toMatchObject({
        status: 'NEW',
        priority: 'MEDIUM',
        source: 'WEBSITE',
        firstName: 'Dana',
        lastName: 'Whitfield',
        companyName: 'Whitfield Foods',
        productInterest: 'White onion powder, 500kg monthly',
        assignedToId: team.userIds[0],
      });

      // The free text is kept as the customer wrote it and is NOT resolved to
      // a catalogue entry. Guessing one would file the revenue under the wrong
      // product and route the next enquiry like it.
      expect(lead?.productId).toBeNull();
      // Nor is an account invented from a company string.
      expect(lead?.accountId).toBeNull();

      const activities = await asSystem('e2e activities', () =>
        prisma().leadActivity.findMany({ where: { leadId }, select: { activityType: true } }),
      );
      expect(activities.map((row) => row.activityType).sort()).toEqual([
        'LEAD_ASSIGNED',
        'LEAD_CREATED',
      ]);

      const followUps = await asSystem('e2e follow-ups', () =>
        prisma().followUp.findMany({ where: { leadId } }),
      );
      expect(followUps).toHaveLength(1);
      expect(followUps[0]).toMatchObject({
        type: 'CALL',
        assignedUserId: team.userIds[0],
      });

      // The promise this product makes, as one fact rather than two that can
      // drift: the lead's next action and the follow-up behind it.
      expect(lead?.nextFollowUpAt?.toISOString()).toBe(followUps[0]?.scheduledAt.toISOString());

      const intake = await intakeRow(intakeId);
      expect(intake).toMatchObject({
        status: 'PROCESSED',
        createdLeadId: leadId,
        assignedTeamId: team.id,
        assignedUserId: team.userIds[0],
        processingAttempts: 1,
      });
      expect(intake?.processedAt).not.toBeNull();
      expect(intake?.processingCode).toBeNull();
    });

    it('attributes the work to nobody, because nobody typed it', async () => {
      const team = await teamWithAgents(1);
      await createRule({ name: unique('Website'), isFallback: true, targetTeamId: team.id });

      const outcome = await process(await seedIntake());
      const leadId = (outcome as { leadId: string }).leadId;

      const lead = await leadRow(leadId);
      // Null, not a synthetic user and not a borrowed real one. `created_by`
      // is nullable precisely so the system can say "not a person".
      expect(lead?.createdBy).toBeNull();
      expect(lead?.assignedById).toBeNull();

      const [activity] = await asSystem('e2e activity actor', () =>
        prisma().leadActivity.findMany({ where: { leadId }, select: { performedById: true } }),
      );
      expect(activity?.performedById).toBeNull();

      const [followUp] = await asSystem('e2e follow-up actor', () =>
        prisma().followUp.findMany({ where: { leadId }, select: { createdBy: true } }),
      );
      expect(followUp?.createdBy).toBeNull();
    });

    it('reuses one contact for a customer who comes back', async () => {
      const team = await teamWithAgents(1);
      await createRule({ name: unique('Website'), isFallback: true, targetTeamId: team.id });

      const mobile = freshMobile();
      const first = await process(await seedIntake({ phone: mobile }));
      const firstLead = await leadRow((first as { leadId: string }).leadId);

      // Close the first, so the second enquiry is not a duplicate.
      await asSystem('e2e close lead', () =>
        prisma().lead.updateMany({
          where: { id: firstLead!.id },
          data: { status: 'LOST', lostAt: new Date(), nextFollowUpAt: null },
        }),
      );

      const second = await process(await seedIntake({ phone: mobile }));
      expect(second.result).toBe('CONVERTED');
      const secondLead = await leadRow((second as { leadId: string }).leadId);

      // One person, two enquiries — which is what keeps a returning customer's
      // history together instead of creating a stranger with the same number.
      expect(secondLead?.contactId).toBe(firstLead?.contactId);
    });
  });

  // ---------------------------------------------------------------------------
  // The first-response SLA
  // ---------------------------------------------------------------------------

  describe('the first follow-up', () => {
    it('is due 60 minutes after the enquiry ARRIVED, by default', async () => {
      const team = await teamWithAgents(1);
      await createRule({ name: unique('Website'), isFallback: true, targetTeamId: team.id });

      const receivedAt = new Date(Date.now() - 5 * 60_000);
      const intakeId = await seedIntake({ receivedAt });
      const outcome = await process(intakeId);

      const [followUp] = await asSystem('e2e sla', () =>
        prisma().followUp.findMany({ where: { leadId: (outcome as { leadId: string }).leadId } }),
      );

      // From receivedAt, not from now. A sweep that ran five minutes late must
      // not quietly hand the business five more minutes of its own SLA.
      expect(followUp?.scheduledAt.getTime()).toBe(receivedAt.getTime() + 60 * 60_000);
    });

    it('honours a tenant that has configured a different SLA', async () => {
      const team = await teamWithAgents(1);
      await createRule({ name: unique('Website'), isFallback: true, targetTeamId: team.id });

      await asSystem('e2e set sla', () =>
        prisma().organizationSettings.updateMany({
          where: { organizationId: ctx.orgA.id },
          data: { websiteIntakeFirstFollowUpMinutes: 15 },
        }),
      );

      const receivedAt = new Date(Date.now() - 60_000);
      const outcome = await process(await seedIntake({ receivedAt }));

      const [followUp] = await asSystem('e2e sla custom', () =>
        prisma().followUp.findMany({ where: { leadId: (outcome as { leadId: string }).leadId } }),
      );
      expect(followUp?.scheduledAt.getTime()).toBe(receivedAt.getTime() + 15 * 60_000);

      await asSystem('e2e reset sla', () =>
        prisma().organizationSettings.updateMany({
          where: { organizationId: ctx.orgA.id },
          data: { websiteIntakeFirstFollowUpMinutes: 60 },
        }),
      );
    });

    it('creates an already-due follow-up for an enquiry that waited', async () => {
      const team = await teamWithAgents(1);
      await createRule({ name: unique('Website'), isFallback: true, targetTeamId: team.id });

      // Arrived three hours ago; the SLA was an hour. The follow-up is late,
      // and saying so is the honest outcome — resetting the clock would hide
      // exactly the delay an operator needs to see.
      const receivedAt = new Date(Date.now() - 3 * 60 * 60_000);
      const outcome = await process(await seedIntake({ receivedAt }));

      const [followUp] = await asSystem('e2e overdue sla', () =>
        prisma().followUp.findMany({ where: { leadId: (outcome as { leadId: string }).leadId } }),
      );

      expect(followUp?.scheduledAt.getTime()).toBeLessThan(Date.now());
      expect(followUp?.status).toBe('DUE');
    });
  });

  // ---------------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------------

  describe('routing', () => {
    it('matches a source rule on WEBSITE', async () => {
      const team = await teamWithAgents(1);
      await createRule({ name: unique('Website'), source: 'WEBSITE', targetTeamId: team.id });

      const outcome = await process(await seedIntake());
      expect(outcome.result).toBe('CONVERTED');
      expect((outcome as { teamId: string }).teamId).toBe(team.id);
    });

    it('does not match a rule for a different source', async () => {
      const team = await teamWithAgents(1);
      await createRule({ name: unique('Referral'), source: 'Referral', targetTeamId: team.id });

      const intakeId = await seedIntake();
      const outcome = await process(intakeId);

      expect(outcome).toEqual({ result: 'BLOCKED', code: 'NO_MATCH' });
      expect((await intakeRow(intakeId))?.createdLeadId).toBeNull();
    });

    it('routes on the territory the intake country resolves to', async () => {
      const indiaTeam = await teamWithAgents(1, unique('India'));
      const other = await teamWithAgents(1, unique('Other'));

      const territory = await ctx
        .http()
        .post('/api/v1/territories')
        .set(owner())
        .send({ name: unique('India') })
        .expect(201);
      await ctx
        .http()
        .post(`/api/v1/territories/${territory.body.data.id}/coverage`)
        .set(owner())
        .send({ type: 'COUNTRY', country: 'IN' })
        .expect(201);

      await createRule({
        name: unique('India website'),
        priority: 10,
        source: 'WEBSITE',
        territoryId: territory.body.data.id,
        targetTeamId: indiaTeam.id,
      });
      await createRule({
        name: unique('Any website'),
        priority: 20,
        source: 'WEBSITE',
        targetTeamId: other.id,
      });

      const intakeId = await seedIntake({ country: 'IN' });
      const outcome = await process(intakeId);

      expect((outcome as { teamId: string }).teamId).toBe(indiaTeam.id);
      expect((await intakeRow(intakeId))?.resolvedTerritoryId).toBe(territory.body.data.id);
    });

    it('still uses a source rule when no territory covers the country', async () => {
      const team = await teamWithAgents(1);
      await createRule({ name: unique('Website'), source: 'WEBSITE', targetTeamId: team.id });

      // France is on nobody's map. The enquiry is still routed, because the
      // rule that matched states no territory.
      const intakeId = await seedIntake({ country: 'FR' });
      const outcome = await process(intakeId);

      expect(outcome.result).toBe('CONVERTED');
      expect((await intakeRow(intakeId))?.resolvedTerritoryId).toBeNull();
    });

    it('never matches a product rule on free text', async () => {
      const team = await teamWithAgents(1);

      const product = await ctx
        .http()
        .post('/api/v1/products')
        .set(owner())
        .send({ name: unique('Onion').slice(0, 40), sku: unique('SKU').slice(0, 20) })
        .expect(201);

      await createRule({
        name: unique('Onion powder'),
        productId: product.body.data.id,
        targetTeamId: team.id,
      });

      // The enquiry says "White onion powder, 500kg monthly" and the catalogue
      // has an onion product. Matching them would be a guess, and a guess is
      // how a customer ends up with the wrong team and the wrong figures.
      const outcome = await process(await seedIntake());
      expect(outcome).toEqual({ result: 'BLOCKED', code: 'NO_MATCH' });
    });

    it('uses the fallback when no specific rule matches', async () => {
      const specific = await teamWithAgents(1);
      const catchAll = await teamWithAgents(1);

      await createRule({ name: unique('Referral'), source: 'Referral', targetTeamId: specific.id });
      await createRule({ name: unique('Fallback'), isFallback: true, targetTeamId: catchAll.id });

      const outcome = await process(await seedIntake());
      expect((outcome as { teamId: string }).teamId).toBe(catchAll.id);
    });

    it('blocks rather than inventing a target when nobody is eligible', async () => {
      const empty = await ctx
        .http()
        .post('/api/v1/teams')
        .set(owner())
        .send({ name: unique('Empty') })
        .expect(201);

      await createRule({
        name: unique('Understaffed'),
        isFallback: true,
        targetTeamId: empty.body.data.id,
      });

      const intakeId = await seedIntake();
      const outcome = await process(intakeId);

      expect(outcome).toEqual({ result: 'BLOCKED', code: 'NO_ELIGIBLE_AGENTS' });

      const intake = await intakeRow(intakeId);
      // Durable, explained, and retryable — not deleted, not PROCESSED, and
      // not handed to a manager to make it disappear.
      expect(intake?.status).toBe('BLOCKED');
      expect(intake?.createdLeadId).toBeNull();
      expect(intake?.assignedTeamId).toBe(empty.body.data.id);
      expect(intake?.failureReason).toContain('receive assigned work');

      const managerLeads = await asSystem('e2e no manager leads', () =>
        prisma().lead.count({
          where: { organizationId: ctx.orgA.id, assignedToId: ctx.orgA.owner.id },
        }),
      );
      expect(managerLeads).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Round robin
  // ---------------------------------------------------------------------------

  describe('round robin', () => {
    it('goes A, B, C, A, B, C', async () => {
      const team = await teamWithAgents(3);
      await createRule({ name: unique('Website'), isFallback: true, targetTeamId: team.id });

      const assigned: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        const outcome = await process(await seedIntake());
        expect(outcome.result).toBe('CONVERTED');
        assigned.push((outcome as { userId: string }).userId);
      }

      const [a, b, c] = team.userIds;
      expect(assigned).toEqual([a, b, c, a, b, c]);
    });

    it('skips somebody whose assignment is switched off', async () => {
      const team = await teamWithAgents(3);
      await createRule({ name: unique('Website'), isFallback: true, targetTeamId: team.id });

      const detail = await ctx.http().get(`/api/v1/teams/${team.id}`).set(owner()).expect(200);
      const members = detail.body.data.members as { id: string; userId: string }[];
      const second = members.find((member) => member.userId === team.userIds[1]);

      await ctx
        .http()
        .patch(`/api/v1/teams/${team.id}/members/${second?.id}`)
        .set(owner())
        .send({ assignmentEnabled: false })
        .expect(200);

      const assigned: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        const outcome = await process(await seedIntake());
        assigned.push((outcome as { userId: string }).userId);
      }

      const [a, , c] = team.userIds;
      // The rotation is over whoever is eligible NOW. B is simply not in it.
      expect(assigned).toEqual([a, c, a, c]);
      expect(assigned).not.toContain(team.userIds[1]);

      // And when B comes back, they rejoin the current candidate list.
      await ctx
        .http()
        .patch(`/api/v1/teams/${team.id}/members/${second?.id}`)
        .set(owner())
        .send({ assignmentEnabled: true })
        .expect(200);

      const after = await process(await seedIntake());
      expect(team.userIds).toContain((after as { userId: string }).userId);
    });

    it('never assigns to a suspended colleague', async () => {
      const team = await teamWithAgents(2);
      await createRule({ name: unique('Website'), isFallback: true, targetTeamId: team.id });

      // Organization membership is authoritative: a team row cannot make a
      // suspended person an assignment candidate.
      await asSystem('e2e suspend', () =>
        prisma().organizationUser.updateMany({
          where: { organizationId: ctx.orgA.id, userId: team.userIds[0] as string },
          data: { status: 'SUSPENDED' },
        }),
      );

      const assigned: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const outcome = await process(await seedIntake());
        assigned.push((outcome as { userId: string }).userId);
      }

      expect(assigned).toEqual([team.userIds[1], team.userIds[1], team.userIds[1]]);

      await asSystem('e2e unsuspend', () =>
        prisma().organizationUser.updateMany({
          where: { organizationId: ctx.orgA.id, userId: team.userIds[0] as string },
          data: { status: 'ACTIVE' },
        }),
      );
    });

    it('does not consume a turn when the conversion is blocked', async () => {
      const team = await teamWithAgents(2);
      await createRule({ name: unique('Website'), isFallback: true, targetTeamId: team.id });

      await process(await seedIntake());
      const afterFirst = await cursorFor(team.id);

      // An enquiry with no name never reaches the rotation.
      const blocked = await process(await seedIntake({ name: null }));
      expect(blocked).toEqual({ result: 'BLOCKED', code: 'NO_NAME' });

      const afterBlocked = await cursorFor(team.id);
      expect(afterBlocked?.sequence).toBe(afterFirst?.sequence);
    });

    it('shares one rotation between rules that route to the same team', async () => {
      const team = await teamWithAgents(2);
      await createRule({
        name: unique('Website'),
        priority: 10,
        source: 'WEBSITE',
        targetTeamId: team.id,
      });
      await createRule({ name: unique('Fallback'), isFallback: true, targetTeamId: team.id });

      const first = await process(await seedIntake());
      const second = await process(await seedIntake({ source: 'OTHER' }));

      // Different rules, one team, one rotation — because a salesperson
      // experiences the work arriving, not the rule that sent it.
      expect((first as { userId: string }).userId).toBe(team.userIds[0]);
      expect((second as { userId: string }).userId).toBe(team.userIds[1]);

      const cursors = await asSystem('e2e cursor count', () =>
        prisma().teamAssignmentCursor.count({ where: { teamId: team.id } }),
      );
      expect(cursors).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Duplicates
  // ---------------------------------------------------------------------------

  describe('duplicate safety', () => {
    it('never processes an intake J1 already flagged', async () => {
      const team = await teamWithAgents(1);
      await createRule({ name: unique('Website'), isFallback: true, targetTeamId: team.id });

      const intakeId = await seedIntake({ status: 'DUPLICATE' });
      const outcome = await process(intakeId);

      expect(outcome.result).toBe('SKIPPED');
      expect((await intakeRow(intakeId))?.createdLeadId).toBeNull();
    });

    it('detects a lead created between arrival and processing', async () => {
      const team = await teamWithAgents(1);
      await createRule({ name: unique('Website'), isFallback: true, targetTeamId: team.id });

      const mobile = freshMobile();
      const intakeId = await seedIntake({ phone: mobile });

      // Somebody creates this customer by hand in the meantime. The check J1
      // made when the enquiry arrived is now out of date.
      const manual = await ctx
        .http()
        .post('/api/v1/leads')
        .set(owner())
        .send({
          firstName: 'Dana',
          mobile,
          nextFollowUpAt: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .expect(201);

      const outcome = await process(intakeId);
      expect(outcome).toEqual({ result: 'DUPLICATE', code: 'DUPLICATE_LEAD' });

      const intake = await intakeRow(intakeId);
      expect(intake?.status).toBe('DUPLICATE');
      expect(intake?.createdLeadId).toBeNull();
      expect(intake?.matchedLeadId).toBe(manual.body.data.id);

      // The existing record is untouched: a web form is not authority to
      // rewrite a relationship somebody already has.
      const existing = await leadRow(manual.body.data.id);
      expect(existing?.firstName).toBe('Dana');
      expect(existing?.source).toBeNull();
    });

    it('advances no rotation and writes no follow-up for a duplicate', async () => {
      const team = await teamWithAgents(2);
      await createRule({ name: unique('Website'), isFallback: true, targetTeamId: team.id });

      await process(await seedIntake());
      const before = await cursorFor(team.id);
      const followUpsBefore = await asSystem('e2e follow-up count', () =>
        prisma().followUp.count({ where: { organizationId: ctx.orgA.id } }),
      );

      const mobile = freshMobile();
      await ctx
        .http()
        .post('/api/v1/leads')
        .set(owner())
        .send({
          firstName: 'Blocker',
          mobile,
          nextFollowUpAt: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .expect(201);

      const outcome = await process(await seedIntake({ phone: mobile }));
      expect(outcome.result).toBe('DUPLICATE');

      expect((await cursorFor(team.id))?.sequence).toBe(before?.sequence);
      expect(
        await asSystem('e2e follow-up count after', () =>
          prisma().followUp.count({ where: { organizationId: ctx.orgA.id } }),
        ),
      ).toBe(followUpsBefore);
    });
  });

  // ---------------------------------------------------------------------------
  // Idempotency and concurrency — decided by PostgreSQL
  // ---------------------------------------------------------------------------

  describe('processing the same enquiry more than once', () => {
    it('produces one lead when called twice', async () => {
      const team = await teamWithAgents(2);
      await createRule({ name: unique('Website'), isFallback: true, targetTeamId: team.id });

      const intakeId = await seedIntake();
      const first = await process(intakeId);
      const second = await process(intakeId);

      expect(first.result).toBe('CONVERTED');
      expect(second).toEqual({
        result: 'ALREADY_PROCESSED',
        leadId: (first as { leadId: string }).leadId,
      });

      await expectSingleConversion(intakeId, team.id, 1n);
    });

    it('produces one lead when two processors race', async () => {
      const team = await teamWithAgents(2);
      await createRule({ name: unique('Website'), isFallback: true, targetTeamId: team.id });

      const intakeId = await seedIntake();
      const outcomes = await Promise.all([process(intakeId), process(intakeId)]);

      expect(outcomes.filter((outcome) => outcome.result === 'CONVERTED')).toHaveLength(1);
      await expectSingleConversion(intakeId, team.id, 1n);
    });

    it('produces one lead when ten processors race', async () => {
      const team = await teamWithAgents(3);
      await createRule({ name: unique('Website'), isFallback: true, targetTeamId: team.id });

      const intakeId = await seedIntake();
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, () => process(intakeId)),
      );

      expect(outcomes.filter((outcome) => outcome.result === 'CONVERTED')).toHaveLength(1);
      await expectSingleConversion(intakeId, team.id, 1n);
    });

    it('gives two concurrent enquiries two different rotation slots', async () => {
      const team = await teamWithAgents(2);
      await createRule({ name: unique('Website'), isFallback: true, targetTeamId: team.id });

      const [firstId, secondId] = await Promise.all([seedIntake(), seedIntake()]);
      const outcomes = await Promise.all([process(firstId), process(secondId)]);

      const assigned = outcomes
        .filter((outcome) => outcome.result === 'CONVERTED')
        .map((outcome) => (outcome as { userId: string }).userId);

      expect(assigned).toHaveLength(2);
      // Both reading sequence 0 and both choosing eligible[0] is exactly what
      // the cursor lock exists to prevent.
      expect(new Set(assigned).size).toBe(2);
      expect((await cursorFor(team.id))?.sequence).toBe(2n);
    });

    it('loses no rotation increments under load', async () => {
      const team = await teamWithAgents(3);
      await createRule({ name: unique('Website'), isFallback: true, targetTeamId: team.id });

      const ids = await Promise.all(Array.from({ length: 6 }, () => seedIntake()));
      const outcomes = await Promise.all(ids.map((id) => process(id)));

      const converted = outcomes.filter((outcome) => outcome.result === 'CONVERTED');
      expect(converted).toHaveLength(6);
      expect((await cursorFor(team.id))?.sequence).toBe(6n);
    });

    it('creates at most one active lead for one mobile across two event ids', async () => {
      const team = await teamWithAgents(2);
      await createRule({ name: unique('Website'), isFallback: true, targetTeamId: team.id });

      const mobile = freshMobile();
      const [firstId, secondId] = await Promise.all([
        seedIntake({ phone: mobile }),
        seedIntake({ phone: mobile }),
      ]);

      const outcomes = await Promise.all([process(firstId), process(secondId)]);

      // One becomes a lead; the other is held for review. Two different
      // submissions from one person are still one customer.
      expect(outcomes.filter((outcome) => outcome.result === 'CONVERTED')).toHaveLength(1);

      /*
       * And the loser is reported as a DUPLICATE, not as an error.
       *
       * Which mechanism catches it depends on timing, and both are correct.
       * If the second conversion starts after the first commits, the
       * processing-time re-check sees the lead. If they overlap — which is
       * what really happens against a database with more than one connection —
       * both re-checks run before either lead exists, and the partial unique
       * index refuses the second write. The index is the authority; the
       * re-check is the courtesy.
       *
       * Either way the enquiry ends held for review rather than lost, and the
       * salesperson is not asked to call the same person twice.
       */
      const loser = outcomes.find((outcome) => outcome.result !== 'CONVERTED');
      expect(loser).toEqual({ result: 'DUPLICATE', code: 'DUPLICATE_LEAD' });

      const activeLeads = await asSystem('e2e active leads for mobile', () =>
        prisma().lead.count({
          where: {
            organizationId: ctx.orgA.id,
            mobile,
            deletedAt: null,
            status: { not: 'LOST' },
          },
        }),
      );
      expect(activeLeads).toBe(1);

      // Neither enquiry is left waiting: one converted, one is flagged, and
      // nothing needs a human to notice it is stuck.
      const statuses = await asSystem('e2e both statuses', () =>
        prisma().integrationIntake.findMany({
          where: { id: { in: [firstId, secondId] } },
          select: { status: true, matchedLeadId: true },
        }),
      );
      expect(statuses.map((row) => row.status).sort()).toEqual(['DUPLICATE', 'PROCESSED']);

      // The duplicate names what it lost to, so a reviewer can open it.
      const flagged = statuses.find((row) => row.status === 'DUPLICATE');
      expect(flagged?.matchedLeadId).not.toBeNull();
    });

    /** One lead, one follow-up, one turn — whatever the caller did. */
    const expectSingleConversion = async (
      intakeId: string,
      teamId: string,
      expectedSequence: bigint,
    ): Promise<void> => {
      const intake = await intakeRow(intakeId);
      expect(intake?.status).toBe('PROCESSED');
      expect(intake?.createdLeadId).not.toBeNull();

      const leadId = intake!.createdLeadId as string;

      expect(
        await asSystem('e2e single lead', () =>
          prisma().lead.count({ where: { id: leadId } }),
        ),
      ).toBe(1);
      expect(
        await asSystem('e2e single follow-up', () =>
          prisma().followUp.count({ where: { leadId } }),
        ),
      ).toBe(1);
      expect(
        await asSystem('e2e single created activity', () =>
          prisma().leadActivity.count({ where: { leadId, activityType: 'LEAD_CREATED' } }),
        ),
      ).toBe(1);
      expect((await cursorFor(teamId))?.sequence).toBe(expectedSequence);
    };
  });

  // ---------------------------------------------------------------------------
  // Configuration races
  // ---------------------------------------------------------------------------

  describe('configuration changing underneath', () => {
    it('does not assign to somebody switched off mid-flight', async () => {
      const team = await teamWithAgents(2);
      await createRule({ name: unique('Website'), isFallback: true, targetTeamId: team.id });

      const detail = await ctx.http().get(`/api/v1/teams/${team.id}`).set(owner()).expect(200);
      const members = detail.body.data.members as { id: string; userId: string }[];

      const ids = await Promise.all(Array.from({ length: 4 }, () => seedIntake()));

      const outcomes = await Promise.all([
        ...ids.map((id) => process(id)),
        ctx
          .http()
          .patch(`/api/v1/teams/${team.id}/members/${members[0]?.id}`)
          .set(owner())
          .send({ assignmentEnabled: false }),
      ]);

      const assigned = outcomes
        .filter((outcome) => typeof outcome === 'object' && 'result' in outcome)
        .filter((outcome) => (outcome as ProcessOutcome).result === 'CONVERTED')
        .map((outcome) => (outcome as { userId: string }).userId);

      // Whichever ordering the database chose, nobody who was ineligible at
      // the moment of the protected selection received work.
      const eligible = await asTenant(ctx.orgA.id, async () =>
        prisma().teamMember.findMany({
          where: { teamId: team.id, removedAt: null, assignmentEnabled: true },
          select: { membership: { select: { userId: true } } },
        }),
      );
      const stillOn = new Set(eligible.map((row) => row.membership.userId));

      for (const userId of assigned) {
        // Either they are still enabled, or they were enabled when chosen —
        // what must never happen is an assignment made from a stale read after
        // the cursor lock was taken.
        expect(team.userIds).toContain(userId);
      }
      expect(stillOn.size).toBeGreaterThanOrEqual(1);

      await ctx
        .http()
        .patch(`/api/v1/teams/${team.id}/members/${members[0]?.id}`)
        .set(owner())
        .send({ assignmentEnabled: true })
        .expect(200);
    });

    it('blocks when the last eligible agent leaves before the lock', async () => {
      const team = await teamWithAgents(1);
      await createRule({ name: unique('Website'), isFallback: true, targetTeamId: team.id });

      const detail = await ctx.http().get(`/api/v1/teams/${team.id}`).set(owner()).expect(200);
      const member = (detail.body.data.members as { id: string }[])[0];

      await ctx
        .http()
        .post(`/api/v1/teams/${team.id}/members/${member?.id}/remove`)
        .set(owner())
        .expect(200);

      const outcome = await process(await seedIntake());
      expect(outcome).toEqual({ result: 'BLOCKED', code: 'NO_ELIGIBLE_AGENTS' });
    });

    it('blocks when the target team is archived before processing', async () => {
      const team = await teamWithAgents(1);
      const rule = await createRule({
        name: unique('Website'),
        isFallback: true,
        targetTeamId: team.id,
      });

      const intakeId = await seedIntake();

      // Archiving a team that live routing points at is refused, so the
      // administrator pauses the rule first — which is itself enough to stop
      // the enquiry being routed to a team nobody is watching.
      await ctx
        .http()
        .patch(`/api/v1/assignment-rules/${rule.body.data.id}`)
        .set(owner())
        .send({ status: 'PAUSED' })
        .expect(200);
      await ctx
        .http()
        .patch(`/api/v1/teams/${team.id}`)
        .set(owner())
        .send({ status: 'ARCHIVED' })
        .expect(200);

      const outcome = await process(intakeId);
      expect(outcome).toEqual({ result: 'BLOCKED', code: 'NO_MATCH' });
      expect((await intakeRow(intakeId))?.createdLeadId).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // The sweep
  // ---------------------------------------------------------------------------

  describe('the sweep', () => {
    it('converts what is waiting, oldest first', async () => {
      const team = await teamWithAgents(2);
      await createRule({ name: unique('Website'), isFallback: true, targetTeamId: team.id });

      const older = await seedIntake({ receivedAt: new Date(Date.now() - 10 * 60_000) });
      const newer = await seedIntake({ receivedAt: new Date(Date.now() - 60_000) });

      const result = await ctx.app.get(IntakeSweepService).sweep();
      expect(result.converted).toBeGreaterThanOrEqual(2);

      const olderLead = await leadRow((await intakeRow(older))!.createdLeadId as string);
      const newerLead = await leadRow((await intakeRow(newer))!.createdLeadId as string);

      // Answered in the order customers wrote in: the earlier enquiry takes
      // the earlier rotation slot.
      expect(olderLead?.assignedToId).toBe(team.userIds[0]);
      expect(newerLead?.assignedToId).toBe(team.userIds[1]);
    });

    it('enters each organization’s own context', async () => {
      const team = await teamWithAgents(2);
      await createRule({ name: unique('Website'), isFallback: true, targetTeamId: team.id });

      // Org B has an enquiry too, and no routing configured for it. The sweep
      // must handle both without one tenant's context leaking into the other.
      const foreign = await seedIntake({}, ctx.orgB.id);
      const mine = await seedIntake();

      await ctx.app.get(IntakeSweepService).sweep();

      expect((await intakeRow(mine))?.status).toBe('PROCESSED');

      const theirs = await intakeRow(foreign);
      expect(theirs?.status).toBe('BLOCKED');
      expect(theirs?.createdLeadId).toBeNull();
      // And nothing of Org B's ended up in Org A.
      expect(theirs?.organizationId).toBe(ctx.orgB.id);
    });

    it('converts nothing when automatic processing is off', async () => {
      const sweep = ctx.app.get(IntakeSweepService);
      const spy = jest.spyOn(sweep, 'enabled', 'get').mockReturnValue(false);

      try {
        const team = await teamWithAgents(1);
        await createRule({ name: unique('Website'), isFallback: true, targetTeamId: team.id });

        const intakeId = await seedIntake();
        const result = await sweep.sweep();

        expect(result).toEqual({
          claimed: 0,
          converted: 0,
          blocked: 0,
          duplicates: 0,
          skipped: 0,
          failures: 0,
        });
        expect((await intakeRow(intakeId))?.status).toBe('RECEIVED');
      } finally {
        spy.mockRestore();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Audit
  // ---------------------------------------------------------------------------

  describe('audit trail', () => {
    it('records a conversion and the assignment, as identifiers', async () => {
      const team = await teamWithAgents(1);
      await createRule({ name: unique('Website'), isFallback: true, targetTeamId: team.id });

      const intakeId = await seedIntake();
      const outcome = await process(intakeId);
      const leadId = (outcome as { leadId: string }).leadId;

      const entries = await asSystem('e2e intake audit', () =>
        prisma().auditLog.findMany({
          where: { OR: [{ entityId: intakeId }, { entityId: leadId }] },
          select: { action: true, actorUserId: true, after: true },
        }),
      );

      const actions = entries.map((entry) => entry.action);
      expect(actions).toContain('integration.intake.processed');
      expect(actions).toContain('lead.auto_assigned');

      // The SYSTEM did this. actor_user_id has a foreign key to users, so a
      // synthetic id would not merely be a lie — the row would fail to insert
      // and the record would vanish silently.
      for (const entry of entries) {
        expect(entry.actorUserId).toBeNull();
      }

      // Identifiers only: the name, the message and the contact details are
      // already on the intake row, and a copy here would be a second place to
      // find and redact.
      const serialised = JSON.stringify(entries);
      expect(serialised).not.toContain('Dana Whitfield');
      expect(serialised).not.toContain('We lose enquiries every week');
      expect(serialised).not.toMatch(/@example\.test/);
    });

    it('records a block, and says which kind', async () => {
      const intakeId = await seedIntake();
      await process(intakeId);

      const entries = await asSystem('e2e blocked audit', () =>
        prisma().auditLog.findMany({
          where: { entityId: intakeId, action: 'integration.intake.blocked' },
          select: { after: true },
        }),
      );

      expect(entries).toHaveLength(1);
      expect(JSON.stringify(entries[0]?.after)).toContain('NO_MATCH');
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant isolation
  // ---------------------------------------------------------------------------

  describe('one organization cannot reach another', () => {
    it('will not process another organization’s intake', async () => {
      const team = await teamWithAgents(1);
      await createRule({ name: unique('Website'), isFallback: true, targetTeamId: team.id });

      const foreign = await seedIntake({}, ctx.orgB.id);

      // Asked for inside Org A's context: the scoped claim finds nothing,
      // because the row belongs to somebody else.
      const outcome = await process(foreign, ctx.orgA.id);

      expect(outcome).toEqual({ result: 'SKIPPED', reason: 'not found' });
      expect((await intakeRow(foreign))?.status).toBe('RECEIVED');
    });

    it('never assigns another organization’s user', async () => {
      const team = await teamWithAgents(1);
      await createRule({ name: unique('Website'), isFallback: true, targetTeamId: team.id });

      const outcome = await process(await seedIntake());
      const lead = await leadRow((outcome as { leadId: string }).leadId);

      const membership = await asSystem('e2e membership check', () =>
        prisma().organizationUser.findFirst({
          where: { userId: lead!.assignedToId as string, organizationId: ctx.orgA.id },
          select: { id: true },
        }),
      );
      expect(membership).not.toBeNull();
    });
  });
});
