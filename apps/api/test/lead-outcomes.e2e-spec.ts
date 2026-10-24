import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createTestContext, type TestContext } from './helpers/test-app';
import { fixtureMobile } from './helpers/phone-fixtures';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';

/**
 * Structured call outcomes, end to end: the endpoint, the lead facts, the
 * queues and the workspace counts.
 *
 * The defects behind this:
 *   * "No answer" on the Complete dialog COMPLETED the follow-up, so a missed
 *     call left every queue and counted as work done.
 *   * The "Call" button logged "call completed" on the dial click, before
 *     anyone answered — so "contacted" meant "somebody pressed a button".
 *   * Nothing structured recorded what a call established, so "awaiting
 *     response", "last outcome" and "last contacted" could not exist.
 */
describe('Call outcomes', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const owner = () => auth(ctx.orgA.owner.accessToken);
  const inHours = (h: number): string => new Date(Date.now() + h * 3_600_000).toISOString();
  const inDays = (d: number): string => new Date(Date.now() + d * 86_400_000).toISOString();

  const prisma = () => ctx.app.get(PrismaService).client;
  const asSystem = async <T>(reason: string, run: () => Promise<T>): Promise<T> =>
    ctx.app.get(TenantContextService).runAsSystem(reason, run);

  const createLead = async (body: Record<string, unknown> = {}): Promise<string> => {
    const response = await ctx
      .http()
      .post('/api/v1/leads')
      .set(owner())
      .send({
        firstName: 'Meera',
        mobile: fixtureMobile(),
        assignedToId: ctx.orgA.owner.id,
        nextFollowUpAt: inDays(1),
        ...body,
      })
      .expect(201);
    return response.body.data.id as string;
  };

  const outcome = (leadId: string, body: Record<string, unknown>, headers: Record<string, string> = owner()) =>
    ctx.http().post(`/api/v1/leads/${leadId}/outcomes`).set(headers).send(body);

  const followUps = async (leadId: string) =>
    asSystem('e2e follow-ups', () =>
      prisma().followUp.findMany({
        where: { leadId },
        select: { id: true, status: true, scheduledAt: true, outcome: true, title: true, assignedUserId: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
  const openFor = async (leadId: string) =>
    (await followUps(leadId)).filter((f) => ['UPCOMING', 'DUE', 'OVERDUE'].includes(f.status));
  const lead = async (id: string) => asSystem('e2e lead', () => prisma().lead.findFirst({ where: { id } }));
  const activities = async (leadId: string) =>
    asSystem('e2e timeline', () =>
      prisma().leadActivity.findMany({
        where: { leadId },
        select: { activityType: true, description: true, metadata: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
  const bucketIds = async (bucket: string, headers = owner()) =>
    (
      (await ctx.http().get(`/api/v1/follow-ups?bucket=${bucket}&limit=200`).set(headers).expect(200)).body
        .data as { leadId: string }[]
    ).map((r) => r.leadId);

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx?.close();
  });

  // ===========================================================================
  // Not reached: the work is still owed
  // ===========================================================================

  describe('not reached', () => {
    it.each(['NOT_ANSWERED', 'BUSY', 'UNREACHABLE'])(
      '%s supersedes the follow-up with a retry and never completes it',
      async (code) => {
        const leadId = await createLead();
        const original = (await openFor(leadId))[0];

        const res = await outcome(leadId, { outcome: code, nextFollowUpAt: inHours(2) }).expect(200);

        const all = await followUps(leadId);
        expect(all.find((f) => f.id === original?.id)?.status).toBe('CANCELLED');
        expect(all.some((f) => f.status === 'COMPLETED')).toBe(false);
        expect(await openFor(leadId)).toHaveLength(1);
        expect(res.body.data.completedFollowUpId).toBeNull();
        expect(res.body.data.followUp.title).toMatch(/Retry call/);
      },
    );

    it('leaves the stage where it was and does not mark the lead contacted', async () => {
      const leadId = await createLead();
      await outcome(leadId, { outcome: 'NOT_ANSWERED', nextFollowUpAt: inHours(2) }).expect(200);

      const row = await lead(leadId);
      expect(row?.status).toBe('NEW');
      expect(row?.lastOutcome).toBe('NOT_ANSWERED');
      expect(row?.lastOutcomeAt).not.toBeNull();
      // Three missed calls are not contact.
      expect(row?.lastContactedAt).toBeNull();
    });

    it('puts the retry in the assigned owner’s queue at the chosen time', async () => {
      const leadId = await createLead({ assignedToId: ctx.orgA.rep.id });
      const retryAt = inDays(1);
      await outcome(leadId, { outcome: 'BUSY', nextFollowUpAt: retryAt }).expect(200);

      const open = await openFor(leadId);
      expect(open[0]?.assignedUserId).toBe(ctx.orgA.rep.id);
      expect(open[0]?.scheduledAt.toISOString()).toBe(new Date(retryAt).toISOString());
      expect(await bucketIds('upcoming', auth(ctx.orgA.rep.accessToken))).toContain(leadId);
    });

    it('requires a retry time', async () => {
      const leadId = await createLead();
      await outcome(leadId, { outcome: 'NOT_ANSWERED' }).expect(400);
      expect(await openFor(leadId)).toHaveLength(1);
    });

    it('lets a wrong number close the lead, with a reason', async () => {
      const leadId = await createLead();
      const res = await outcome(leadId, { outcome: 'WRONG_NUMBER', close: true }).expect(200);

      expect(res.body.data.leadStatus).toBe('LOST');
      const row = await lead(leadId);
      expect(row?.status).toBe('LOST');
      expect(row?.lostReason).toMatch(/Wrong number/);
      expect(await openFor(leadId)).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Reached: the call happened
  // ===========================================================================

  describe('reached', () => {
    it('completes the worked follow-up with the outcome and schedules exactly one next', async () => {
      const leadId = await createLead();
      const original = (await openFor(leadId))[0];

      const res = await outcome(leadId, {
        outcome: 'CONNECTED_CALL_BACK',
        followUpId: original?.id,
        note: 'Asked to call after lunch',
        nextFollowUpAt: inHours(4),
      }).expect(200);

      const done = (await followUps(leadId)).find((f) => f.id === original?.id);
      expect(done?.status).toBe('COMPLETED');
      expect(done?.outcome).toBe('Connected — call back later');
      expect(res.body.data.completedFollowUpId).toBe(original?.id);
      expect(await openFor(leadId)).toHaveLength(1);
    });

    it('moves a NEW lead to CONTACTED on the first real conversation, and records contact', async () => {
      const leadId = await createLead();
      await outcome(leadId, { outcome: 'CONNECTED_NO_REQUIREMENT', nextFollowUpAt: inDays(30) }).expect(200);

      const row = await lead(leadId);
      expect(row?.status).toBe('CONTACTED');
      expect(row?.lastContactedAt).not.toBeNull();
    });

    it('does NOT qualify a lead on "no current requirement"', async () => {
      const leadId = await createLead();
      await outcome(leadId, {
        outcome: 'CONNECTED_NO_REQUIREMENT',
        nextFollowUpAt: inDays(30),
        markQualified: true,
      }).expect(400);
      expect((await lead(leadId))?.status).toBe('NEW');
    });

    it('never moves the stage backwards', async () => {
      const leadId = await createLead({ status: 'NEGOTIATION' });
      await outcome(leadId, { outcome: 'CONNECTED_CALL_BACK', nextFollowUpAt: inDays(1) }).expect(200);
      expect((await lead(leadId))?.status).toBe('NEGOTIATION');
    });

    it('captures a requirement and qualifies only when asked', async () => {
      const leadId = await createLead();
      await outcome(leadId, {
        outcome: 'CONNECTED_REQUIREMENT',
        productInterest: 'Dehydrated onion flakes',
        quantity: '500 kg monthly',
        expectedPurchaseDate: '2026-12-15',
        markQualified: true,
        nextFollowUpAt: inDays(2),
      }).expect(200);

      const row = await lead(leadId);
      expect(row?.status).toBe('QUALIFIED');
      expect(row?.productInterest).toBe('Dehydrated onion flakes');
      expect(row?.requirementQuantity).toBe('500 kg monthly');
      // A calendar date — no timezone drift.
      expect(row?.expectedPurchaseDate?.toISOString().slice(0, 10)).toBe('2026-12-15');

      const detail = await ctx.http().get(`/api/v1/leads/${leadId}`).set(owner()).expect(200);
      expect(detail.body.data.expectedPurchaseDate).toBe('2026-12-15');
      expect(detail.body.data.requirementQuantity).toBe('500 kg monthly');
    });

    it('refuses requirement fields on an outcome that does not capture one', async () => {
      const leadId = await createLead();
      await outcome(leadId, { outcome: 'BUSY', nextFollowUpAt: inHours(1), quantity: '10' }).expect(400);
    });

    it('refuses close on an outcome that does not offer it', async () => {
      const leadId = await createLead();
      await outcome(leadId, { outcome: 'CONNECTED_CALL_BACK', close: true }).expect(400);
      expect((await lead(leadId))?.status).toBe('NEW');
    });

    it('closes as LOST on "not interested" when asked, cancelling open work', async () => {
      const leadId = await createLead();
      await outcome(leadId, { outcome: 'NOT_INTERESTED', close: true }).expect(200);

      const row = await lead(leadId);
      expect(row?.status).toBe('LOST');
      expect(row?.lostReason).toBe('Not interested');
      expect(await openFor(leadId)).toHaveLength(0);
    });

    it('rejects an unknown outcome code', async () => {
      const leadId = await createLead();
      await outcome(leadId, { outcome: 'SPOKE_A_BIT', nextFollowUpAt: inDays(1) }).expect(400);
    });

    it('refuses a call on a closed lead', async () => {
      const leadId = await createLead();
      await ctx.http().patch(`/api/v1/leads/${leadId}`).set(owner()).send({ status: 'WON' }).expect(200);
      await outcome(leadId, { outcome: 'CONNECTED_CALL_BACK', nextFollowUpAt: inDays(1) }).expect(400);
    });

    it('answers 409 when the named follow-up is no longer open', async () => {
      const leadId = await createLead();
      const original = (await openFor(leadId))[0];
      await outcome(leadId, { outcome: 'CONNECTED_CALL_BACK', followUpId: original?.id, nextFollowUpAt: inDays(1) }).expect(200);

      await outcome(leadId, {
        outcome: 'CONNECTED_CALL_BACK',
        followUpId: original?.id,
        nextFollowUpAt: inDays(2),
      }).expect(409);
    });
  });

  // ===========================================================================
  // One call, one record
  // ===========================================================================

  describe('idempotency', () => {
    it('records ONE call for one Idempotency-Key and replays the first result', async () => {
      const leadId = await createLead();
      const key = randomUUID();
      const body = { outcome: 'AWAITING_RESPONSE', nextFollowUpAt: inDays(3) };

      const first = await outcome(leadId, body, { ...owner(), 'Idempotency-Key': key }).expect(200);
      const second = await outcome(leadId, body, { ...owner(), 'Idempotency-Key': key }).expect(200);

      expect(second.body.data.replayed).toBe(true);
      expect(second.body.data.followUp.id).toBe(first.body.data.followUp.id);
      expect(second.body.data.completedFollowUpId).toBe(first.body.data.completedFollowUpId);
      const calls = (await activities(leadId)).filter((a) => a.activityType === 'CALL_COMPLETED');
      expect(calls).toHaveLength(1);
      expect(await openFor(leadId)).toHaveLength(1);
    });

    it('still counts genuinely separate calls', async () => {
      const leadId = await createLead();
      for (let i = 0; i < 3; i++) {
        await outcome(
          leadId,
          { outcome: 'NOT_ANSWERED', nextFollowUpAt: inHours(1 + i) },
          { ...owner(), 'Idempotency-Key': randomUUID() },
        ).expect(200);
      }
      const misses = (await activities(leadId)).filter((a) => a.activityType === 'CALL_NOT_ANSWERED');
      expect(misses).toHaveLength(3);
      expect(await openFor(leadId)).toHaveLength(1);
    });

    it('records the outcome code on the timeline entry', async () => {
      const leadId = await createLead();
      await outcome(leadId, { outcome: 'UNREACHABLE', nextFollowUpAt: inDays(1), note: 'Phone off' }).expect(200);
      const entry = (await activities(leadId)).find((a) => a.activityType === 'CALL_NOT_ANSWERED');
      expect((entry?.metadata as Record<string, unknown>)['outcome']).toBe('UNREACHABLE');
      expect(entry?.description).toBe('Switched off / unreachable — Phone off');
    });
  });

  // ===========================================================================
  // Queues, filters and counts
  // ===========================================================================

  describe('queues and counts', () => {
    it('shows "awaiting response" leads in the awaiting bucket and the awaiting filter', async () => {
      const waiting = await createLead();
      const other = await createLead();
      await outcome(waiting, { outcome: 'AWAITING_RESPONSE', nextFollowUpAt: inDays(3) }).expect(200);
      await outcome(other, { outcome: 'CONNECTED_CALL_BACK', nextFollowUpAt: inDays(3) }).expect(200);

      const bucket = await bucketIds('awaiting');
      expect(bucket).toContain(waiting);
      expect(bucket).not.toContain(other);

      const list = await ctx.http().get('/api/v1/leads?awaiting=true&limit=100').set(owner()).expect(200);
      const ids = (list.body.data.items as { id: string }[]).map((r) => r.id);
      expect(ids).toContain(waiting);
      expect(ids).not.toContain(other);
    });

    it('treats a lead with a quotation out as awaiting the customer', async () => {
      const leadId = await createLead({ status: 'QUOTATION_SENT' });
      expect(await bucketIds('awaiting')).toContain(leadId);
    });

    it('lists only never-reached NEW leads as fresh', async () => {
      const untouched = await createLead();
      const missed = await createLead();
      const reached = await createLead();
      await outcome(missed, { outcome: 'NOT_ANSWERED', nextFollowUpAt: inHours(2) }).expect(200);
      await outcome(reached, { outcome: 'CONNECTED_CALL_BACK', nextFollowUpAt: inHours(2) }).expect(200);

      const list = await ctx.http().get('/api/v1/leads?fresh=true&limit=100').set(owner()).expect(200);
      const ids = (list.body.data.items as { id: string }[]).map((r) => r.id);
      expect(ids).toContain(untouched);
      // Still NEW (a miss is not contact) and never reached: still fresh.
      expect(ids).toContain(missed);
      expect(ids).not.toContain(reached);
    });

    it('carries last outcome, last contact, latest interaction and next action on list rows', async () => {
      const leadId = await createLead();
      await outcome(leadId, { outcome: 'CONNECTED_CALL_BACK', nextFollowUpAt: inHours(6), note: 'After 5' }).expect(200);

      const list = await ctx.http().get('/api/v1/leads?limit=100').set(owner()).expect(200);
      type Row = {
        lastOutcome: string | null;
        lastContactedAt: string | null;
        latestActivity: { description: string | null } | null;
        nextAction: { title: string | null; isOverdue: boolean } | null;
      };
      const row = (list.body.data.items as (Row & { id: string })[]).find((r) => r.id === leadId) as Row;
      expect(row.lastOutcome).toBe('CONNECTED_CALL_BACK');
      expect(row.lastContactedAt).not.toBeNull();
      expect(row.latestActivity?.description).toMatch(/call back later/i);
      expect(row.nextAction?.title).toBe('Call back as agreed');
      expect(row.nextAction?.isOverdue).toBe(false);
    });

    it('reports counts that equal the lists behind them', async () => {
      await createLead({ nextFollowUpAt: inHours(1) });
      const counts = (await ctx.http().get('/api/v1/follow-ups/counts').set(owner()).expect(200)).body.data as Record<
        string,
        number
      >;

      for (const bucket of ['overdue', 'today', 'tomorrow', 'week', 'upcoming', 'awaiting', 'completed_today']) {
        const rows = await bucketIds(bucket);
        // Lists are capped at 200; the suite stays well under it.
        expect({ bucket, count: counts[bucket] }).toEqual({ bucket, count: rows.length });
      }
    });

    it('counts a completion in completed_today and drops it from open buckets', async () => {
      const leadId = await createLead({ nextFollowUpAt: inHours(3) });
      const before = (await ctx.http().get('/api/v1/follow-ups/counts').set(owner()).expect(200)).body.data;
      await outcome(leadId, { outcome: 'CONNECTED_CALL_BACK', nextFollowUpAt: inDays(2) }).expect(200);
      const after = (await ctx.http().get('/api/v1/follow-ups/counts').set(owner()).expect(200)).body.data;

      expect(after.completed_today).toBe(before.completed_today + 1);
      expect(await bucketIds('completed_today')).toContain(leadId);
      expect(await bucketIds('today')).not.toContain(leadId);
    });

    it('returns workspace numbers scoped to the caller', async () => {
      const repLead = await createLead({ assignedToId: ctx.orgA.rep.id });
      const team = (await ctx.http().get('/api/v1/workspace/summary').set(owner()).expect(200)).body.data;
      const mine = (await ctx.http().get('/api/v1/workspace/summary').set(auth(ctx.orgA.rep.accessToken)).expect(200))
        .body.data;

      expect(team.scope).toBe('TEAM');
      expect(mine.scope).toBe('OWN');
      expect(typeof team.leads.unassigned).toBe('number');
      // A rep cannot see the whole team, so "unassigned" is not offered.
      expect(mine.leads.unassigned).toBeNull();
      expect(mine.leads.fresh).toBeGreaterThanOrEqual(1);
      expect(team.followUps.overdue).toBeGreaterThanOrEqual(mine.followUps.overdue);
      expect(repLead).toBeTruthy();
    });
  });

  // ===========================================================================
  // History
  // ===========================================================================

  describe('reschedule history', () => {
    it('records the old and the new schedule, in the organization’s time', async () => {
      const leadId = await createLead();
      const original = (await openFor(leadId))[0];
      const movedTo = inDays(3);

      await ctx
        .http()
        .post(`/api/v1/follow-ups/${original?.id}/reschedule`)
        .set(owner())
        .send({ scheduledAt: movedTo, reason: 'Customer travelling' })
        .expect(200);

      const entry = (await activities(leadId)).find((a) => a.activityType === 'FOLLOW_UP_RESCHEDULED');
      expect(entry?.description).toMatch(/^Rescheduled from .+ to .+ — Customer travelling$/);
      expect(entry?.description).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
      const meta = entry?.metadata as Record<string, string>;
      expect(meta['from']).toBe(original?.scheduledAt.toISOString());
      expect(meta['to']).toBe(new Date(movedTo).toISOString());
    });
  });

  // ===========================================================================
  // Tenancy and permissions
  // ===========================================================================

  describe('authorization', () => {
    it('cannot log a call on another organization’s lead', async () => {
      const leadId = await createLead();
      await outcome(leadId, { outcome: 'NOT_ANSWERED', nextFollowUpAt: inHours(1) }, auth(ctx.orgB.owner.accessToken)).expect(
        404,
      );
      expect((await lead(leadId))?.lastOutcome).toBeNull();
    });

    it('does not leak another organization’s follow-ups into counts', async () => {
      await createLead();
      const b = (await ctx.http().get('/api/v1/follow-ups/counts').set(auth(ctx.orgB.owner.accessToken)).expect(200))
        .body.data;
      const bRows = await bucketIds('upcoming', auth(ctx.orgB.owner.accessToken));
      expect(b.upcoming).toBe(bRows.length);
    });

    it('refuses an unauthenticated call', async () => {
      const leadId = await createLead();
      await ctx
        .http()
        .post(`/api/v1/leads/${leadId}/outcomes`)
        .send({ outcome: 'NOT_ANSWERED', nextFollowUpAt: inHours(1) })
        .expect(401);
    });
  });

  // ===========================================================================
  // Racing agents (real PostgreSQL only — PGlite serves one connection)
  // ===========================================================================

  const realPostgres = process.env['CI_USE_EXTERNAL_DB'] === '1';
  (realPostgres ? describe : describe.skip)('concurrency (real Postgres only)', () => {
    it('writes nothing until it holds the lead, then leaves exactly one next action', async () => {
      const leadId = await createLead();
      const db = new Client({ connectionString: process.env['DATABASE_URL'] as string, ssl: false });
      await db.connect();

      try {
        // Another agent's write is mid-flight on this lead.
        await db.query('BEGIN');
        await db.query('UPDATE leads SET updated_at = updated_at WHERE id = $1', [leadId]);

        const pending = outcome(leadId, { outcome: 'CONNECTED_CALL_BACK', nextFollowUpAt: inDays(1) }).then((r) => r);

        for (let i = 0; i < 200; i++) {
          const { rows } = await db.query<{ n: string }>(
            `SELECT count(*) AS n FROM pg_stat_activity
              WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid() AND datname = current_database()`,
          );
          if (Number(rows[0]?.n) > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        const seen = await db.query<{ n: string }>(
          `SELECT count(*) AS n FROM lead_activities WHERE lead_id = $1 AND activity_type = 'CALL_BACK_LATER'`,
          [leadId],
        );
        expect(Number(seen.rows[0]?.n)).toBe(0);

        await db.query('COMMIT');
        expect((await pending).status).toBe(200);
      } finally {
        await db.end();
      }

      expect(await openFor(leadId)).toHaveLength(1);
      expect((await followUps(leadId)).filter((f) => f.status === 'COMPLETED')).toHaveLength(1);
    });

    it('records ONE call when the same key arrives three times at once', async () => {
      const leadId = await createLead();
      const key = randomUUID();
      const results = await Promise.all(
        [0, 1, 2].map(() =>
          outcome(leadId, { outcome: 'NOT_ANSWERED', nextFollowUpAt: inHours(2) }, { ...owner(), 'Idempotency-Key': key }),
        ),
      );

      expect(results.every((r) => r.status === 200)).toBe(true);
      expect((await activities(leadId)).filter((a) => a.activityType === 'CALL_NOT_ANSWERED')).toHaveLength(1);
      expect(await openFor(leadId)).toHaveLength(1);
    });
  });
});
