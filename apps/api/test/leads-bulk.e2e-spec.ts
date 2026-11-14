import { randomUUID } from 'node:crypto';
import { createTestContext, type TestContext } from './helpers/test-app';
import { fixtureMobile } from './helpers/phone-fixtures';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { RedisService } from '../src/common/redis/redis.service';

/**
 * Bulk lead changes: one server request, every lead through the single-edit
 * rules, a dry run first, per-lead outcomes, idempotent apply, conflicts
 * skipped, tenant and role boundaries kept.
 */
describe('Leads — bulk changes', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const owner = () => auth(ctx.orgA.owner.accessToken);
  const inDays = (d: number): string => new Date(Date.now() + d * 86_400_000).toISOString();
  const prisma = () => ctx.app.get(PrismaService).client;
  const asSystem = <T>(run: () => Promise<T>): Promise<T> =>
    ctx.app.get(TenantContextService).runAsSystem('e2e bulk', run);
  const key = () => randomUUID().replace(/-/g, '');
  const snapshot = () => new Date(Date.now() + 1000).toISOString();

  const createLead = async (body: Record<string, unknown> = {}, as = owner()) => {
    const res = await ctx
      .http()
      .post('/api/v1/leads')
      .set(as)
      .send({
        firstName: 'Bulk',
        companyName: `Co ${randomUUID().slice(0, 6)}`,
        mobile: fixtureMobile(),
        assignedToId: ctx.orgA.owner.id,
        nextFollowUpAt: inDays(1),
        ...body,
      });
    expect({ status: res.status, error: res.body.error }).toMatchObject({ status: 201 });
    return res.body.data.id as string;
  };
  const lead = (id: string) => asSystem(() => prisma().lead.findUnique({ where: { id } }));
  const bulk = (
    body: Record<string, unknown>,
    headers: Record<string, string> = owner(),
    path = 'bulk',
  ) => ctx.http().post(`/api/v1/leads/${path}`).set(headers).send(body);

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(() => ctx.redis.flush());

  it('a dry run previews per lead and writes nothing; applying changes exactly those leads, once', async () => {
    const a = await createLead();
    const b = await createLead();
    const preview = await bulk({
      action: 'SET_PRIORITY',
      priority: 'HIGH',
      dryRun: true,
      selection: { ids: [a, b], snapshotAt: snapshot() },
    });
    expect(preview.status).toBe(200);
    expect(preview.body.data.summary).toMatchObject({ matched: 2, willChange: 2, changed: 0 });
    expect((await lead(a))!.priority).not.toBe('HIGH');

    const k = key();
    const body = {
      action: 'SET_PRIORITY',
      priority: 'HIGH',
      selection: { ids: [a, b], snapshotAt: snapshot() },
    };
    const applied = await bulk(body, { ...owner(), 'Idempotency-Key': k });
    expect(applied.body.data).toMatchObject({
      dryRun: false,
      replayed: false,
      summary: { changed: 2 },
    });
    expect((await lead(a))!.priority).toBe('HIGH');
    expect((await lead(b))!.priority).toBe('HIGH');

    // The same key replays the stored answer and writes nothing more.
    const again = await bulk(body, { ...owner(), 'Idempotency-Key': k });
    expect(again.body.data).toMatchObject({ replayed: true, summary: { changed: 2 } });
    const audits = await asSystem(() =>
      prisma().auditLog.count({
        where: { action: 'lead.bulk.applied', after: { path: ['idempotencyKey'], equals: k } },
      }),
    );
    expect(audits).toBe(1);
  });

  it('applying needs an Idempotency-Key', async () => {
    const a = await createLead();
    const res = await bulk({
      action: 'SET_PRIORITY',
      priority: 'LOW',
      selection: { ids: [a], snapshotAt: snapshot() },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Idempotency-Key');
  });

  it('stage changes use the pipeline rules per lead: won is final, lost needs a reason, WON is refused in bulk', async () => {
    const open = await createLead();
    const won = await createLead();
    await ctx.http().patch(`/api/v1/leads/${won}`).set(owner()).send({ status: 'WON' });
    const isWon = (await lead(won))!.status === 'WON';

    const res = await bulk(
      {
        action: 'SET_STATUS',
        status: 'CONTACTED',
        selection: { ids: [open, won], snapshotAt: snapshot() },
      },
      { ...owner(), 'Idempotency-Key': key() },
    );
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.data.items.map((i: { id: string }) => [i.id, i]));
    expect(byId[open]).toMatchObject({ outcome: 'CHANGED' });
    if (isWon)
      expect(byId[won]).toMatchObject({ outcome: 'REFUSED', code: 'INVALID_STATUS_TRANSITION' });
    expect((await lead(open))!.status).toBe('CONTACTED');

    const noReason = await bulk({
      action: 'SET_STATUS',
      status: 'LOST',
      dryRun: true,
      selection: { ids: [open], snapshotAt: snapshot() },
    });
    expect(noReason.status).toBe(400);
    const wonBulk = await bulk({
      action: 'SET_STATUS',
      status: 'WON',
      dryRun: true,
      selection: { ids: [open], snapshotAt: snapshot() },
    });
    expect(wonBulk.status).toBe(400);
    expect(wonBulk.body.error.message).toContain('one lead at a time');

    const lost = await bulk(
      {
        action: 'SET_STATUS',
        status: 'LOST',
        lostReason: 'Bought elsewhere',
        selection: { ids: [open], snapshotAt: snapshot() },
      },
      { ...owner(), 'Idempotency-Key': key() },
    );
    expect(lost.body.data.summary.changed).toBe(1);
    expect((await lead(open))!).toMatchObject({ status: 'LOST', lostReason: 'Bought elsewhere' });
  });

  it('a lead changed after the person selected it is skipped as a conflict, not overwritten', async () => {
    const a = await createLead();
    const before = new Date(Date.now() - 60_000).toISOString();
    const res = await bulk(
      { action: 'SET_PRIORITY', priority: 'URGENT', selection: { ids: [a], snapshotAt: before } },
      { ...owner(), 'Idempotency-Key': key() },
    );
    expect(res.body.data.items[0]).toMatchObject({ outcome: 'CONFLICT', code: 'STALE_RECORD' });
    expect((await lead(a))!.priority).not.toBe('URGENT');
  });

  it('follow-ups are scheduled through the follow-up queue', async () => {
    const a = await createLead();
    const when = inDays(5);
    const res = await bulk(
      {
        action: 'SCHEDULE_FOLLOW_UP',
        nextFollowUpAt: when,
        selection: { ids: [a], snapshotAt: snapshot() },
      },
      { ...owner(), 'Idempotency-Key': key() },
    );
    expect(res.body.data.summary.changed).toBe(1);
    const open = await asSystem(() =>
      prisma().followUp.findMany({
        where: { leadId: a, status: { in: ['UPCOMING', 'DUE', 'OVERDUE'] } },
      }),
    );
    expect(open.map((f) => f.scheduledAt.toISOString())).toContain(new Date(when).toISOString());
  });

  it('assigns in bulk only with the assign permission, and only to a member', async () => {
    const a = await createLead();
    const toRep = {
      assignedToId: ctx.orgA.rep.id,
      selection: { ids: [a], snapshotAt: snapshot() },
    };
    expect(
      (
        await bulk(
          toRep,
          { ...auth(ctx.orgA.rep.accessToken), 'Idempotency-Key': key() },
          'bulk/assign',
        )
      ).status,
    ).toBe(403);
    const outsider = await bulk(
      { ...toRep, assignedToId: ctx.orgB.owner.id, dryRun: true },
      owner(),
      'bulk/assign',
    );
    expect(outsider.status).toBe(400);
    const ok = await bulk(toRep, { ...owner(), 'Idempotency-Key': key() }, 'bulk/assign');
    expect(ok.body.data.summary.changed).toBe(1);
    expect((await lead(a))!.assignedToId).toBe(ctx.orgA.rep.id);
  });

  it('never touches another organization: a foreign id is reported as not found and left alone', async () => {
    const foreign = await createLead(
      { assignedToId: ctx.orgB.owner.id },
      auth(ctx.orgB.owner.accessToken),
    );
    const res = await bulk(
      {
        action: 'SET_PRIORITY',
        priority: 'URGENT',
        selection: { ids: [foreign], snapshotAt: snapshot() },
      },
      { ...owner(), 'Idempotency-Key': key() },
    );
    expect(res.body.data.items[0]).toMatchObject({ outcome: 'REFUSED', code: 'NOT_FOUND' });
    expect((await lead(foreign))!.priority).not.toBe('URGENT');
  });

  it('"all matching" resolves on the server with the same filters as the list, minus exclusions', async () => {
    const tag = `Q${randomUUID().slice(0, 8)}`;
    const ids = [
      await createLead({ companyName: `${tag} One` }),
      await createLead({ companyName: `${tag} Two` }),
    ];
    const res = await bulk({
      action: 'SET_PRIORITY',
      priority: 'LOW',
      dryRun: true,
      selection: { query: { search: tag }, excludeIds: [ids[1]], snapshotAt: snapshot() },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((i: { id: string }) => i.id)).toEqual([ids[0]]);
  });

  it('apply takes only the previewed ids — "all matching" must be previewed first', async () => {
    const res = await bulk(
      {
        action: 'SET_PRIORITY',
        priority: 'LOW',
        selection: { query: { search: 'x' }, snapshotAt: snapshot() },
      },
      { ...owner(), 'Idempotency-Key': key() },
    );
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Preview the change first');
  });

  it('a preview stamps the server clock; the browser clock never causes a conflict in a preview', async () => {
    const a = await createLead();
    const res = await bulk({
      action: 'SET_PRIORITY',
      priority: 'URGENT',
      dryRun: true,
      selection: { ids: [a], snapshotAt: '2000-01-01T00:00:00.000Z' },
    });
    expect(res.body.data.items[0].outcome).toBe('WILL_CHANGE');
    expect(Math.abs(Date.parse(res.body.data.snapshotAt) - Date.now())).toBeLessThan(60_000);
  });

  it('a stage change never replaces an existing follow-up; it only fills a missing one', async () => {
    const a = await createLead({ nextFollowUpAt: inDays(2) });
    const before = (await lead(a))!.nextFollowUpAt!.toISOString();
    const res = await bulk(
      {
        action: 'SET_STATUS',
        status: 'CONTACTED',
        nextFollowUpAt: inDays(9),
        selection: { ids: [a], snapshotAt: snapshot() },
      },
      { ...owner(), 'Idempotency-Key': key() },
    );
    expect(res.body.data.summary.changed).toBe(1);
    expect((await lead(a))!.nextFollowUpAt!.toISOString()).toBe(before);
  });

  it('a duplicate in flight is refused; another person never gets a stored answer that is not theirs', async () => {
    const a = await createLead();
    const k = key();
    const body = {
      action: 'SET_PRIORITY',
      priority: 'HIGH',
      selection: { ids: [a], snapshotAt: snapshot() },
    };
    // Simulate a request with this key already running for the owner.
    await ctx.app
      .get(RedisService)
      .claimOnce(`lead-bulk:${ctx.orgA.id}:${ctx.orgA.owner.id}:${k}`, 60);
    const dup = await bulk(body, { ...owner(), 'Idempotency-Key': k });
    expect(dup.status).toBe(409);
    expect((await lead(a))!.priority).not.toBe('HIGH');

    // The owner applies with a fresh key; the rep reusing that key is not replayed it.
    const k2 = key();
    expect(
      (await bulk(body, { ...owner(), 'Idempotency-Key': k2 })).body.data.summary.changed,
    ).toBe(1);
    const repLead = await createLead({ assignedToId: ctx.orgA.rep.id });
    const rep = await bulk(
      {
        action: 'SET_PRIORITY',
        priority: 'LOW',
        selection: { ids: [repLead], snapshotAt: snapshot() },
      },
      { ...auth(ctx.orgA.rep.accessToken), 'Idempotency-Key': k2 },
    );
    expect(rep.status).toBe(200);
    expect(rep.body.data.replayed).toBe(false);
    expect(rep.body.data.items.map((i: { id: string }) => i.id)).toEqual([repLead]);
  });

  it('the Overdue view lists only open leads whose next action is late', async () => {
    const tag = `OD${randomUUID().slice(0, 6)}`;
    const late = await createLead({ companyName: `${tag} Late` });
    const onTime = await createLead({ companyName: `${tag} OnTime`, nextFollowUpAt: inDays(3) });
    await asSystem(() =>
      prisma().lead.update({
        where: { id: late },
        data: { nextFollowUpAt: new Date(Date.now() - 86_400_000) },
      }),
    );
    const res = await ctx
      .http()
      .get('/api/v1/leads')
      .query({ search: tag, overdue: 'true' })
      .set(owner());
    expect(res.status).toBe(200);
    const ids = res.body.data.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(late);
    expect(ids).not.toContain(onTime);
  });

  it('refuses a selection larger than the bulk limit', async () => {
    const res = await bulk({
      action: 'SET_PRIORITY',
      priority: 'LOW',
      dryRun: true,
      selection: {
        ids: Array.from({ length: 201 }, () => '01a0d17f-4788-7118-9999-fe48bb29a870'),
        snapshotAt: snapshot(),
      },
    });
    expect(res.status).toBe(400);
  });
});
