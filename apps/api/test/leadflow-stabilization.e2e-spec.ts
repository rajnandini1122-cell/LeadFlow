import { randomUUID } from 'node:crypto';
import { createTestContext, type TestContext } from './helpers/test-app';
import { fixtureMobile } from './helpers/phone-fixtures';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';

/**
 * LeadFlow stabilization: queue ownership, double submits and racing agents.
 *
 * FOUR DEFECTS, each reproduced here before it was fixed:
 *
 *   1. REASSIGNMENT LEFT THE WORK BEHIND. `assign` moved `leads.assigned_to`
 *      and nothing else. The open follow-up kept the OLD owner, so the new
 *      owner never saw the lead in their queue, while the old owner kept a
 *      reminder for a lead they could no longer open.
 *
 *   2. ASSIGNING AN UNASSIGNED LEAD NEVER QUEUED IT. An unassigned lead carries
 *      only the `next_follow_up_at` mirror — a follow-up row needs an owner.
 *      Giving it one did not create the row, so the lead stayed out of every
 *      follow-up view for good.
 *
 *   3. A DOUBLE SUBMIT WAS TWO ACTIONS. "No answer" twice logged two attempts;
 *      a retried "complete" or "reschedule" answered 409 although the first
 *      request had succeeded, so the agent was told it failed.
 *
 *   4. RACING WRITES COULD STRAND OR DUPLICATE. Two writes to one lead's
 *      follow-ups each read the open rows, then each acted, with nothing
 *      serialising them. One could overwrite a COMPLETED row as CANCELLED and
 *      both could leave an open follow-up behind.
 */
