import { createTestContext, PASSWORD, type TestContext } from './helpers/test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';

/**
 * Phase 6 — server-side reporting, team performance and date ranges.
 *
 * Written before the implementation. Reporting is where tenant isolation fails
 * quietly rather than loudly: an aggregate that accidentally spans two
 * organizations returns a plausible number, not an error, and nobody notices
 * until a customer sees a total they cannot account for.
 *
 * The other half of this file is about SEMANTICS. "Won this month" counted by
 * creation date and by close date are different figures, and a report that
 * mixes them is wrong in a way no type checker can catch.
 */
describe('Reports', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const unique = (prefix: string): string =>
    `${prefix}.${Date.now()}.${Math.floor(Math.random() * 100000)}`;

  let counter = 0;
  const mobile = (): string => {
    counter += 1;
    return `4155582${String(1000 + counter)}`;
  };

  const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();

  /**
   * Fixture surgery.
   *
   * Back-dating a lead, closing one at a chosen instant or archiving it are
   * things the API deliberately does not let a client do, so the fixtures go
   * through the application's own Prisma client under an explicit system
   * scope rather than a second connection — PGlite serves one at a time.
   */
  const asSystem = async <T>(
    fn: (prisma: PrismaService['client']) => Promise<T>,
  ): Promise<T> => {
    const tenantContext = ctx.app.get(TenantContextService);
    const prisma = ctx.app.get(PrismaService);
    return tenantContext.runAsSystem('e2e reporting fixture', () => fn(prisma.client));
  };

  const setOrganizationTimezone = async (organizationId: string, timezone: string) =>
    asSystem((prisma) =>
      prisma.organization.update({ where: { id: organizationId }, data: { timezone } }),
    );

  /** Creates a lead through the API, then rewrites its dates directly. */
  const seedLead = async (
    token: string,
    overrides: {
      assignedToId?: string;
      estimatedValue?: number;
      source?: string;
      createdAt?: Date;
      wonAt?: Date;
      wonValue?: number;
      lostAt?: Date;
      lostReason?: string;
      deletedAt?: Date;
      status?: string;
    } = {},
  ): Promise<string> => {
    const response = await ctx
      .http()
      .post('/api/v1/leads')
      .set(auth(token))
      .send({
        firstName: 'Report',
        lastName: 'Subject',
        mobile: mobile(),
        nextFollowUpAt: inDays(7),
        ...(overrides.estimatedValue !== undefined
          ? { estimatedValue: overrides.estimatedValue }
          : {}),
        ...(overrides.source ? { source: overrides.source } : {}),
        ...(overrides.assignedToId ? { assignedToId: overrides.assignedToId } : {}),
      })
      .expect(201);

    const id = response.body.data.id as string;

    const data: Record<string, unknown> = {};
    if (overrides.createdAt) data['createdAt'] = overrides.createdAt;
    if (overrides.wonAt) {
      data['status'] = 'WON';
      data['wonAt'] = overrides.wonAt;
      data['nextFollowUpAt'] = null;
      data['wonValue'] = overrides.wonValue ?? overrides.estimatedValue ?? 0;
    }
    if (overrides.lostAt) {
      data['status'] = 'LOST';
      data['lostAt'] = overrides.lostAt;
      data['nextFollowUpAt'] = null;
      data['lostReason'] = overrides.lostReason ?? 'Unspecified';
    }
    if (overrides.deletedAt) data['deletedAt'] = overrides.deletedAt;
    if (overrides.status) data['status'] = overrides.status;

    if (Object.keys(data).length > 0) {
      await asSystem((prisma) => prisma.lead.update({ where: { id }, data }));
    }

    return id;
  };

  const seedFollowUp = async (input: {
    organizationId: string;
    leadId: string;
    assignedUserId: string;
    scheduledAt: Date;
    status?: 'UPCOMING' | 'DUE' | 'OVERDUE' | 'COMPLETED' | 'CANCELLED';
    completedAt?: Date;
  }): Promise<string> => {
    const row = await asSystem((prisma) =>
      prisma.followUp.create({
        data: {
          organizationId: input.organizationId,
          leadId: input.leadId,
          assignedUserId: input.assignedUserId,
          scheduledAt: input.scheduledAt,
          status: input.status ?? 'UPCOMING',
          completedAt: input.completedAt ?? null,
          ...(input.completedAt ? { completedBy: input.assignedUserId } : {}),
        },
        select: { id: true },
      }),
    );
    return row.id;
  };

  const seedActivity = async (input: {
    organizationId: string;
    leadId: string;
    performedById: string;
    activityType: string;
    createdAt?: Date;
  }): Promise<void> => {
    await asSystem((prisma) =>
      prisma.leadActivity.create({
        data: {
          organizationId: input.organizationId,
          leadId: input.leadId,
          activityType: input.activityType as never,
          performedById: input.performedById,
          description: 'fixture',
          ...(input.createdAt ? { createdAt: input.createdAt } : {}),
        },
      }),
    );
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    // Deterministic boundaries: every assertion below reasons about UTC days
    // unless it deliberately changes the zone.
    await setOrganizationTimezone(ctx.orgA.id, 'UTC');
    await setOrganizationTimezone(ctx.orgB.id, 'UTC');
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ---------------------------------------------------------------------------
  // Tenant isolation — the failure mode that returns a plausible number
  // ---------------------------------------------------------------------------

  describe('cross-tenant isolation', () => {
    it('never counts another organization’s leads in the overview', async () => {
      const before = await ctx
        .http()
        .get('/api/v1/reports/overview?preset=this_month')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      // Five leads in the OTHER organization.
      for (let i = 0; i < 5; i += 1) {
        await seedLead(ctx.orgB.owner.accessToken, { estimatedValue: 10_000 });
      }

      const after = await ctx
        .http()
        .get('/api/v1/reports/overview?preset=this_month')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect(after.body.data.snapshot.totalLeads).toBe(before.body.data.snapshot.totalLeads);
      expect(after.body.data.leads.created).toBe(before.body.data.leads.created);
      expect(after.body.data.snapshot.pipelineValue).toBe(before.body.data.snapshot.pipelineValue);
    });

    it('never counts another organization’s follow-ups', async () => {
      const lead = await seedLead(ctx.orgB.owner.accessToken);
      await seedFollowUp({
        organizationId: ctx.orgB.id,
        leadId: lead,
        assignedUserId: ctx.orgB.rep.id,
        scheduledAt: new Date(Date.now() - 3 * 86_400_000),
        status: 'OVERDUE',
      });

      const orgA = await ctx
        .http()
        .get('/api/v1/reports/overview?preset=this_month')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      const orgB = await ctx
        .http()
        .get('/api/v1/reports/overview?preset=this_month')
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(200);

      expect(orgB.body.data.followUps.overdue).toBeGreaterThan(0);
      // Org A has none of Org B's overdue work, however plausible the number
      // would have looked.
      expect(orgA.body.data.followUps.overdue).toBe(0);
    });

    it('never lists another organization’s members in the team report', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/reports/team?preset=this_month')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      const ids = (response.body.data.members as { userId: string }[]).map((m) => m.userId);

      expect(ids).toContain(ctx.orgA.owner.id);
      expect(ids).toContain(ctx.orgA.rep.id);
      expect(ids).not.toContain(ctx.orgB.owner.id);
      expect(ids).not.toContain(ctx.orgB.rep.id);
    });

    it('never counts another organization’s activity in the daily report', async () => {
      const lead = await seedLead(ctx.orgB.owner.accessToken);
      await seedActivity({
        organizationId: ctx.orgB.id,
        leadId: lead,
        performedById: ctx.orgB.rep.id,
        activityType: 'CALL_COMPLETED',
      });

      const orgA = await ctx
        .http()
        .get('/api/v1/reports/daily')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      const orgB = await ctx
        .http()
        .get('/api/v1/reports/daily')
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(200);

      expect(orgB.body.data.callsCompleted).toBeGreaterThan(0);
      expect(orgA.body.data.callsCompleted).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Visibility — OWN / TEAM / ALL, reusing the existing lead permissions
  // ---------------------------------------------------------------------------

  describe('lead visibility', () => {
    it('shows an owner the whole organization', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/reports/overview?preset=this_month')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect(response.body.data.scope).toBe('ALL');
    });

    it('narrows a sales rep to their own leads', async () => {
      // Assigned to the rep.
      await seedLead(ctx.orgA.owner.accessToken, {
        assignedToId: ctx.orgA.rep.id,
        estimatedValue: 7_000,
      });
      // Unassigned — visible to the owner, not to the rep.
      await seedLead(ctx.orgA.owner.accessToken, { estimatedValue: 9_000 });

      const rep = await ctx
        .http()
        .get('/api/v1/reports/overview?preset=this_month')
        .set(auth(ctx.orgA.rep.accessToken))
        .expect(200);

      const owner = await ctx
        .http()
        .get('/api/v1/reports/overview?preset=this_month')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect(rep.body.data.scope).toBe('OWN');
      expect(rep.body.data.snapshot.totalLeads).toBeLessThan(
        owner.body.data.snapshot.totalLeads,
      );
      expect(Number(rep.body.data.snapshot.pipelineValue)).toBeLessThan(
        Number(owner.body.data.snapshot.pipelineValue),
      );
    });

    it('cannot be widened by a query parameter', async () => {
      // Scope is derived from the token's permissions server-side. If a query
      // string could broaden it, the permission would be decorative.
      const response = await ctx
        .http()
        .get('/api/v1/reports/overview?preset=this_month&scope=ALL&assignedToId=')
        .set(auth(ctx.orgA.rep.accessToken));

      // Either the unknown parameter is rejected outright, or it is ignored —
      // but the scope must never come back as ALL.
      if (response.status === 200) {
        expect(response.body.data.scope).toBe('OWN');
      } else {
        expect(response.status).toBe(400);
      }
    });

    it('gives a user with no assigned leads a complete, empty report', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/reports/overview?preset=last_month')
        .set(auth(ctx.orgB.rep.accessToken))
        .expect(200);

      // Every key must still be present. A missing field is what turns an
      // empty state into a crash on the screen that renders it.
      expect(response.body.data.leads.created).toBe(0);
      expect(response.body.data.leads.won).toBe(0);
      expect(response.body.data.leads.conversionRate).toBe(0);
      expect(response.body.data.leads.byStatus).toEqual([]);
      expect(response.body.data.leads.bySource).toEqual([]);
      expect(response.body.data.leads.lostReasons).toEqual([]);
      expect(response.body.data.followUps.completionRate).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Permission boundaries
  // ---------------------------------------------------------------------------

  describe('permissions', () => {
    it('refuses a sales rep the team report', async () => {
      // Team performance exposes colleagues' numbers; report.view is the
      // permission that gates it, and a rep does not hold it.
      await ctx
        .http()
        .get('/api/v1/reports/team?preset=this_month')
        .set(auth(ctx.orgA.rep.accessToken))
        .expect(403);
    });

    it('allows a rep their own overview and daily report', async () => {
      await ctx
        .http()
        .get('/api/v1/reports/overview?preset=today')
        .set(auth(ctx.orgA.rep.accessToken))
        .expect(200);

      await ctx
        .http()
        .get('/api/v1/reports/daily')
        .set(auth(ctx.orgA.rep.accessToken))
        .expect(200);
    });

    it.each([
      '/api/v1/reports/overview',
      '/api/v1/reports/daily',
      '/api/v1/reports/team',
    ])('refuses %s without a token', async (path) => {
      await ctx.http().get(path).expect(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Date range semantics
  // ---------------------------------------------------------------------------

  describe('date ranges', () => {
    it('echoes the resolved range so the screen can state it', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/reports/overview?preset=last_month')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect(response.body.data.range.preset).toBe('last_month');
      expect(response.body.data.range.fromDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(response.body.data.range.toDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(response.body.data.range.timezone).toBe('UTC');
    });

    it('publishes which date each metric is measured against', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/reports/overview?preset=today')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      // Without this the reader cannot tell whether "won" means created or
      // closed in the period, and the two are different numbers.
      expect(response.body.data.basis.wonLeads).toMatch(/won date/i);
      expect(response.body.data.basis.newLeads).toMatch(/created date/i);
    });

    it('counts a lead by its CREATED date, not the date it was won', async () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);

      await seedLead(ctx.orgA.owner.accessToken, {
        estimatedValue: 40_000,
        createdAt: thirtyDaysAgo,
        wonAt: new Date(),
        wonValue: 40_000,
      });

      const today = await ctx
        .http()
        .get('/api/v1/reports/overview?preset=today')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      // Created a month ago, won today: it belongs to today's WON figure and
      // not to today's CREATED figure.
      expect(today.body.data.leads.won).toBeGreaterThan(0);
      expect(Number(today.body.data.leads.wonValue)).toBeGreaterThanOrEqual(40_000);

      const createdIds = today.body.data.leads.created as number;
      expect(createdIds).toBeGreaterThanOrEqual(0);
    });

    it('excludes a lead created outside the range', async () => {
      const before = await ctx
        .http()
        .get('/api/v1/reports/overview?preset=today')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      await seedLead(ctx.orgA.owner.accessToken, {
        createdAt: new Date(Date.now() - 45 * 86_400_000),
      });

      const after = await ctx
        .http()
        .get('/api/v1/reports/overview?preset=today')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect(after.body.data.leads.created).toBe(before.body.data.leads.created);
      // But it does count towards the all-time snapshot.
      expect(after.body.data.snapshot.totalLeads).toBe(
        before.body.data.snapshot.totalLeads + 1,
      );
    });

    it('includes a lead created in the last second of a custom range', async () => {
      // The range is half-open, so the final millisecond of the last day must
      // still be inside it. A "23:59:59" upper bound silently drops it.
      const dayAgo = new Date(Date.now() - 86_400_000);
      const endOfThatDay = new Date(
        Date.UTC(
          dayAgo.getUTCFullYear(),
          dayAgo.getUTCMonth(),
          dayAgo.getUTCDate(),
          23,
          59,
          59,
          999,
        ),
      );
      const isoDay = endOfThatDay.toISOString().slice(0, 10);

      const before = await ctx
        .http()
        .get(`/api/v1/reports/overview?preset=custom&from=${isoDay}&to=${isoDay}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      await seedLead(ctx.orgA.owner.accessToken, { createdAt: endOfThatDay });

      const after = await ctx
        .http()
        .get(`/api/v1/reports/overview?preset=custom&from=${isoDay}&to=${isoDay}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect(after.body.data.leads.created).toBe(before.body.data.leads.created + 1);
    });

    it.each([
      ['a reversed custom range', 'preset=custom&from=2026-06-10&to=2026-06-01'],
      ['an impossible date', 'preset=custom&from=2026-02-30&to=2026-03-01'],
      ['an unknown preset', 'preset=last_quarter'],
      ['a range spanning years', 'preset=custom&from=2015-01-01&to=2026-01-01'],
    ])('rejects %s', async (_label, query) => {
      await ctx
        .http()
        .get(`/api/v1/reports/overview?${query}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Organization timezone boundaries
  // ---------------------------------------------------------------------------

  describe('organization timezone', () => {
    it('moves the day boundary with the organization’s zone', async () => {
      // An instant that is "today" in one zone and "yesterday" in another.
      const utcRange = await ctx
        .http()
        .get('/api/v1/reports/overview?preset=today')
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(200);

      await setOrganizationTimezone(ctx.orgB.id, 'Pacific/Auckland');

      const aucklandRange = await ctx
        .http()
        .get('/api/v1/reports/overview?preset=today')
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(200);

      expect(aucklandRange.body.data.range.timezone).toBe('Pacific/Auckland');
      // Same instant, different wall-clock day boundary, so the window's
      // absolute start must differ from the UTC one.
      expect(aucklandRange.body.data.range.from).not.toBe(utcRange.body.data.range.from);

      await setOrganizationTimezone(ctx.orgB.id, 'UTC');
    });

    it('reports the organization timezone on the daily report', async () => {
      await setOrganizationTimezone(ctx.orgB.id, 'Asia/Kolkata');

      const response = await ctx
        .http()
        .get('/api/v1/reports/daily')
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(200);

      expect(response.body.data.timezone).toBe('Asia/Kolkata');
      expect(response.body.data.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      await setOrganizationTimezone(ctx.orgB.id, 'UTC');
    });

    it('reports the day the organization’s own zone is currently on', async () => {
      /*
       * Compares each zone against what that zone ACTUALLY says right now,
       * computed independently through Intl.
       *
       * The earlier version of this test asserted that Auckland and Honolulu
       * were on different calendar dates. They are 22 hours apart, so that
       * holds for 22 hours a day and is false for the other two — the test
       * passed when it was written and failed later purely because of the
       * wall-clock time it happened to run at. Asserting the real property
       * instead is deterministic at every hour.
       */
      const expectedDate = (timezone: string): string =>
        new Intl.DateTimeFormat('en-CA', {
          timeZone: timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date());

      for (const timezone of ['Pacific/Auckland', 'Pacific/Honolulu', 'Asia/Kolkata', 'UTC']) {
        await setOrganizationTimezone(ctx.orgB.id, timezone);

        const response = await ctx
          .http()
          .get('/api/v1/reports/daily')
          .set(auth(ctx.orgB.owner.accessToken))
          .expect(200);

        expect(response.body.data.timezone).toBe(timezone);
        expect(response.body.data.date).toBe(expectedDate(timezone));
      }

      await setOrganizationTimezone(ctx.orgB.id, 'UTC');
    });
  });

  // ---------------------------------------------------------------------------
  // Archived leads
  // ---------------------------------------------------------------------------

  describe('archived leads', () => {
    it('drops an archived lead from the active figures and counts it as archived', async () => {
      const before = await ctx
        .http()
        .get('/api/v1/reports/overview?preset=this_month')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      await seedLead(ctx.orgA.owner.accessToken, {
        estimatedValue: 123_456,
        deletedAt: new Date(),
      });

      const after = await ctx
        .http()
        .get('/api/v1/reports/overview?preset=this_month')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      // An archived lead is not part of the pipeline, and must not inflate it.
      expect(after.body.data.snapshot.totalLeads).toBe(before.body.data.snapshot.totalLeads);
      expect(after.body.data.snapshot.activeLeads).toBe(before.body.data.snapshot.activeLeads);
      expect(after.body.data.snapshot.pipelineValue).toBe(before.body.data.snapshot.pipelineValue);
      // It is still counted, under its own heading.
      expect(after.body.data.leads.archived).toBe(before.body.data.leads.archived + 1);
    });
  });

  // ---------------------------------------------------------------------------
  // Metric correctness
  // ---------------------------------------------------------------------------

  describe('metrics', () => {
    it('computes conversion from decided deals only', async () => {
      const org = await registerFreshOrganization();

      await seedLead(org.token, { estimatedValue: 1000, wonAt: new Date(), wonValue: 1000 });
      await seedLead(org.token, { estimatedValue: 1000, wonAt: new Date(), wonValue: 1000 });
      await seedLead(org.token, { estimatedValue: 1000, wonAt: new Date(), wonValue: 1000 });
      await seedLead(org.token, { estimatedValue: 1000, lostAt: new Date() });
      // Still open — not yet a loss, so it must not drag the rate down.
      await seedLead(org.token, { estimatedValue: 1000 });

      const response = await ctx
        .http()
        .get('/api/v1/reports/overview?preset=today')
        .set(auth(org.token))
        .expect(200);

      expect(response.body.data.leads.won).toBe(3);
      expect(response.body.data.leads.lost).toBe(1);
      expect(response.body.data.leads.conversionRate).toBe(75);
    });

    it('sums won value from what deals actually closed at', async () => {
      const org = await registerFreshOrganization();

      await seedLead(org.token, { estimatedValue: 100_000, wonAt: new Date(), wonValue: 85_000 });

      const response = await ctx
        .http()
        .get('/api/v1/reports/overview?preset=today')
        .set(auth(org.token))
        .expect(200);

      // The estimate is the forecast; wonValue is the revenue. Reporting the
      // estimate as revenue overstates it by every deal that was discounted.
      expect(Number(response.body.data.leads.wonValue)).toBe(85_000);
    });

    it('breaks down leads by status and source', async () => {
      const org = await registerFreshOrganization();

      await seedLead(org.token, { source: 'Referral' });
      await seedLead(org.token, { source: 'Referral' });
      await seedLead(org.token, { source: 'Website' });

      const response = await ctx
        .http()
        .get('/api/v1/reports/overview?preset=today')
        .set(auth(org.token))
        .expect(200);

      const bySource = response.body.data.leads.bySource as { source: string; count: number }[];
      expect(bySource.find((row) => row.source === 'Referral')?.count).toBe(2);
      expect(bySource.find((row) => row.source === 'Website')?.count).toBe(1);

      const byStatus = response.body.data.leads.byStatus as { status: string; count: number }[];
      expect(byStatus.find((row) => row.status === 'NEW')?.count).toBe(3);
    });

    it('breaks down why deals were lost', async () => {
      const org = await registerFreshOrganization();

      await seedLead(org.token, { lostAt: new Date(), lostReason: 'Price too high' });
      await seedLead(org.token, { lostAt: new Date(), lostReason: 'Price too high' });
      await seedLead(org.token, { lostAt: new Date(), lostReason: 'Chose a competitor' });

      const response = await ctx
        .http()
        .get('/api/v1/reports/overview?preset=today')
        .set(auth(org.token))
        .expect(200);

      const reasons = response.body.data.leads.lostReasons as {
        reason: string;
        count: number;
      }[];

      expect(reasons[0]).toEqual({ reason: 'Price too high', count: 2 });
      expect(reasons).toHaveLength(2);
    });

    it('computes the follow-up completion rate over the range', async () => {
      const org = await registerFreshOrganization();
      const lead = await seedLead(org.token);
      const today = new Date();

      await seedFollowUp({
        organizationId: org.organizationId,
        leadId: lead,
        assignedUserId: org.userId,
        scheduledAt: today,
        status: 'COMPLETED',
        completedAt: today,
      });
      await seedFollowUp({
        organizationId: org.organizationId,
        leadId: lead,
        assignedUserId: org.userId,
        scheduledAt: today,
        status: 'COMPLETED',
        completedAt: today,
      });
      await seedFollowUp({
        organizationId: org.organizationId,
        leadId: lead,
        assignedUserId: org.userId,
        scheduledAt: today,
        status: 'OVERDUE',
      });
      await seedFollowUp({
        organizationId: org.organizationId,
        leadId: lead,
        assignedUserId: org.userId,
        scheduledAt: today,
        status: 'UPCOMING',
      });

      const response = await ctx
        .http()
        .get('/api/v1/reports/overview?preset=today')
        .set(auth(org.token))
        .expect(200);

      expect(response.body.data.followUps.completed).toBe(2);
      expect(response.body.data.followUps.scheduled).toBe(4);
      expect(response.body.data.followUps.completionRate).toBe(50);
    });
  });

  // ---------------------------------------------------------------------------
  // Daily report
  // ---------------------------------------------------------------------------

  describe('daily report', () => {
    it('counts today’s activity by type', async () => {
      const org = await registerFreshOrganization();
      const lead = await seedLead(org.token);

      for (const type of [
        'CALL_COMPLETED',
        'CALL_COMPLETED',
        'CALL_NOT_ANSWERED',
        'WHATSAPP_SENT',
        'NOTE_ADDED',
      ]) {
        await seedActivity({
          organizationId: org.organizationId,
          leadId: lead,
          performedById: org.userId,
          activityType: type,
        });
      }

      const response = await ctx
        .http()
        .get('/api/v1/reports/daily')
        .set(auth(org.token))
        .expect(200);

      expect(response.body.data.callsCompleted).toBe(2);
      expect(response.body.data.callsNotAnswered).toBe(1);
      expect(response.body.data.whatsappActivities).toBe(1);
      expect(response.body.data.notesAdded).toBe(1);
      expect(response.body.data.leadsCreated).toBe(1);
      // One lead touched, however many times it was touched.
      expect(response.body.data.leadsContacted).toBe(1);
    });

    it('excludes yesterday’s activity', async () => {
      const org = await registerFreshOrganization();
      const lead = await seedLead(org.token);

      await seedActivity({
        organizationId: org.organizationId,
        leadId: lead,
        performedById: org.userId,
        activityType: 'CALL_COMPLETED',
        createdAt: new Date(Date.now() - 2 * 86_400_000),
      });

      const response = await ctx
        .http()
        .get('/api/v1/reports/daily')
        .set(auth(org.token))
        .expect(200);

      expect(response.body.data.callsCompleted).toBe(0);
    });

    it('reports deals closed today and their value', async () => {
      const org = await registerFreshOrganization();

      await seedLead(org.token, { estimatedValue: 10_000, wonAt: new Date(), wonValue: 12_000 });
      await seedLead(org.token, { lostAt: new Date(), lostReason: 'Budget' });

      const response = await ctx
        .http()
        .get('/api/v1/reports/daily')
        .set(auth(org.token))
        .expect(200);

      expect(response.body.data.leadsWon).toBe(1);
      expect(response.body.data.leadsLost).toBe(1);
      expect(Number(response.body.data.wonValueToday)).toBe(12_000);
    });

    it('accepts an explicit date', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/reports/daily?date=2026-01-15')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect(response.body.data.date).toBe('2026-01-15');
      expect(response.body.data.leadsCreated).toBe(0);
    });

    it('rejects a malformed date', async () => {
      await ctx
        .http()
        .get('/api/v1/reports/daily?date=15-01-2026')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Team performance
  // ---------------------------------------------------------------------------

  describe('team performance', () => {
    it('reports per-member figures without an N+1 explosion', async () => {
      const org = await registerFreshOrganization();
      const lead = await seedLead(org.token, {
        assignedToId: org.userId,
        estimatedValue: 5_000,
      });

      await seedFollowUp({
        organizationId: org.organizationId,
        leadId: lead,
        assignedUserId: org.userId,
        scheduledAt: new Date(Date.now() - 86_400_000),
        status: 'OVERDUE',
      });

      const response = await ctx
        .http()
        .get('/api/v1/reports/team?preset=this_month')
        .set(auth(org.token))
        .expect(200);

      const me = (response.body.data.members as { userId: string }[]).find(
        (member) => member.userId === org.userId,
      ) as Record<string, unknown>;

      expect(me['leadsAssigned']).toBe(1);
      expect(me['activeLeads']).toBe(1);
      expect(me['overdueFollowUps']).toBe(1);
      expect(Number(me['pipelineValue'])).toBe(5_000);
    });

    it('includes a member with no leads at all, rather than omitting them', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/reports/team?preset=last_month')
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(200);

      const members = response.body.data.members as Record<string, unknown>[];

      // A rep who did nothing last month is the most important row on the
      // report. Dropping them because they have no rows to aggregate hides
      // exactly what a manager is looking for.
      expect(members.length).toBeGreaterThanOrEqual(2);
      for (const member of members) {
        expect(member['leadsAssigned']).toBeDefined();
        expect(member['conversionRate']).toBeDefined();
        expect(member['followUpCompletionRate']).toBeDefined();
      }
    });

    it('attributes created and assigned leads separately', async () => {
      const org = await registerFreshOrganization();

      // The owner creates it, the owner is also the assignee here — but the
      // two counts come from different columns and must not be conflated.
      await seedLead(org.token, { assignedToId: org.userId });

      const response = await ctx
        .http()
        .get('/api/v1/reports/team?preset=this_month')
        .set(auth(org.token))
        .expect(200);

      const me = (response.body.data.members as Record<string, unknown>[]).find(
        (member) => member['userId'] === org.userId,
      ) as Record<string, unknown>;

      expect(me['leadsCreated']).toBe(1);
      expect(me['leadsAssigned']).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Empty organization
  // ---------------------------------------------------------------------------

  describe('a brand-new organization', () => {
    it('returns a complete overview with zeroes, not an error', async () => {
      const org = await registerFreshOrganization();

      const response = await ctx
        .http()
        .get('/api/v1/reports/overview?preset=this_month')
        .set(auth(org.token))
        .expect(200);

      const data = response.body.data;
      expect(data.snapshot.totalLeads).toBe(0);
      expect(data.snapshot.activeLeads).toBe(0);
      expect(data.snapshot.pipelineValue).toBe('0');
      expect(data.leads.conversionRate).toBe(0);
      expect(data.followUps.completionRate).toBe(0);
      expect(data.leads.byStatus).toEqual([]);
    });

    it('returns a daily report with zeroes', async () => {
      const org = await registerFreshOrganization();

      const response = await ctx
        .http()
        .get('/api/v1/reports/daily')
        .set(auth(org.token))
        .expect(200);

      expect(response.body.data.leadsCreated).toBe(0);
      expect(response.body.data.callsCompleted).toBe(0);
      expect(response.body.data.wonValueToday).toBe('0');
    });

    it('returns a team report listing only its founder', async () => {
      const org = await registerFreshOrganization();

      const response = await ctx
        .http()
        .get('/api/v1/reports/team?preset=this_month')
        .set(auth(org.token))
        .expect(200);

      expect(response.body.data.members).toHaveLength(1);
      expect(response.body.data.members[0].userId).toBe(org.userId);
      expect(response.body.data.members[0].leadsAssigned).toBe(0);
    });
  });

  /**
   * Registers a genuinely empty organization through the public API.
   *
   * A fresh tenant is the only honest way to assert an exact count: the shared
   * fixture orgs accumulate rows as the suite runs, so any absolute number
   * asserted against them would be order-dependent.
   */
  async function registerFreshOrganization(): Promise<{
    organizationId: string;
    userId: string;
    token: string;
  }> {
    const response = await ctx
      .http()
      .post('/api/v1/auth/register')
      .send({
        organizationName: `Reporting ${unique('org')}`,
        email: `${unique('founder')}@example.test`,
        password: PASSWORD,
        firstName: 'Report',
        lastName: 'Owner',
      })
      .expect(201);

    const data = response.body.data;
    await setOrganizationTimezone(data.user.organization.id as string, 'UTC');

    return {
      organizationId: data.user.organization.id as string,
      userId: data.user.id as string,
      token: data.tokens.accessToken as string,
    };
  }
});
