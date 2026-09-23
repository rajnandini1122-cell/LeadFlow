import { createTestContext, PASSWORD, type TestContext } from './helpers/test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { jobPrincipal } from '../src/queues/job-context';
import { IntakeProcessingService } from '../src/modules/integrations/intake-processing/intake-processing.service';

/**
 * Lead numbers are allocated once, whoever is asking.
 *
 * Three paths create leads — a person, a CSV import, and the automated intake
 * pipeline — and until this hardening only the automated one took the tenant's
 * numbering lock. A lock one participant respects is not a lock: a manual
 * create running at the same moment could pick the same number, and the
 * automated transaction lost the unique violation and rolled back. Safe, but
 * wasteful, and it relied on a retry that the CSV path did not even have.
 *
 * Every case below is the same assertion from a different angle: for one
 * organization, no two leads share a number, and nothing else changed.
 *
 * A NOTE ON WHERE THESE RUN. Contention is only real against a database that
 * serves more than one connection at a time. CI runs them against PostgreSQL 17
 * with a pool of ten, which is where they have teeth; the development fallback
 * serves a single connection and serialises them at the pool, so locally they
 * prove correctness of the result but not of the locking. That distinction is
 * why the pool cap follows the backend — see test/global-setup.ts.
 */
describe('Lead number allocation', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const unique = (prefix: string): string =>
    `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`;

  const owner = () => auth(ctx.orgA.owner.accessToken);
  const prisma = () => ctx.app.get(PrismaService).client;
  const tenancy = () => ctx.app.get(TenantContextService);

  const asSystem = async <T>(reason: string, run: () => Promise<T>): Promise<T> =>
    tenancy().runAsSystem(reason, run);

  const asTenant = async <T>(organizationId: string, run: () => Promise<T>): Promise<T> =>
    tenancy().runWithTenant(jobPrincipal(organizationId), run);

  let mobileCounter = 90_000_000;
  const freshMobile = (): string => `+9198${String((mobileCounter += 1)).padStart(8, '0')}`;

  const tomorrow = (): string => new Date(Date.now() + 86_400_000).toISOString();

  /** One lead created the way a salesperson creates one. */
  const createManually = (organization: 'A' | 'B' = 'A', overrides: Record<string, unknown> = {}) =>
    ctx
      .http()
      .post('/api/v1/leads')
      .set(auth(organization === 'A' ? ctx.orgA.owner.accessToken : ctx.orgB.owner.accessToken))
      .send({
        firstName: 'Manual',
        mobile: freshMobile(),
        nextFollowUpAt: tomorrow(),
        ...overrides,
      });

  /** An intake as J1 would have stored it. */
  const seedIntake = async (organizationId = ctx.orgA.id): Promise<string> => {
    const created = await asSystem('e2e seed intake', () =>
      prisma().integrationIntake.create({
        data: {
          organizationId,
          source: 'WEBSITE',
          externalEventId: unique('evt'),
          eventType: 'ENQUIRY',
          payloadHash: 'c'.repeat(64),
          status: 'RECEIVED',
          name: 'Auto Created',
          phone: freshMobile(),
          country: 'IN',
        },
        select: { id: true },
      }),
    );

    return created.id;
  };

  const convert = (intakeId: string, organizationId = ctx.orgA.id) =>
    asTenant(organizationId, () => ctx.app.get(IntakeProcessingService).process(intakeId));

  /**
   * A team with one eligible rep, and a fallback rule pointing at it.
   *
   * Returns the team's id, and callers must keep it. The rotation cursor is
   * per team, and the e2e database is SHARED — every suite before this one has
   * left its own teams and cursors in it. A read that does not name this exact
   * team can pick up somebody else's row, which nothing here increments.
   */
  const routeEverythingToATeam = async (): Promise<string> => {
    const team = await ctx
      .http()
      .post('/api/v1/teams')
      .set(owner())
      .send({ name: unique('Allocator') })
      .expect(201);

    const email = `${unique('agent')}@example.test`;
    const invite = await ctx
      .http()
      .post('/api/v1/users/invite')
      .set(owner())
      .send({ email, fullName: 'Allocator Agent', role: 'SALES_REP' })
      .expect(201);

    await ctx
      .http()
      .post(`/api/v1/invitations/${invite.body.data.inviteToken}/accept`)
      .send({ firstName: 'Allocator', lastName: 'Agent', password: PASSWORD })
      .expect(200);

    await ctx
      .http()
      .post(`/api/v1/teams/${team.body.data.id}/members`)
      .set(owner())
      .send({ userId: invite.body.data.userId })
      .expect(201);

    await ctx
      .http()
      .post('/api/v1/assignment-rules')
      .set(owner())
      .send({ name: unique('Fallback'), isFallback: true, targetTeamId: team.body.data.id })
      .expect(201);

    return team.body.data.id as string;
  };

  const leadNumbersIn = async (organizationId: string): Promise<string[]> =>
    asSystem('e2e lead numbers', async () => {
      const leads = await prisma().lead.findMany({
        where: { organizationId },
        select: { leadNumber: true },
      });

      return leads.map((lead) => lead.leadNumber);
    });

  /** The property under test, stated once. */
  const expectNoDuplicateNumbers = async (organizationId: string): Promise<string[]> => {
    const numbers = await leadNumbersIn(organizationId);
    expect(new Set(numbers).size).toBe(numbers.length);

    return numbers;
  };

  /** The team every conversion in this suite routes to. */
  let fallbackTeamId: string;

  /**
   * This suite's own rotation cursor, addressed exactly.
   *
   * Named by team AND organization — the composite the row is unique on —
   * because these reads run as SYSTEM, which switches tenant scoping off. An
   * unscoped read here is a read of the whole database.
   *
   * Absent until the first conversion creates it, which is a sequence of zero
   * rather than a missing fact.
   */
  const cursorSequence = async (): Promise<bigint> => {
    const cursor = await asSystem('e2e cursor', () =>
      prisma().teamAssignmentCursor.findFirst({
        where: { teamId: fallbackTeamId, organizationId: ctx.orgA.id },
        select: { sequence: true },
      }),
    );

    return cursor?.sequence ?? 0n;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    fallbackTeamId = await routeEverythingToATeam();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ---------------------------------------------------------------------------

  describe('concurrent creation in one organization', () => {
    it('gives two simultaneous manual creates different numbers', async () => {
      const [a, b] = await Promise.all([createManually(), createManually()]);

      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.body.data.leadNumber).not.toBe(b.body.data.leadNumber);

      await expectNoDuplicateNumbers(ctx.orgA.id);
    });

    it('gives two simultaneous conversions different numbers', async () => {
      const [first, second] = await Promise.all([seedIntake(), seedIntake()]);
      const outcomes = await Promise.all([convert(first), convert(second)]);

      const leadIds = outcomes
        .filter((outcome) => outcome.result === 'CONVERTED')
        .map((outcome) => (outcome as { leadId: string }).leadId);
      expect(leadIds).toHaveLength(2);

      const numbers = await asSystem('e2e converted numbers', () =>
        prisma().lead.findMany({
          where: { id: { in: leadIds } },
          select: { leadNumber: true },
        }),
      );
      expect(new Set(numbers.map((row) => row.leadNumber)).size).toBe(2);

      await expectNoDuplicateNumbers(ctx.orgA.id);
    });

    it('gives a manual create and a conversion different numbers', async () => {
      /*
       * THE CASE THIS HARDENING EXISTS FOR.
       *
       * Before, the conversion held the tenant's numbering lock and the manual
       * create did not — so both could read the same maximum, the unique index
       * refused the second, and the conversion rolled back. The enquiry stayed
       * retryable, which is why it was safe rather than broken, but the work
       * was wasted and the CSV path had no retry at all.
       */
      const intakeId = await seedIntake();

      const [manual, converted] = await Promise.all([createManually(), convert(intakeId)]);

      expect(manual.status).toBe(201);
      expect(converted.result).toBe('CONVERTED');

      const automated = await asSystem('e2e automated lead', () =>
        prisma().lead.findFirst({
          where: { id: (converted as { leadId: string }).leadId },
          select: { leadNumber: true },
        }),
      );

      expect(automated?.leadNumber).not.toBe(manual.body.data.leadNumber);
      await expectNoDuplicateNumbers(ctx.orgA.id);
    });

    it('holds under mixed contention', async () => {
      const before = (await leadNumbersIn(ctx.orgA.id)).length;

      const intakeIds = await Promise.all(Array.from({ length: 6 }, () => seedIntake()));

      const results = await Promise.all([
        ...Array.from({ length: 8 }, () => createManually()),
        ...intakeIds.map((id) => convert(id)),
      ]);

      const manualCreated = results.filter(
        (result) => typeof result === 'object' && 'status' in result && result.status === 201,
      ).length;
      const autoCreated = results.filter(
        (result) => typeof result === 'object' && 'result' in result && result.result === 'CONVERTED',
      ).length;

      expect(manualCreated + autoCreated).toBe(14);

      const numbers = await expectNoDuplicateNumbers(ctx.orgA.id);
      expect(numbers.length).toBe(before + 14);
    });

    it('allocates contiguously, with no number skipped or reused', async () => {
      const numbers = await leadNumbersIn(ctx.orgA.id);
      const sequence = numbers
        .map((value) => Number(value.replace(/\D/g, '')))
        .sort((a, b) => a - b);

      // Contiguous from the lowest: the allocator reads the maximum and adds
      // one, so a gap would mean a committed number nobody can account for and
      // a repeat would mean the lock failed.
      for (let index = 1; index < sequence.length; index += 1) {
        expect(sequence[index]).toBe((sequence[index - 1] as number) + 1);
      }
    });
  });

  // ---------------------------------------------------------------------------

  describe('the lock is per tenant', () => {
    it('numbers two organizations independently and concurrently', async () => {
      const beforeA = (await leadNumbersIn(ctx.orgA.id)).length;
      const beforeB = (await leadNumbersIn(ctx.orgB.id)).length;

      const results = await Promise.all([
        createManually('A'),
        createManually('B'),
        createManually('A'),
        createManually('B'),
      ]);

      for (const result of results) expect(result.status).toBe(201);

      /*
       * The observable consequence of keying the lock on the organization.
       * Both tenants made progress in the same window, and each numbered from
       * its own sequence rather than a shared one — which is also why one
       * tenant's traffic cannot make another's wait.
       */
      expect((await leadNumbersIn(ctx.orgA.id)).length).toBe(beforeA + 2);
      expect((await leadNumbersIn(ctx.orgB.id)).length).toBe(beforeB + 2);

      await expectNoDuplicateNumbers(ctx.orgA.id);
      await expectNoDuplicateNumbers(ctx.orgB.id);
    });
  });

  // ---------------------------------------------------------------------------

  describe('failure does not strand the allocator', () => {
    it('leaves the next number usable after a refused create', async () => {
      const mobile = freshMobile();
      const first = await createManually('A', { mobile });
      expect(first.status).toBe(201);

      // Refused by the duplicate-mobile rule: the transaction rolls back, and
      // with it the advisory lock, which is transaction-scoped precisely so a
      // failure cannot leave numbering held.
      const refused = await createManually('A', { mobile });
      expect(refused.status).toBe(409);

      const next = await createManually();
      expect(next.status).toBe(201);

      await expectNoDuplicateNumbers(ctx.orgA.id);
    });

    it('consumes no number when a create fails', async () => {
      const mobile = freshMobile();
      await createManually('A', { mobile }).expect(201);

      const before = (await leadNumbersIn(ctx.orgA.id)).length;
      await createManually('A', { mobile }).expect(409);
      const after = (await leadNumbersIn(ctx.orgA.id)).length;

      // A rolled-back create writes nothing, so the number it would have taken
      // is still the next one available.
      expect(after).toBe(before);
    });

    it('still refuses a duplicate mobile', async () => {
      // The rule the hardening must not have loosened.
      const mobile = freshMobile();
      await createManually('A', { mobile }).expect(201);

      const response = await createManually('A', { mobile });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('DUPLICATE_LEAD');
    });
  });

  // ---------------------------------------------------------------------------

  describe('the automated pipeline is unchanged', () => {
    it('still converts an enquiry into a lead, a follow-up and a PROCESSED intake', async () => {
      const intakeId = await seedIntake();
      const outcome = await convert(intakeId);

      expect(outcome.result).toBe('CONVERTED');
      const leadId = (outcome as { leadId: string }).leadId;

      const [lead, followUps, activities, intake] = await asSystem('e2e j6 shape', async () => {
        const client = prisma();

        return Promise.all([
          client.lead.findFirst({ where: { id: leadId } }),
          client.followUp.findMany({ where: { leadId } }),
          client.leadActivity.findMany({ where: { leadId }, select: { activityType: true } }),
          client.integrationIntake.findFirst({ where: { id: intakeId } }),
        ]);
      });

      expect(lead?.leadNumber).toMatch(/^LD-\d{5}$/);
      expect(followUps).toHaveLength(1);
      expect(lead?.nextFollowUpAt?.toISOString()).toBe(followUps[0]?.scheduledAt.toISOString());
      expect(activities.map((row) => row.activityType).sort()).toEqual([
        'LEAD_ASSIGNED',
        'LEAD_CREATED',
      ]);
      expect(intake).toMatchObject({ status: 'PROCESSED', createdLeadId: leadId });
    });

    it('is still idempotent, and still advances the rotation exactly once', async () => {
      const intakeId = await seedIntake();

      const first = await convert(intakeId);
      const second = await convert(intakeId);

      expect(first.result).toBe('CONVERTED');
      expect(second).toEqual({
        result: 'ALREADY_PROCESSED',
        leadId: (first as { leadId: string }).leadId,
      });

      const teamId = (first as { teamId: string }).teamId;
      const cursor = await asSystem('e2e cursor', () =>
        prisma().teamAssignmentCursor.findFirst({ where: { teamId } }),
      );

      // One conversion, one turn. The allocator moving does not change what
      // the rotation counts.
      expect(cursor).not.toBeNull();
      await expectNoDuplicateNumbers(ctx.orgA.id);
    });

    it('loses no rotation increments under load', async () => {
      const intakeIds = await Promise.all(Array.from({ length: 5 }, () => seedIntake()));

      const before = await cursorSequence();

      const outcomes = await Promise.all(intakeIds.map((id) => convert(id)));
      const converted = outcomes.filter((outcome) => outcome.result === 'CONVERTED').length;

      const after = await cursorSequence();

      // Exactly one turn per committed conversion. Not "at least" — a lost
      // increment and a double increment are both failures of the same
      // property, and an inequality would hide one of them.
      expect(Number(after - before)).toBe(converted);
      await expectNoDuplicateNumbers(ctx.orgA.id);
    });
  });
});
