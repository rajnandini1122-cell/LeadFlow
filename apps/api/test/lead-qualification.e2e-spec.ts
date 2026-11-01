import { ERROR_CODES } from '@leadflow/api-types';
import { createTestContext, type TestContext } from './helpers/test-app';
import { fixtureMobile } from './helpers/phone-fixtures';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';

/**
 * Rough -> Refined lead qualification.
 *
 * New and imported leads start ROUGH: they can be edited, assigned, researched
 * and qualified, but stay out of the sales follow-up queues, overdue counts,
 * quotations and later stages until somebody authorised refines them.
 */
describe('Lead qualification (Rough / Refined)', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const owner = () => auth(ctx.orgA.owner.accessToken);
  const rep = () => auth(ctx.orgA.rep.accessToken);
  const otherOrg = () => auth(ctx.orgB.owner.accessToken);
  const inDays = (d: number): string => new Date(Date.now() + d * 86_400_000).toISOString();

  type Lead = {
    id: string;
    qualification: 'ROUGH' | 'REFINED';
    status: string;
    nextFollowUpAt: string | null;
  };

  const create = (body: Record<string, unknown> = {}, headers = owner()) =>
    ctx
      .http()
      .post('/api/v1/leads')
      .set(headers)
      .send({
        firstName: 'Asha',
        companyName: 'Asha Foods',
        mobile: fixtureMobile(),
        nextFollowUpAt: inDays(2),
        assignedToId: ctx.orgA.rep.id,
        ...body,
      });

  const newLead = async (body: Record<string, unknown> = {}): Promise<Lead> =>
    (await create(body).expect(201)).body.data as Lead;

  const get = async (id: string): Promise<Lead> =>
    (await ctx.http().get(`/api/v1/leads/${id}`).set(owner()).expect(200)).body.data as Lead;

  const followUps = async (id: string) =>
    (await ctx.http().get(`/api/v1/leads/${id}/follow-ups`).set(owner()).expect(200)).body.data as {
      id: string;
      status: string;
    }[];

  const queueCounts = async (headers = rep()) =>
    (await ctx.http().get('/api/v1/follow-ups/counts').set(headers).expect(200)).body
      .data as Record<string, number>;

  const totalOpen = (counts: Record<string, number>) =>
    (counts['overdue'] ?? 0) + (counts['today'] ?? 0) + (counts['upcoming'] ?? 0);

  const refine = (id: string, body: Record<string, unknown> = {}, headers = owner()) =>
    ctx
      .http()
      .post(`/api/v1/leads/${id}/refine`)
      .set(headers)
      .send({ outcome: 'GENUINE_REQUIREMENT', businessFitConfirmed: true, ...body });

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.app.get(TenantContextService).runAsSystem('e2e: qualification on for org A', () =>
      ctx.app.get(PrismaService).client.organizationSettings.update({
        where: { organizationId: ctx.orgA.id },
        data: { leadQualificationEnabled: true },
      }),
    );
  });
  afterAll(async () => {
    await ctx?.close();
  });

  describe('new leads start Rough', () => {
    it('a manually created lead is Rough, keeps its qualify-by date and gets no sales follow-up', async () => {
      const before = totalOpen(await queueCounts());
      const lead = await newLead();
      expect(lead.qualification).toBe('ROUGH');
      expect(lead.nextFollowUpAt).not.toBeNull();
      expect(await followUps(lead.id)).toHaveLength(0);
      expect(totalOpen(await queueCounts())).toBe(before);
    });

    it('an imported lead is Rough', async () => {
      const number = fixtureMobile();
      await ctx
        .http()
        .post('/api/v1/leads/import')
        .set(owner())
        .send({
          csv: `firstName,mobile,companyName\nImported,${number},Imp Co`,
          defaultNextFollowUpAt: inDays(3),
        })
        .expect(200);
      const found = await ctx
        .http()
        .get('/api/v1/leads')
        .set(owner())
        .query({ search: number })
        .expect(200);
      expect(found.body.data.items[0].qualification).toBe('ROUGH');
    });

    it('is listed under the Rough filter, not the Refined one, and counted apart on the workspace', async () => {
      const lead = await newLead();
      const rough = await ctx
        .http()
        .get('/api/v1/leads')
        .set(owner())
        .query({ qualification: 'ROUGH', limit: 100 });
      const refined = await ctx
        .http()
        .get('/api/v1/leads')
        .set(owner())
        .query({ qualification: 'REFINED', limit: 100 });
      const ids = (r: { body: { data: { items: { id: string }[] } } }) =>
        r.body.data.items.map((l) => l.id);
      expect(ids(rough)).toContain(lead.id);
      expect(ids(refined)).not.toContain(lead.id);

      const summary = (await ctx.http().get('/api/v1/workspace/summary').set(owner()).expect(200))
        .body.data;
      expect(summary.leads.rough).toBeGreaterThan(0);
    });
  });

  describe('what a Rough lead allows', () => {
    it('can be edited, assigned, moved to Contacted and closed as Lost', async () => {
      const lead = await newLead();
      await ctx
        .http()
        .patch(`/api/v1/leads/${lead.id}`)
        .set(owner())
        .send({ city: 'Pune' })
        .expect(200);
      await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/assign`)
        .set(owner())
        .send({ assignedToId: ctx.orgA.owner.id })
        .expect((r) => expect([200, 201]).toContain(r.status));
      expect(await followUps(lead.id)).toHaveLength(0);
      await ctx
        .http()
        .patch(`/api/v1/leads/${lead.id}`)
        .set(owner())
        .send({ status: 'CONTACTED' })
        .expect(200);
      await ctx
        .http()
        .patch(`/api/v1/leads/${lead.id}`)
        .set(owner())
        .send({ status: 'LOST', lostReason: 'Not a fit' })
        .expect(200);
    });

    it('records qualification notes without scheduling sales work or refining the lead', async () => {
      const lead = await newLead();
      const at = inDays(4);
      const res = await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/qualification/notes`)
        .set(rep())
        .send({ outcome: 'RESEARCHED', note: 'Checked GST and website', nextQualificationAt: at })
        .expect(200);
      expect(res.body.data.qualification).toBe('ROUGH');

      const after = await get(lead.id);
      expect(after.qualification).toBe('ROUGH');
      expect(new Date(after.nextFollowUpAt as string).toISOString()).toBe(
        new Date(at).toISOString(),
      );
      expect(await followUps(lead.id)).toHaveLength(0);

      const timeline = (
        await ctx.http().get(`/api/v1/leads/${lead.id}/activities`).set(owner()).expect(200)
      ).body.data.items as { description: string | null }[];
      expect(
        timeline.some((a) =>
          (a.description ?? '').startsWith('Qualification: Researched the company'),
        ),
      ).toBe(true);
    });

    it('does not promote itself because of activity', async () => {
      const lead = await newLead();
      await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/activities`)
        .set(owner())
        .send({ activityType: 'NOTE_ADDED', description: 'Called, interested' })
        .expect(201);
      await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/qualification/notes`)
        .set(owner())
        .send({ outcome: 'CONTACTED_INTERESTED' })
        .expect(200);
      expect((await get(lead.id)).qualification).toBe('ROUGH');
    });

    it.each([
      [
        'schedule a follow-up',
        (id: string) =>
          ctx
            .http()
            .post(`/api/v1/leads/${id}/follow-ups`)
            .set(owner())
            .send({ scheduledAt: inDays(1) }),
      ],
      [
        'log a sales call outcome',
        (id: string) =>
          ctx
            .http()
            .post(`/api/v1/leads/${id}/outcomes`)
            .set(owner())
            .send({ outcome: 'NOT_ANSWERED', nextFollowUpAt: inDays(1) }),
      ],
      [
        'log a failed attempt',
        (id: string) =>
          ctx
            .http()
            .post(`/api/v1/leads/${id}/attempts`)
            .set(owner())
            .send({ activityType: 'CALL_NOT_ANSWERED', retryAt: inDays(1) }),
      ],
      [
        'move to Quotation sent',
        (id: string) =>
          ctx.http().patch(`/api/v1/leads/${id}`).set(owner()).send({ status: 'QUOTATION_SENT' }),
      ],
      [
        'move to Won',
        (id: string) =>
          ctx
            .http()
            .patch(`/api/v1/leads/${id}`)
            .set(owner())
            .send({ status: 'WON', wonValue: 100 }),
      ],
    ])('refuses to %s until refined', async (_label, call) => {
      const lead = await newLead();
      const res = await call(lead.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe(ERROR_CODES.LEAD_NOT_REFINED);
    });
  });

  describe('refining', () => {
    it('reports everything still missing at once', async () => {
      const lead = await newLead({ companyName: undefined, mobile: undefined, email: undefined });
      const res = await refine(lead.id, { businessFitConfirmed: false }).expect(400);
      expect(res.body.error.code).toBe(ERROR_CODES.QUALIFICATION_INCOMPLETE);
      expect(Object.keys(res.body.error.details).sort()).toEqual([
        'businessFitConfirmed',
        'company',
        'contact',
      ]);
      expect((await get(lead.id)).qualification).toBe('ROUGH');
    });

    it('needs a note when the outcome is Other', async () => {
      await refine((await newLead()).id, { outcome: 'OTHER' }).expect(400);
    });

    it('records who, when and why, and puts the lead into its owner’s queue', async () => {
      const lead = await newLead();
      const before = totalOpen(await queueCounts());
      const res = await refine(lead.id, { note: 'Needs 2 t a month' }).expect(200);
      expect(res.body.data).toMatchObject({
        qualification: 'REFINED',
        refinementOutcome: 'GENUINE_REQUIREMENT',
        refinementNote: 'Needs 2 t a month',
        refinedBy: { id: ctx.orgA.owner.id },
      });
      expect(res.body.data.refinedAt).toBeTruthy();
      expect(
        (await followUps(lead.id)).filter((f) => ['UPCOMING', 'DUE', 'OVERDUE'].includes(f.status)),
      ).toHaveLength(1);
      expect(totalOpen(await queueCounts())).toBe(before + 1);

      // Now the sales workflow is open to it.
      await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/outcomes`)
        .set(owner())
        .send({ outcome: 'NOT_ANSWERED', nextFollowUpAt: inDays(1) })
        .expect(200);
      await refine(lead.id).expect(409);
    });

    it('is refused to a sales rep, who may still qualify', async () => {
      const lead = await newLead();
      await refine(lead.id, {}, rep()).expect(403);
      await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/revert-to-rough`)
        .set(rep())
        .send({ reason: 'test reason' })
        .expect(403);
      await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/qualification/notes`)
        .set(rep())
        .send({ outcome: 'NOT_REACHABLE' })
        .expect(200);
    });
  });

  describe('reverting to Rough', () => {
    it('needs a reason, keeps follow-ups but takes them out of the queues, and back in on refine', async () => {
      const lead = await newLead();
      await refine(lead.id).expect(200);
      const open = (await followUps(lead.id)).filter((f) =>
        ['UPCOMING', 'DUE', 'OVERDUE'].includes(f.status),
      );
      expect(open).toHaveLength(1);
      const queued = totalOpen(await queueCounts());

      await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/revert-to-rough`)
        .set(owner())
        .send({ reason: 'x' })
        .expect(400);
      const reverted = await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/revert-to-rough`)
        .set(owner())
        .send({ reason: 'Buyer left the company' })
        .expect(200);
      expect(reverted.body.data).toMatchObject({
        qualification: 'ROUGH',
        refinedAt: null,
        refinementOutcome: null,
      });

      // The follow-up is still there, untouched...
      const kept = await followUps(lead.id);
      expect(kept.map((f) => f.id)).toEqual((await followUps(lead.id)).map((f) => f.id));
      expect(kept.find((f) => f.id === open[0]!.id)?.status).toBe(open[0]!.status);
      // ...but out of the queue counts.
      expect(totalOpen(await queueCounts())).toBe(queued - 1);

      const timeline = (
        await ctx.http().get(`/api/v1/leads/${lead.id}/activities`).set(owner()).expect(200)
      ).body.data.items as { description: string | null }[];
      expect(
        timeline.some((a) => a.description === 'Reverted to Rough: Buyer left the company'),
      ).toBe(true);

      // Refined again: back in the queue, and no second follow-up invented.
      await refine(lead.id).expect(200);
      expect(totalOpen(await queueCounts())).toBe(queued);
      expect(
        (await followUps(lead.id)).filter((f) => ['UPCOMING', 'DUE', 'OVERDUE'].includes(f.status)),
      ).toHaveLength(1);
    });
  });

  describe('tenant isolation', () => {
    it('hides one organization’s lead qualification from another', async () => {
      const lead = await newLead();
      await ctx.http().get(`/api/v1/leads/${lead.id}/qualification`).set(otherOrg()).expect(404);
      await refine(lead.id, {}, otherOrg()).expect(404);
      await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/qualification/notes`)
        .set(otherOrg())
        .send({ outcome: 'RESEARCHED' })
        .expect(404);
      await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/revert-to-rough`)
        .set(otherOrg())
        .send({ reason: 'not mine' })
        .expect(404);
      expect((await get(lead.id)).qualification).toBe('ROUGH');
    });
  });

  describe('switched off', () => {
    it('new leads start Refined with their first follow-up, exactly as before', async () => {
      const prisma = ctx.app.get(PrismaService).client;
      const system = ctx.app.get(TenantContextService);
      await system.runAsSystem('e2e: qualification off', () =>
        prisma.organizationSettings.update({
          where: { organizationId: ctx.orgA.id },
          data: { leadQualificationEnabled: false },
        }),
      );
      try {
        const lead = await newLead();
        expect(lead.qualification).toBe('REFINED');
        expect(await followUps(lead.id)).toHaveLength(1);
      } finally {
        await system.runAsSystem('e2e: qualification back on', () =>
          prisma.organizationSettings.update({
            where: { organizationId: ctx.orgA.id },
            data: { leadQualificationEnabled: true },
          }),
        );
      }
    });
  });
});
