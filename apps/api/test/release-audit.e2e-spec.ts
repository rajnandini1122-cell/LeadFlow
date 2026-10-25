import { randomUUID } from 'node:crypto';
import { createTestContext, type TestContext } from './helpers/test-app';
import { fixtureMobile } from './helpers/phone-fixtures';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';

/**
 * Release audit probes — behaviours checked end to end against the real API,
 * where the code alone was not evidence enough. Each `it` states the claim it
 * verifies; a failure here is a reproduced defect.
 */
describe('Release audit probes', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const owner = () => auth(ctx.orgA.owner.accessToken);
  const rep = () => auth(ctx.orgA.rep.accessToken);
  const inDays = (d: number): string => new Date(Date.now() + d * 86_400_000).toISOString();
  const prisma = () => ctx.app.get(PrismaService).client;
  const asSystem = async <T>(reason: string, run: () => Promise<T>): Promise<T> =>
    ctx.app.get(TenantContextService).runAsSystem(reason, run);

  const createLead = async (body: Record<string, unknown> = {}): Promise<string> =>
    (
      await ctx
        .http()
        .post('/api/v1/leads')
        .set(owner())
        .send({ firstName: 'Audit', mobile: fixtureMobile(), assignedToId: ctx.orgA.owner.id, nextFollowUpAt: inDays(1), ...body })
        .expect(201)
    ).body.data.id as string;

  const openFor = async (leadId: string) =>
    asSystem('audit', () =>
      prisma().followUp.findMany({
        where: { leadId, status: { in: ['UPCOMING', 'DUE', 'OVERDUE'] } },
        select: { id: true, assignedUserId: true, scheduledAt: true },
      }),
    );
  const bucketIds = async (bucket: string, headers = owner()) =>
    (
      (await ctx.http().get(`/api/v1/follow-ups?bucket=${bucket}&limit=200`).set(headers).expect(200)).body.data as {
        leadId: string;
      }[]
    ).map((r) => r.leadId);

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('A reactivated lead gets back into its owner’s queue', async () => {
    const leadId = await createLead();
    await ctx.http().post(`/api/v1/leads/${leadId}/deactivate`).set(owner()).send({ reason: 'Imported twice' }).expect(200);
    expect(await openFor(leadId)).toHaveLength(0);

    const at = inDays(2);
    await ctx.http().post(`/api/v1/leads/${leadId}/reactivate`).set(owner()).send({ nextFollowUpAt: at }).expect(200);

    const open = await openFor(leadId);
    expect(open).toHaveLength(1);
    expect(open[0]?.scheduledAt.toISOString()).toBe(new Date(at).toISOString());
    expect(await bucketIds('upcoming')).toContain(leadId);
  });

  it('Never hands a follow-up to someone who cannot see the lead', async () => {
    // The owner owns the lead; a rep sees only their own leads.
    const leadId = await createLead();
    const res = await ctx
      .http()
      .post(`/api/v1/leads/${leadId}/follow-ups`)
      .set(owner())
      .send({ scheduledAt: inDays(1), assignedUserId: ctx.orgA.rep.id })
      .expect(400);

    // Every action on such a row would have answered 404 for the rep. The way
    // to give them the work is to reassign the lead, which moves it.
    expect(JSON.stringify(res.body)).toMatch(/reassign the lead/);
    expect(await bucketIds('upcoming', rep())).not.toContain(leadId);
  });

  it('Schedules for a named assignee who can see the lead, and they can act on it', async () => {
    // Regression: this returned HTTP 500 — the membership check ran on another
    // connection inside the lead's transaction and waited on itself.
    const leadId = await createLead({ assignedToId: ctx.orgA.rep.id });
    const fu = await ctx
      .http()
      .post(`/api/v1/leads/${leadId}/follow-ups`)
      .set(owner())
      .send({ scheduledAt: inDays(1), assignedUserId: ctx.orgA.owner.id })
      .expect(201);

    expect(fu.body.data.assignedTo.id).toBe(ctx.orgA.owner.id);
    await ctx
      .http()
      .post(`/api/v1/leads/${leadId}/outcomes`)
      .set(owner())
      .send({ outcome: 'NOT_ANSWERED', followUpId: fu.body.data.id, nextFollowUpAt: inDays(1) })
      .expect(200);
  });

  it('The rep who owns the lead can schedule for themselves', async () => {
    const leadId = await createLead({ assignedToId: ctx.orgA.rep.id });
    await ctx
      .http()
      .post(`/api/v1/leads/${leadId}/follow-ups`)
      .set(rep())
      .send({ scheduledAt: inDays(1), assignedUserId: ctx.orgA.rep.id })
      .expect(201);
  });

  it('Winning a lead with a customer account promotes the account to CUSTOMER', async () => {
    const account = await ctx.http().post('/api/v1/accounts').set(owner()).send({ name: `Audit Co ${randomUUID().slice(0, 6)}` }).expect(201);
    const accountId = account.body.data.account.id as string;
    const leadId = await createLead({ accountId });

    await ctx.http().patch(`/api/v1/leads/${leadId}`).set(owner()).send({ status: 'WON', wonValue: 50000 }).expect(200);

    const row = await asSystem('audit', () => prisma().account.findFirst({ where: { id: accountId }, select: { status: true } }));
    expect(row?.status).toBe('CUSTOMER');
    expect(await openFor(leadId)).toHaveLength(0);
  });

  it('Rescheduling a completed follow-up is refused, not silently applied', async () => {
    const leadId = await createLead();
    const fuId = (await openFor(leadId))[0]?.id as string;
    await ctx.http().post(`/api/v1/leads/${leadId}/outcomes`).set(owner()).send({ outcome: 'CONNECTED_CALL_BACK', followUpId: fuId, nextFollowUpAt: inDays(2) }).expect(200);

    await ctx.http().post(`/api/v1/follow-ups/${fuId}/reschedule`).set(owner()).send({ scheduledAt: inDays(5) }).expect(409);
    expect(await openFor(leadId)).toHaveLength(1);
  });

  it('The dashboard’s follow-up numbers equal the queue lists', async () => {
    await createLead({ nextFollowUpAt: new Date(Date.now() - 3_600_000).toISOString() });
    await createLead({ nextFollowUpAt: inDays(3) });

    const dash = (await ctx.http().get('/api/v1/dashboard').set(owner()).expect(200)).body.data as {
      followUps: { overdue: number; dueToday: number; upcoming: number };
    };
    expect(dash.followUps.overdue).toBe((await bucketIds('overdue')).length);
    expect(dash.followUps.dueToday).toBe((await bucketIds('today')).length);
    expect(dash.followUps.upcoming).toBe((await bucketIds('upcoming')).length);
  });

  it('A lead never sits open with nothing queued while it has an owner', async () => {
    // The invariant behind "no lead disappears": across every lead this suite
    // created through the API, an assigned, live, open lead has an open follow-up.
    const stranded = await asSystem('audit', () =>
      prisma().lead.findMany({
        where: {
          organizationId: ctx.orgA.id,
          deletedAt: null,
          deactivatedAt: null,
          status: { notIn: ['WON', 'LOST'] },
          assignedToId: { not: null },
          // Created through the API (an actor is recorded). The harness's own
          // fixture lead is written straight to the table and never had a row.
          createdBy: { not: null },
          followUps: { none: { status: { in: ['UPCOMING', 'DUE', 'OVERDUE'] } } },
        },
        select: {
          id: true,
          leadNumber: true,
          status: true,
          nextFollowUpAt: true,
          assignedToId: true,
          createdBy: true,
          activities: { select: { activityType: true, description: true }, orderBy: { createdAt: 'asc' } },
          followUps: { select: { status: true, cancelledReason: true, assignedUserId: true } },
        },
      }),
    );
    if (stranded.length) console.log('STRANDED', JSON.stringify(stranded, null, 1));
    expect(stranded).toEqual([]);
  });

  it('A won lead with no customer is linked by its rep and its customer becomes a CUSTOMER', async () => {
    const company = `Audit Exports ${randomUUID().slice(0, 8)}`;
    const leadId = await createLead({ companyName: company, assignedToId: ctx.orgA.rep.id });
    await ctx.http().patch(`/api/v1/leads/${leadId}`).set(rep()).send({ status: 'WON', wonValue: 250000 }).expect(200);

    // Winning never invents a customer from a free-text company name.
    const won = (await ctx.http().get(`/api/v1/leads/${leadId}`).set(rep()).expect(200)).body.data;
    expect(won.account).toBeNull();

    // The rep records the company and links the deal — what the lead page now offers.
    const created = (await ctx.http().post('/api/v1/accounts').set(rep()).send({ name: company }).expect(201)).body.data.account;
    const linked = (
      await ctx.http().post('/api/v1/accounts/mapping/assign').set(rep()).send({ accountId: created.id, leadIds: [leadId] }).expect(201)
    ).body.data;
    expect(linked.leadsUpdated).toBe(1);

    const lead = (await ctx.http().get(`/api/v1/leads/${leadId}`).set(rep()).expect(200)).body.data;
    expect(lead.account).toMatchObject({ id: created.id, status: 'CUSTOMER' });
    const account = (await ctx.http().get(`/api/v1/accounts/${created.id}`).set(owner()).expect(200)).body.data;
    expect(account.status).toBe('CUSTOMER');
    expect(account.firstWonAt).toBeTruthy();

    // A second "create" of the same company is caught as a duplicate.
    const again = await ctx.http().post('/api/v1/accounts').set(rep()).send({ name: company }).expect(409);
    expect(again.body.error.details.duplicateAccountIds).toContain(created.id);
  });
});
