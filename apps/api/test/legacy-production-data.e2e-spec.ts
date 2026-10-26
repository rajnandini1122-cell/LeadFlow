import { randomUUID } from 'node:crypto';
import { createTestContext, type TestContext } from './helpers/test-app';
import { fixtureMobile } from './helpers/phone-fixtures';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';

/**
 * Data shapes that exist in PRODUCTION today, written by the code before this
 * release, and must be worked correctly by the code after it.
 *
 * Found in a restored copy of the 2026-10-26 production backup:
 *   * 102 assigned, dated leads with NO open follow-up. Creating a lead used to
 *     set `leads.next_follow_up_at` only, so the lead was in no queue at all.
 *   * 3 leads with TWO open follow-ups. "No answer" used to schedule nothing,
 *     so people added a second follow-up by hand and the first stayed open.
 *
 * Both shapes are built here directly in the database, the way the old code
 * left them, and then worked through the API exactly as the app does.
 */
describe('Legacy production data', () => {
  let ctx: TestContext;

  const owner = () => ({ Authorization: `Bearer ${ctx.orgA.owner.accessToken}` });
  const inHours = (h: number): string => {
    const d = new Date(Date.now() + h * 3_600_000);
    d.setUTCSeconds(0, 0); // the dialog's datetime-local has minute precision
    return d.toISOString();
  };
  const hoursAgo = (h: number): Date => new Date(Date.now() - h * 3_600_000);

  const prisma = () => ctx.app.get(PrismaService).client;
  const asSystem = async <T>(reason: string, run: () => Promise<T>): Promise<T> =>
    ctx.app.get(TenantContextService).runAsSystem(reason, run);

  const OPEN = ['UPCOMING', 'DUE', 'OVERDUE'] as const;
  const openFor = async (leadId: string) =>
    asSystem('e2e open follow-ups', () =>
      prisma().followUp.findMany({
        where: { leadId, status: { in: [...OPEN] } },
        select: { id: true, scheduledAt: true, assignedUserId: true },
        orderBy: { scheduledAt: 'asc' },
      }),
    );
  const statusOf = async (id: string) =>
    (await asSystem('e2e follow-up', () => prisma().followUp.findFirst({ where: { id }, select: { status: true } })))
      ?.status;
  const mirror = async (leadId: string) =>
    (
      await asSystem('e2e lead', () =>
        prisma().lead.findFirst({ where: { id: leadId }, select: { nextFollowUpAt: true, status: true } }),
      )
    )?.nextFollowUpAt ?? null;
  const bucketIds = async (bucket: string) =>
    (
      (await ctx.http().get(`/api/v1/follow-ups?bucket=${bucket}&limit=200`).set(owner()).expect(200)).body
        .data as { leadId: string }[]
    ).map((r) => r.leadId);

  const createLead = async (): Promise<string> =>
    (
      await ctx
        .http()
        .post('/api/v1/leads')
        .set(owner())
        .send({ firstName: 'Legacy', mobile: fixtureMobile(), assignedToId: ctx.orgA.owner.id, nextFollowUpAt: inHours(24) })
        .expect(201)
    ).body.data.id as string;

  /** As the old create path left it: a past date on the lead, nothing in any queue. */
  const legacyLeadWithoutQueueRow = async (): Promise<string> => {
    const leadId = await createLead();
    await asSystem('e2e legacy shape', async () => {
      await prisma().followUp.deleteMany({ where: { leadId } });
      await prisma().lead.updateMany({ where: { id: leadId }, data: { nextFollowUpAt: hoursAgo(48) } });
    });
    return leadId;
  };

  /** As the manual workaround left it: the original follow-up, plus a second one added by hand. */
  const legacyLeadWithTwoOpen = async (): Promise<{ leadId: string; ids: string[] }> => {
    const leadId = await createLead();
    await asSystem('e2e legacy shape', async () => {
      await prisma().followUp.updateMany({
        where: { leadId },
        data: { scheduledAt: hoursAgo(72), status: 'UPCOMING' },
      });
      await prisma().followUp.create({
        data: {
          organizationId: ctx.orgA.id,
          leadId,
          assignedUserId: ctx.orgA.owner.id,
          scheduledAt: hoursAgo(24),
          type: 'CALL',
          status: 'UPCOMING',
          title: 'Call not connected, try again',
        },
      });
      await prisma().lead.updateMany({ where: { id: leadId }, data: { nextFollowUpAt: hoursAgo(72) } });
    });
    return { leadId, ids: (await openFor(leadId)).map((f) => f.id) };
  };

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx?.close();
  });

  describe('a dated lead with no follow-up (created before the fix)', () => {
    it('is in no queue — the defect as production has it', async () => {
      const leadId = await legacyLeadWithoutQueueRow();
      expect(await openFor(leadId)).toHaveLength(0);
      expect(await bucketIds('overdue')).not.toContain(leadId);
    });

    it('joins the queue exactly once when an outcome is logged from the lead page', async () => {
      const leadId = await legacyLeadWithoutQueueRow();
      const retry = inHours(2);

      await ctx
        .http()
        .post(`/api/v1/leads/${leadId}/outcomes`)
        .set({ ...owner(), 'Idempotency-Key': randomUUID() })
        .send({ outcome: 'NOT_ANSWERED', nextFollowUpAt: retry })
        .expect(200);

      const open = await openFor(leadId);
      expect(open).toHaveLength(1);
      expect(open[0]?.scheduledAt.toISOString()).toBe(retry);
      expect(open[0]?.assignedUserId).toBe(ctx.orgA.owner.id);
      expect((await mirror(leadId))?.toISOString()).toBe(retry);
    });

    it('joins the queue when it is reassigned', async () => {
      const leadId = await legacyLeadWithoutQueueRow();

      await ctx
        .http()
        .post(`/api/v1/leads/${leadId}/assign`)
        .set(owner())
        .send({ assignedToId: ctx.orgA.rep.id })
        .expect((res) => expect([200, 201]).toContain(res.status));

      const open = await openFor(leadId);
      expect(open).toHaveLength(1);
      expect(open[0]?.assignedUserId).toBe(ctx.orgA.rep.id);
      expect(open[0]?.scheduledAt.getTime()).toBe((await mirror(leadId))?.getTime());
    });
  });

  describe('a lead with two open follow-ups (the manual workaround)', () => {
    it('heals to ONE open follow-up on Not Answered, cancelling both old ones', async () => {
      const { leadId, ids } = await legacyLeadWithTwoOpen();
      expect(ids).toHaveLength(2);
      const retry = inHours(2);

      await ctx
        .http()
        .post(`/api/v1/leads/${leadId}/outcomes`)
        .set({ ...owner(), 'Idempotency-Key': randomUUID() })
        .send({ outcome: 'NOT_ANSWERED', followUpId: ids[0], nextFollowUpAt: retry })
        .expect(200);

      const open = await openFor(leadId);
      expect(open).toHaveLength(1);
      expect(open[0]?.scheduledAt.toISOString()).toBe(retry);
      for (const id of ids) expect(await statusOf(id)).toBe('CANCELLED');
      expect((await mirror(leadId))?.toISOString()).toBe(retry);
      expect(await bucketIds('overdue')).not.toContain(leadId);
    });

    it('heals to ONE open follow-up on a reached call, completing the worked one', async () => {
      const { leadId, ids } = await legacyLeadWithTwoOpen();
      const next = inHours(48);

      await ctx
        .http()
        .post(`/api/v1/leads/${leadId}/outcomes`)
        .set({ ...owner(), 'Idempotency-Key': randomUUID() })
        .send({ outcome: 'CONNECTED_CALL_BACK', followUpId: ids[1], nextFollowUpAt: next })
        .expect(200);

      const open = await openFor(leadId);
      expect(open).toHaveLength(1);
      expect(open[0]?.scheduledAt.toISOString()).toBe(next);
      expect(await statusOf(ids[1] as string)).toBe('COMPLETED');
      expect(await statusOf(ids[0] as string)).toBe('CANCELLED');
    });

    /*
     * NOT YET TRUE. Reschedule replaces only the follow-up it names
     * (cancelAndReplace), so a second open one survives and the lead's date
     * stays on the earlier of the two. Found by this suite on 2026-10-26; the
     * fix belongs with the "Schedule follow-up adds a second open follow-up"
     * defect (one open follow-up per lead), not in this release.
     */
    it.todo('heals to ONE open follow-up on reschedule, at exactly the chosen time');

    it('refuses a second submission against the follow-up that was just replaced', async () => {
      const { leadId, ids } = await legacyLeadWithTwoOpen();
      const send = () =>
        ctx
          .http()
          .post(`/api/v1/leads/${leadId}/outcomes`)
          .set({ ...owner(), 'Idempotency-Key': randomUUID() })
          .send({ outcome: 'NOT_ANSWERED', followUpId: ids[0], nextFollowUpAt: inHours(2) });

      await send().expect(200);
      await send().expect(409);
      expect(await openFor(leadId)).toHaveLength(1);
    });
  });

  it('runs on a UTC database session (timestamps are written without an offset)', async () => {
    const [row] = await asSystem('e2e timezone', () =>
      ctx.app.get(PrismaService).client.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`,
    );
    expect(['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT', 'Etc/Universal', 'Universal']).toContain(row?.tz);
  });
});