describe('LeadFlow stabilization', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const owner = () => auth(ctx.orgA.owner.accessToken);
  const rep = () => auth(ctx.orgA.rep.accessToken);
  const inHours = (hours: number): string => new Date(Date.now() + hours * 3_600_000).toISOString();
  const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();

  const prisma = () => ctx.app.get(PrismaService).client;
  const asSystem = async <T>(reason: string, run: () => Promise<T>): Promise<T> =>
    ctx.app.get(TenantContextService).runAsSystem(reason, run);

  /** Real Postgres serves concurrent connections; PGlite serves one. */
  const realPostgres = process.env['CI_USE_EXTERNAL_DB'] === '1';
  const describeRaces = realPostgres ? describe : describe.skip;

  const createLead = async (body: Record<string, unknown> = {}): Promise<string> => {
    const response = await ctx
      .http()
      .post('/api/v1/leads')
      .set(owner())
      .send({
        firstName: 'Asha',
        mobile: fixtureMobile(),
        assignedToId: ctx.orgA.owner.id,
        nextFollowUpAt: inDays(2),
        ...body,
      })
      .expect(201);

    return response.body.data.id as string;
  };

  const followUpsFor = async (leadId: string) =>
    asSystem('e2e read follow-ups', () =>
      prisma().followUp.findMany({
        where: { leadId },
        select: {
          id: true,
          status: true,
          scheduledAt: true,
          assignedUserId: true,
          rescheduledToId: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
    );

  const openFor = async (leadId: string) =>
    (await followUpsFor(leadId)).filter((row) =>
      ['UPCOMING', 'DUE', 'OVERDUE'].includes(row.status),
    );

  const activitiesFor = async (leadId: string, type?: string) =>
    asSystem('e2e read timeline', () =>
      prisma().leadActivity.findMany({
        where: { leadId, ...(type ? { activityType: type as never } : {}) },
        select: { activityType: true, description: true },
      }),
    );

  const leadRow = async (id: string) =>
    asSystem('e2e read lead', () => prisma().lead.findFirst({ where: { id } }));

  /** Every lead id in a bucket, as the given caller sees it. */
  const queued = async (headers: Record<string, string>, buckets = ['overdue', 'today', 'upcoming']) => {
    const responses = await Promise.all(
      buckets.map((bucket) =>
        ctx.http().get(`/api/v1/follow-ups?bucket=${bucket}`).set(headers).expect(200),
      ),
    );
    return responses.flatMap((response) =>
      (response.body.data as { leadId: string }[]).map((row) => row.leadId),
    );
  };

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ===========================================================================
  // 1. Reassignment moves the work with the lead
  // ===========================================================================

  describe('reassignment', () => {
    it('hands the open follow-up to the new owner', async () => {
      const leadId = await createLead();

      await ctx
        .http()
        .post(`/api/v1/leads/${leadId}/assign`)
        .set(owner())
        .send({ assignedToId: ctx.orgA.rep.id })
        .expect(200);

      const open = await openFor(leadId);
      expect(open).toHaveLength(1);
      expect(open[0]?.assignedUserId).toBe(ctx.orgA.rep.id);

      // The new owner sees it where they work.
      expect(await queued(rep())).toContain(leadId);
    });

    it('takes it out of the previous owner’s own queue', async () => {
      const leadId = await createLead({ assignedToId: ctx.orgA.rep.id });
      expect(await queued(rep())).toContain(leadId);

      await ctx
        .http()
        .post(`/api/v1/leads/${leadId}/assign`)
        .set(owner())
        .send({ assignedToId: ctx.orgA.owner.id })
        .expect(200);

      // A reminder for a lead the rep can no longer open is noise they learn
      // to ignore — and then they ignore the real ones too.
      expect(await queued(rep())).not.toContain(leadId);
    });

    it('keeps the schedule, the mirror and a single open row', async () => {
      const leadId = await createLead();
      const before = (await openFor(leadId))[0];

      await ctx
        .http()
        .post(`/api/v1/leads/${leadId}/assign`)
        .set(owner())
        .send({ assignedToId: ctx.orgA.rep.id })
        .expect(200);

      const after = await openFor(leadId);
      expect(after).toHaveLength(1);
      // Same commitment, new owner: the date the customer was promised does
      // not move because the person keeping it did.
      expect(after[0]?.scheduledAt.toISOString()).toBe(before?.scheduledAt.toISOString());
      expect((await leadRow(leadId))?.nextFollowUpAt?.toISOString()).toBe(
        before?.scheduledAt.toISOString(),
      );
    });

    it('queues an unassigned lead the moment it gets an owner', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/leads')
        .set(owner())
        .send({ firstName: 'Unowned', mobile: fixtureMobile(), nextFollowUpAt: inDays(1) })
        .expect(201);
      const leadId = response.body.data.id as string;

      // No owner, so no row is possible — only the mirror.
      expect(await openFor(leadId)).toHaveLength(0);

      await ctx
        .http()
        .post(`/api/v1/leads/${leadId}/assign`)
        .set(owner())
        .send({ assignedToId: ctx.orgA.rep.id })
        .expect(200);

      const open = await openFor(leadId);
      expect(open).toHaveLength(1);
      expect(open[0]?.assignedUserId).toBe(ctx.orgA.rep.id);
      expect(await queued(rep())).toContain(leadId);
    });

    it('can find unassigned leads directly', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/leads')
        .set(owner())
        .send({ firstName: 'Findme', mobile: fixtureMobile(), nextFollowUpAt: inDays(1) })
        .expect(201);
      const leadId = response.body.data.id as string;
      const assigned = await createLead();

      const list = await ctx
        .http()
        .get('/api/v1/leads?unassigned=true&limit=100')
        .set(owner())
        .expect(200);
      const ids = (list.body.data.items as { id: string }[]).map((row) => row.id);

      expect(ids).toContain(leadId);
      expect(ids).not.toContain(assigned);
    });
  });

  // ===========================================================================
  // 3. A replayed request is the same action, not a second one
  // ===========================================================================

  describe('Not Answered, submitted twice', () => {
    it('records ONE attempt for one Idempotency-Key', async () => {
      const leadId = await createLead();
      const key = randomUUID();
      const body = { activityType: 'CALL_NOT_ANSWERED', retryAt: inHours(3) };

      const first = await ctx
        .http()
        .post(`/api/v1/leads/${leadId}/attempts`)
        .set({ ...owner(), 'Idempotency-Key': key })
        .send(body)
        .expect(200);
      const second = await ctx
        .http()
        .post(`/api/v1/leads/${leadId}/attempts`)
        .set({ ...owner(), 'Idempotency-Key': key })
        .send(body)
        .expect(200);

      expect(await activitiesFor(leadId, 'CALL_NOT_ANSWERED')).toHaveLength(1);
      expect(await openFor(leadId)).toHaveLength(1);
      // The replay answers with what the first request produced.
      expect(second.body.data.followUp.id).toBe(first.body.data.followUp.id);
    });

    it('still counts genuinely separate attempts', async () => {
      const leadId = await createLead();

      for (let i = 0; i < 2; i++) {
        await ctx
          .http()
          .post(`/api/v1/leads/${leadId}/attempts`)
          .set({ ...owner(), 'Idempotency-Key': randomUUID() })
          .send({ activityType: 'CALL_NOT_ANSWERED', retryAt: inHours(3 + i) })
          .expect(200);
      }

      expect(await activitiesFor(leadId, 'CALL_NOT_ANSWERED')).toHaveLength(2);
      expect(await openFor(leadId)).toHaveLength(1);
    });

    it('refuses a malformed key rather than ignoring it', async () => {
      const leadId = await createLead();

      await ctx
        .http()
        .post(`/api/v1/leads/${leadId}/attempts`)
        .set({ ...owner(), 'Idempotency-Key': 'has spaces / and slashes' })
        .send({ activityType: 'CALL_NOT_ANSWERED', retryAt: inHours(3) })
        .expect(400);
    });

    it('updates lastActivityAt with the attempt', async () => {
      const leadId = await createLead();
      const before = (await leadRow(leadId))?.lastActivityAt?.getTime() ?? 0;

      await ctx
        .http()
        .post(`/api/v1/leads/${leadId}/attempts`)
        .set(owner())
        .send({ activityType: 'CALL_NOT_ANSWERED', retryAt: inHours(3) })
        .expect(200);

      expect((await leadRow(leadId))?.lastActivityAt?.getTime() ?? 0).toBeGreaterThanOrEqual(before);
      expect((await leadRow(leadId))?.lastActivityAt).not.toBeNull();
    });
  });

  describe('Complete, submitted twice', () => {
    it('answers the replay with the first result instead of 409', async () => {
      const leadId = await createLead();
      const followUpId = (await openFor(leadId))[0]?.id as string;
      const key = randomUUID();
      const body = { outcome: 'Interested', nextFollowUpAt: inDays(4) };

      const first = await ctx
        .http()
        .post(`/api/v1/follow-ups/${followUpId}/complete`)
        .set({ ...owner(), 'Idempotency-Key': key })
        .send(body)
        .expect(200);
      const second = await ctx
        .http()
        .post(`/api/v1/follow-ups/${followUpId}/complete`)
        .set({ ...owner(), 'Idempotency-Key': key })
        .send(body)
        .expect(200);

      expect(second.body.data.nextFollowUpAt).toBe(first.body.data.nextFollowUpAt);
      // One completion, one next action.
      expect(await activitiesFor(leadId, 'FOLLOW_UP_COMPLETED')).toHaveLength(1);
      expect(await openFor(leadId)).toHaveLength(1);
    });

    it('still says 409 to a DIFFERENT action on a closed follow-up', async () => {
      const leadId = await createLead();
      const followUpId = (await openFor(leadId))[0]?.id as string;

      await ctx
        .http()
        .post(`/api/v1/follow-ups/${followUpId}/complete`)
        .set({ ...owner(), 'Idempotency-Key': randomUUID() })
        .send({ outcome: 'Interested', nextFollowUpAt: inDays(4) })
        .expect(200);

      // Somebody else completing it afterwards is a real conflict, not a retry.
      await ctx
        .http()
        .post(`/api/v1/follow-ups/${followUpId}/complete`)
        .set({ ...owner(), 'Idempotency-Key': randomUUID() })
        .send({ outcome: 'Interested', nextFollowUpAt: inDays(5) })
        .expect(409);
    });

    it('commits the completion and the next action together', async () => {
      const leadId = await createLead();
      const followUpId = (await openFor(leadId))[0]?.id as string;

      await ctx
        .http()
        .post(`/api/v1/follow-ups/${followUpId}/complete`)
        .set(owner())
        .send({ outcome: 'Interested', nextFollowUpAt: inDays(6) })
        .expect(200);

      const all = await followUpsFor(leadId);
      expect(all.find((row) => row.id === followUpId)?.status).toBe('COMPLETED');
      const open = await openFor(leadId);
      expect(open).toHaveLength(1);
      expect((await leadRow(leadId))?.nextFollowUpAt?.toISOString()).toBe(
        open[0]?.scheduledAt.toISOString(),
      );
    });
  });

  describe('Reschedule, submitted twice', () => {
    it('answers the replay with the same replacement', async () => {
      const leadId = await createLead();
      const followUpId = (await openFor(leadId))[0]?.id as string;
      const key = randomUUID();
      const body = { scheduledAt: inDays(3) };

      const first = await ctx
        .http()
        .post(`/api/v1/follow-ups/${followUpId}/reschedule`)
        .set({ ...owner(), 'Idempotency-Key': key })
        .send(body)
        .expect(200);
      const second = await ctx
        .http()
        .post(`/api/v1/follow-ups/${followUpId}/reschedule`)
        .set({ ...owner(), 'Idempotency-Key': key })
        .send(body)
        .expect(200);

      expect(second.body.data.id).toBe(first.body.data.id);
      expect(await activitiesFor(leadId, 'FOLLOW_UP_RESCHEDULED')).toHaveLength(1);
      expect(await openFor(leadId)).toHaveLength(1);
    });

    it('moves the lead into the right bucket and keeps the history', async () => {
      const leadId = await createLead();
      const followUpId = (await openFor(leadId))[0]?.id as string;

      const moved = await ctx
        .http()
        .post(`/api/v1/follow-ups/${followUpId}/reschedule`)
        .set(owner())
        .send({ scheduledAt: inDays(5) })
        .expect(200);

      expect(await queued(owner(), ['upcoming'])).toContain(leadId);
      expect(await queued(owner(), ['today', 'overdue'])).not.toContain(leadId);

      const original = (await followUpsFor(leadId)).find((row) => row.id === followUpId);
      expect(original?.status).toBe('CANCELLED');
      expect(original?.rescheduledToId).toBe(moved.body.data.id);
      // The mirror follows the replacement in the same commit.
      expect((await leadRow(leadId))?.nextFollowUpAt?.toISOString()).toBe(
        new Date(moved.body.data.scheduledAt as string).toISOString(),
      );
    });
  });

  describe('the request bodies the web client sends', () => {
    /*
     * THE DEFECT. The web hooks for complete and reschedule spread everything
     * but `id` into the body — including `leadId`, which they carry only to
     * know which caches to refresh. The API whitelists DTO fields and refuses
     * the rest, so every Complete and Reschedule pressed from the Follow-ups
     * screen was rejected before it ran. These pin the contract the client
     * must meet; the client-side test pins that it now meets it.
     */
    it('refuses a completion that carries leadId in the body', async () => {
      const leadId = await createLead();
      const followUpId = (await openFor(leadId))[0]?.id as string;

      const response = await ctx
        .http()
        .post(`/api/v1/follow-ups/${followUpId}/complete`)
        .set(owner())
        .send({ leadId, outcome: 'Interested', nextFollowUpAt: inDays(4) });

      expect([400, 422]).toContain(response.status);
      // Nothing happened: the follow-up is still the open one.
      expect((await openFor(leadId))[0]?.id).toBe(followUpId);
    });

    it('refuses a reschedule that carries leadId in the body', async () => {
      const leadId = await createLead();
      const followUpId = (await openFor(leadId))[0]?.id as string;

      const response = await ctx
        .http()
        .post(`/api/v1/follow-ups/${followUpId}/reschedule`)
        .set(owner())
        .send({ leadId, scheduledAt: inDays(3) });

      expect([400, 422]).toContain(response.status);
    });
  });

  describe('Schedule follow-up, submitted twice', () => {
    it('creates ONE row for one Idempotency-Key', async () => {
      const leadId = await createLead();
      const key = randomUUID();
      const body = { scheduledAt: inDays(7), type: 'MEETING' };

      const first = await ctx
        .http()
        .post(`/api/v1/leads/${leadId}/follow-ups`)
        .set({ ...owner(), 'Idempotency-Key': key })
        .send(body)
        .expect(201);
      const second = await ctx
        .http()
        .post(`/api/v1/leads/${leadId}/follow-ups`)
        .set({ ...owner(), 'Idempotency-Key': key })
        .send(body)
        .expect(201);

      expect(second.body.data.id).toBe(first.body.data.id);
      expect(await activitiesFor(leadId, 'FOLLOW_UP_CREATED')).toHaveLength(1);
    });
  });

  // ===========================================================================
  // 4. Racing agents on one lead
  // ===========================================================================

  describe('a late write cannot rewrite history', () => {
    it('never turns a COMPLETED follow-up into CANCELLED', async () => {
      const leadId = await createLead();
      const followUpId = (await openFor(leadId))[0]?.id as string;

      await ctx
        .http()
        .post(`/api/v1/follow-ups/${followUpId}/complete`)
        .set(owner())
        .send({ outcome: 'Interested', nextFollowUpAt: inDays(4) })
        .expect(200);

      await ctx
        .http()
        .post(`/api/v1/leads/${leadId}/attempts`)
        .set(owner())
        .send({ activityType: 'CALL_NOT_ANSWERED', retryAt: inHours(5) })
        .expect(200);

      const original = (await followUpsFor(leadId)).find((row) => row.id === followUpId);
      expect(original?.status).toBe('COMPLETED');
      expect(await openFor(leadId)).toHaveLength(1);
    });
  });

  describeRaces('simultaneous agents (real Postgres only)', () => {
    it('leaves exactly one open follow-up when an attempt races a completion', async () => {
      const leadId = await createLead();
      const followUpId = (await openFor(leadId))[0]?.id as string;

      const results = await Promise.all([
        ctx
          .http()
          .post(`/api/v1/follow-ups/${followUpId}/complete`)
          .set(owner())
          .send({ outcome: 'Interested', nextFollowUpAt: inDays(4) }),
        ctx
          .http()
          .post(`/api/v1/leads/${leadId}/attempts`)
          .set(owner())
          .send({ activityType: 'CALL_NOT_ANSWERED', retryAt: inHours(5) }),
      ]);

      expect(results.every((r) => r.status === 200 || r.status === 409)).toBe(true);
      expect(await openFor(leadId)).toHaveLength(1);
      const original = (await followUpsFor(leadId)).find((row) => row.id === followUpId);
      expect(['COMPLETED', 'CANCELLED']).toContain(original?.status);
    });

    it('records ONE attempt when the same key arrives twice at once', async () => {
      const leadId = await createLead();
      const key = randomUUID();
      const send = () =>
        ctx
          .http()
          .post(`/api/v1/leads/${leadId}/attempts`)
          .set({ ...owner(), 'Idempotency-Key': key })
          .send({ activityType: 'CALL_NOT_ANSWERED', retryAt: inHours(3) });

      const results = await Promise.all([send(), send(), send()]);

      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(await activitiesFor(leadId, 'CALL_NOT_ANSWERED')).toHaveLength(1);
      expect(await openFor(leadId)).toHaveLength(1);
    });

    it('leaves one open follow-up when two agents reschedule at once', async () => {
      const leadId = await createLead();
      const followUpId = (await openFor(leadId))[0]?.id as string;

      await Promise.all([
        ctx.http().post(`/api/v1/follow-ups/${followUpId}/reschedule`).set(owner()).send({ scheduledAt: inDays(3) }),
        ctx.http().post(`/api/v1/leads/${leadId}/attempts`).set(owner()).send({ activityType: 'CALL_NOT_ANSWERED', retryAt: inHours(4) }),
      ]);

      expect(await openFor(leadId)).toHaveLength(1);
    });
  });
});
