import { createTestContext, type TestContext } from './helpers/test-app';
import { fixtureMobile, toFixtureE164 } from './helpers/phone-fixtures';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';

/**
 * Taking a lead out of service, and putting it back.
 *
 * THE DEFECT. A wrongly imported lead could not be removed from the pipeline in
 * a way that said why. The only tool was archival, which records no reason and
 * cannot be undone — so people either left bad rows distorting the forecast or
 * marked them LOST, which poisons loss analysis with data about nobody's
 * selling.
 *
 * Four claims, and every case here is one of them:
 *
 *   IT IS NOT DELETION. The lead, its timeline, its contact and its import
 *   batch all survive. Asserted by reading them back afterwards.
 *
 *   IT IS NOT "LOST". The status is untouched, so loss analysis is unaffected.
 *
 *   IT RELEASES THE IDENTIFIERS. Which is the point: the corrected lead is
 *   created with the same number. The consequence is that reactivation can
 *   fail, and it says which lead is in the way rather than throwing a
 *   constraint error.
 *
 *   IT IS OUT OF THE PIPELINE. Absent from the default list and its total,
 *   reachable through an explicit filter, and its reminders are cancelled.
 */
describe('Lead deactivation and reactivation', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const owner = () => auth(ctx.orgA.owner.accessToken);
  const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();
  const mobile = (): string => fixtureMobile();
  const unique = (prefix: string): string =>
    `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`;

  const prisma = () => ctx.app.get(PrismaService).client;
  const asSystem = async <T>(reason: string, run: () => Promise<T>): Promise<T> =>
    ctx.app.get(TenantContextService).runAsSystem(reason, run);

  const createLead = async (
    body: Record<string, unknown> = {},
  ): Promise<{ id: string; leadNumber: string }> => {
    const response = await ctx
      .http()
      .post('/api/v1/leads')
      .set(owner())
      .send({
        firstName: 'Dana',
        lastName: 'Whitfield',
        mobile: mobile(),
        nextFollowUpAt: inDays(2),
        ...body,
      })
      .expect(201);

    return { id: response.body.data.id as string, leadNumber: response.body.data.leadNumber };
  };

  const deactivate = (id: string, reason = 'Imported from the wrong column mapping') =>
    ctx.http().post(`/api/v1/leads/${id}/deactivate`).set(owner()).send({ reason });

  const reactivate = (id: string, body: Record<string, unknown> = {}) =>
    ctx
      .http()
      .post(`/api/v1/leads/${id}/reactivate`)
      .set(owner())
      .send({ nextFollowUpAt: inDays(3), ...body });

  const leadRow = async (id: string) =>
    asSystem('e2e read lead', () => prisma().lead.findFirst({ where: { id } }));

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ===========================================================================
  // Deactivation
  // ===========================================================================

  describe('deactivating', () => {
    it('records who, when and why', async () => {
      const lead = await createLead();

      const response = await deactivate(lead.id, 'Wrong column mapping on the October import');
      expect(response.status).toBe(200);

      const row = await leadRow(lead.id);
      expect(row?.deactivatedAt).not.toBeNull();
      expect(row?.deactivationReason).toBe('Wrong column mapping on the October import');
      expect(row?.deactivatedBy).toBe(ctx.orgA.owner.id);
    });

    it('requires a reason', async () => {
      const lead = await createLead();

      // A record nobody explained is a record the next person cannot act on.
      await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/deactivate`)
        .set(owner())
        .send({})
        .expect(400);
    });

    it('refuses a reason that says nothing', async () => {
      const lead = await createLead();

      await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/deactivate`)
        .set(owner())
        .send({ reason: ' x ' })
        .expect(400);
    });

    it('leaves the status alone, so loss analysis is untouched', async () => {
      const lead = await createLead({ status: 'QUALIFIED' });

      await deactivate(lead.id).expect(200);

      /*
       * The distinction this whole feature rests on. LOST means a real
       * opportunity was pursued and not won, and it is what "why do we lose?"
       * is computed from — the most valuable question in the dataset. Filing
       * import mistakes there would poison it.
       */
      const row = await leadRow(lead.id);
      expect(row?.status).toBe('QUALIFIED');
      expect(row?.lostAt).toBeNull();
      expect(row?.lostReason).toBeNull();
    });

    it('does not delete anything', async () => {
      const email = `${unique('kept')}@example.test`;
      const lead = await createLead({ email });

      await deactivate(lead.id).expect(200);

      const row = await leadRow(lead.id);
      // Soft deletion is a DIFFERENT state and must not be implied.
      expect(row?.deletedAt).toBeNull();
      expect(row?.email).toBe(email);
      expect(row?.firstName).toBe('Dana');
      // The contact survives too: the person existed whatever the lead was.
      expect(row?.contactId).not.toBeNull();
    });

    it('keeps the timeline and adds the reason to it', async () => {
      const lead = await createLead();
      await deactivate(lead.id, 'Duplicate created by mistake').expect(200);

      const activities = await ctx
        .http()
        .get(`/api/v1/leads/${lead.id}/activities`)
        .set(owner())
        .expect(200);

      // The timeline is what a person reads when they open the lead and ask
      // what happened to it, so the reason goes there as well as in a column.
      const descriptions = (activities.body.data.items as { description: string }[]).map(
        (activity) => activity.description,
      );
      expect(descriptions.some((text) => text.includes('Duplicate created by mistake'))).toBe(
        true,
      );
      expect(descriptions.some((text) => text.includes('Lead created'))).toBe(true);
    });

    it('cancels open follow-ups', async () => {
      const lead = await createLead();
      await deactivate(lead.id).expect(200);

      const open = await asSystem('e2e count open follow-ups', () =>
        prisma().followUp.count({
          where: { leadId: lead.id, status: { in: ['UPCOMING', 'DUE', 'OVERDUE'] } },
        }),
      );

      /*
       * A deactivated lead that keeps paging a salesperson every morning is
       * worse than one nobody deactivated: they learn to dismiss the reminder,
       * and then they dismiss the real ones too.
       */
      expect(open).toBe(0);
      expect((await leadRow(lead.id))?.nextFollowUpAt).toBeNull();
    });

    it('is idempotent, and keeps the first reason', async () => {
      const lead = await createLead();

      await deactivate(lead.id, 'First reason').expect(200);
      await deactivate(lead.id, 'Second reason').expect(200);

      // Two people clicking the same button should not produce an error, and
      // the FIRST reason is the one that explains why the record is out of
      // service.
      expect((await leadRow(lead.id))?.deactivationReason).toBe('First reason');
    });

    it('keeps the import batch link, so the batch still reports it', async () => {
      const number = mobile();

      const imported = await ctx
        .http()
        .post('/api/v1/leads/import')
        .set(owner())
        .send({
          csv: `Customer Name,Mobile No.\nBadly Mapped,${number}`,
          defaultNextFollowUpAt: inDays(3),
          fileName: 'bad-mapping.csv',
        })
        .expect(200);

      const batchId = imported.body.data.batchId as string;
      const lead = await asSystem('e2e find imported lead', () =>
        prisma().lead.findFirst({
          where: { organizationId: ctx.orgA.id, mobile: toFixtureE164(number) },
          select: { id: true },
        }),
      );

      await deactivate(lead?.id as string).expect(200);

      const batch = await ctx
        .http()
        .get(`/api/v1/leads/import/batches/${batchId}`)
        .set(owner())
        .expect(200);

      // The correction workflow in one reading: the batch still knows what it
      // created, and now also how much of it was taken back out.
      expect(batch.body.data).toMatchObject({ activeLeads: 0, deactivatedLeads: 1 });
      expect((await leadRow(lead?.id as string))?.importBatchId).toBe(batchId);
    });
  });

  // ===========================================================================
  // Out of the pipeline
  // ===========================================================================

  describe('visibility', () => {
    it('drops out of the default list and its total', async () => {
      const lead = await createLead({ companyName: unique('Vanishing Co') });

      const before = await ctx
        .http()
        .get(`/api/v1/leads?search=${encodeURIComponent('Vanishing Co')}`)
        .set(owner())
        .expect(200);
      expect(before.body.data.total).toBeGreaterThan(0);

      await deactivate(lead.id).expect(200);

      const after = await ctx
        .http()
        .get(`/api/v1/leads?search=${encodeURIComponent('Vanishing Co')}`)
        .set(owner())
        .expect(200);

      // The page AND the total, because "showing 25 of 812" over a list of
      // fourteen gets reported as a data bug.
      expect(after.body.data.items).toHaveLength(0);
      expect(after.body.data.total).toBe(0);
    });

    it('is reachable through the explicit inactive filter', async () => {
      const lead = await createLead();
      await deactivate(lead.id).expect(200);

      const response = await ctx
        .http()
        .get('/api/v1/leads?lifecycle=INACTIVE')
        .set(owner())
        .expect(200);

      const ids = (response.body.data.items as { id: string; deactivatedAt: string | null }[]).map(
        (item) => item.id,
      );
      expect(ids).toContain(lead.id);
      const found = (
        response.body.data.items as { id: string; deactivatedAt: string | null }[]
      ).find((item) => item.id === lead.id);
      // On the summary, so the inactive list shows when each record went out
      // of service without a request per row.
      expect(found?.deactivatedAt).not.toBeNull();
    });

    it('excludes live leads from the inactive filter', async () => {
      const live = await createLead();

      const response = await ctx
        .http()
        .get('/api/v1/leads?lifecycle=INACTIVE')
        .set(owner())
        .expect(200);

      expect((response.body.data.items as { id: string }[]).map((i) => i.id)).not.toContain(
        live.id,
      );
    });

    it('shows both states under lifecycle=ALL', async () => {
      const company = unique('Both States Co');
      const live = await createLead({ companyName: company });
      const dead = await createLead({ companyName: company });
      await deactivate(dead.id).expect(200);

      const response = await ctx
        .http()
        .get(`/api/v1/leads?lifecycle=ALL&search=${encodeURIComponent(company)}`)
        .set(owner())
        .expect(200);

      const ids = (response.body.data.items as { id: string }[]).map((item) => item.id);
      expect(ids).toContain(live.id);
      expect(ids).toContain(dead.id);
    });

    it('refuses a lifecycle value it does not understand', async () => {
      await ctx.http().get('/api/v1/leads?lifecycle=DELETED').set(owner()).expect(400);
    });

    it('still serves the detail view, with the reason on it', async () => {
      const lead = await createLead();
      await deactivate(lead.id, 'Test record').expect(200);

      const response = await ctx
        .http()
        .get(`/api/v1/leads/${lead.id}`)
        .set(owner())
        .expect(200);

      // Out of the pipeline is not out of reach: somebody has to be able to
      // look at the record and decide whether to bring it back.
      expect(response.body.data.deactivatedAt).not.toBeNull();
      expect(response.body.data.deactivationReason).toBe('Test record');
    });
  });

  // ===========================================================================
  // Identifiers released, and taken back
  // ===========================================================================

  describe('duplicate keys', () => {
    it('releases the mobile so the corrected lead can be created', async () => {
      const number = mobile();
      const wrong = await createLead({ mobile: number });

      // Before deactivating, the number is taken.
      await ctx
        .http()
        .post('/api/v1/leads')
        .set(owner())
        .send({ firstName: 'Correct', mobile: number, nextFollowUpAt: inDays(2) })
        .expect(409);

      await deactivate(wrong.id).expect(200);

      /*
       * THE POINT OF THE WHOLE FEATURE. Deactivating a wrongly imported lead
       * exists so the RIGHT one can be created — which carries the same number.
       * A deactivated row that kept holding the key would make the feature
       * useless for the case it was built for.
       */
      await ctx
        .http()
        .post('/api/v1/leads')
        .set(owner())
        .send({ firstName: 'Correct', mobile: number, nextFollowUpAt: inDays(2) })
        .expect(201);
    });

    it('releases the email as well', async () => {
      const email = `${unique('released')}@example.test`;
      const wrong = await createLead({ email, mobile: mobile() });

      await ctx
        .http()
        .post('/api/v1/leads')
        .set(owner())
        .send({ firstName: 'Correct', email, nextFollowUpAt: inDays(2) })
        .expect(409);

      await deactivate(wrong.id).expect(200);

      await ctx
        .http()
        .post('/api/v1/leads')
        .set(owner())
        .send({ firstName: 'Correct', email, nextFollowUpAt: inDays(2) })
        .expect(201);
    });

    it('lets an import create the corrected row after a deactivation', async () => {
      const number = mobile();
      const wrong = await createLead({ mobile: number });
      await deactivate(wrong.id).expect(200);

      const response = await ctx
        .http()
        .post('/api/v1/leads/import')
        .set(owner())
        .send({
          csv: `Customer Name,Mobile No.\nCorrected,${number}`,
          defaultNextFollowUpAt: inDays(3),
        })
        .expect(200);

      // The preview's duplicate check mirrors the index, so it must also treat
      // a deactivated lead as having released the number — otherwise the
      // import would skip the correction as a duplicate of the record somebody
      // just took out of service.
      expect(response.body.data).toMatchObject({ created: 1, skipped: 0 });
    });
  });

  // ===========================================================================
  // Reactivation
  // ===========================================================================

  describe('reactivating', () => {
    it('brings the lead back and clears the deactivation record', async () => {
      const lead = await createLead();
      await deactivate(lead.id).expect(200);

      await reactivate(lead.id).expect(200);

      const row = await leadRow(lead.id);
      expect(row?.deactivatedAt).toBeNull();
      /*
       * The reason and the actor are cleared too. They describe a state the
       * lead is no longer in, and a stale "why this was deactivated" sitting on
       * a live lead reads as current. The audit trail and the timeline keep the
       * history; these columns describe only the present.
       */
      expect(row?.deactivationReason).toBeNull();
      expect(row?.deactivatedBy).toBeNull();
      expect(row?.nextFollowUpAt).not.toBeNull();
    });

    it('returns to the default list', async () => {
      const company = unique('Returning Co');
      const lead = await createLead({ companyName: company });
      await deactivate(lead.id).expect(200);
      await reactivate(lead.id).expect(200);

      const response = await ctx
        .http()
        .get(`/api/v1/leads?search=${encodeURIComponent(company)}`)
        .set(owner())
        .expect(200);

      expect((response.body.data.items as { id: string }[]).map((i) => i.id)).toContain(lead.id);
    });

    it('needs a next follow-up date to come back', async () => {
      const lead = await createLead();
      await deactivate(lead.id).expect(200);

      /*
       * `leads_active_requires_followup` forbids a live lead with nothing to
       * do. Rather than inventing a date, the caller supplies one: whoever is
       * putting the lead back knows when they intend to act, and a
       * server-chosen date is a reminder nobody agreed to.
       */
      const response = await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/reactivate`)
        .set(owner())
        .send({})
        .expect(400);

      expect(JSON.stringify(response.body)).toMatch(/nextFollowUpAt/);
    });

    it('needs no follow-up date for a lead that was closed', async () => {
      const lead = await createLead({ status: 'WON' });
      await deactivate(lead.id).expect(200);

      // WON and LOST are exempt from the constraint, so a lead deactivated
      // while closed comes back closed and needs nothing scheduled.
      await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/reactivate`)
        .set(owner())
        .send({})
        .expect(200);

      expect((await leadRow(lead.id))?.status).toBe('WON');
    });

    it('refuses to reactivate a lead that is already active', async () => {
      const lead = await createLead();

      await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/reactivate`)
        .set(owner())
        .send({ nextFollowUpAt: inDays(2) })
        .expect(400);
    });

    it('refuses when another lead has taken the mobile, and names it', async () => {
      const number = mobile();
      const original = await createLead({ mobile: number });
      await deactivate(original.id).expect(200);

      const replacement = await createLead({ mobile: number });

      const response = await reactivate(original.id).expect(409);

      /*
       * THE STRUCTURAL CONSEQUENCE of releasing the key. Between deactivating
       * and reactivating, another active lead may have taken the identifier.
       *
       * Reported as a 409 naming the lead that holds it, rather than letting
       * the UPDATE fail on the index — a raw constraint error tells the user
       * nothing about which record is in the way or what to do about it.
       */
      expect(response.body.error.code).toBe('DUPLICATE_LEAD');
      expect(response.body.error.message).toContain(replacement.leadNumber);
      expect(response.body.error.message).toMatch(/mobile number/);

      // And it stayed deactivated rather than half-changing.
      expect((await leadRow(original.id))?.deactivatedAt).not.toBeNull();
    });

    it('refuses when another lead has taken the email, and says so', async () => {
      const email = `${unique('contested')}@example.test`;
      const original = await createLead({ email, mobile: mobile() });
      await deactivate(original.id).expect(200);

      const replacement = await createLead({ email, mobile: mobile() });

      const response = await reactivate(original.id).expect(409);

      expect(response.body.error.message).toContain(replacement.leadNumber);
      expect(response.body.error.message).toMatch(/email address/);
    });

    it('succeeds once the blocking lead is itself deactivated', async () => {
      const number = mobile();
      const original = await createLead({ mobile: number });
      await deactivate(original.id).expect(200);

      const replacement = await createLead({ mobile: number });
      await reactivate(original.id).expect(409);

      // The way out that the error message points at.
      await deactivate(replacement.id, 'Created in error').expect(200);
      await reactivate(original.id).expect(200);

      expect((await leadRow(original.id))?.deactivatedAt).toBeNull();
    });
  });

  // ===========================================================================
  // Permissions and tenancy
  // ===========================================================================

  describe('authorization', () => {
    it('refuses a sales rep', async () => {
      const lead = await createLead();

      /*
       * Deliberately NOT granted to SALES_REP. The records that need
       * deactivating are typically assigned to somebody else or to nobody, so
       * the operation cannot be visibility-scoped — and a rep holding it could
       * take another rep's live lead out of the pipeline.
       */
      await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/deactivate`)
        .set(auth(ctx.orgA.rep.accessToken))
        .send({ reason: 'Trying it on' })
        .expect(403);
    });

    it('refuses a sales rep the reactivation too', async () => {
      const lead = await createLead();
      await deactivate(lead.id).expect(200);

      await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/reactivate`)
        .set(auth(ctx.orgA.rep.accessToken))
        .send({ nextFollowUpAt: inDays(2) })
        .expect(403);
    });

    it('refuses an unauthenticated caller', async () => {
      const lead = await createLead();

      await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/deactivate`)
        .send({ reason: 'No token' })
        .expect(401);
    });

    it('cannot reach another organization’s lead', async () => {
      const lead = await createLead();

      // 404, not 403: confirming the id exists would turn this into an
      // enumeration oracle for another tenant's leads.
      await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/deactivate`)
        .set(auth(ctx.orgB.owner.accessToken))
        .send({ reason: 'Cross-tenant attempt' })
        .expect(404);

      expect((await leadRow(lead.id))?.deactivatedAt).toBeNull();
    });

    it('does not let another organization see it in their inactive list', async () => {
      const lead = await createLead();
      await deactivate(lead.id).expect(200);

      const response = await ctx
        .http()
        .get('/api/v1/leads?lifecycle=INACTIVE')
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(200);

      expect((response.body.data.items as { id: string }[]).map((i) => i.id)).not.toContain(
        lead.id,
      );
    });
  });

  // ===========================================================================
  // Not the same as archiving
  // ===========================================================================

  describe('distinct from archival', () => {
    it('leaves an archived lead out of the inactive filter', async () => {
      const lead = await createLead();

      await ctx.http().delete(`/api/v1/leads/${lead.id}`).set(owner()).expect(204);

      const response = await ctx
        .http()
        .get('/api/v1/leads?lifecycle=INACTIVE')
        .set(owner())
        .expect(200);

      /*
       * Archived and deactivated are different states and the filters say so.
       * An archived lead is already gone from view by its own mechanism;
       * showing it under "inactive" would mix two decisions with different
       * meanings and different reversibility.
       */
      expect((response.body.data.items as { id: string }[]).map((i) => i.id)).not.toContain(
        lead.id,
      );
    });

    it('cannot deactivate a lead that was archived', async () => {
      const lead = await createLead();
      await ctx.http().delete(`/api/v1/leads/${lead.id}`).set(owner()).expect(204);

      // Already out of service by a different route, and archival is the
      // heavier right. Deactivation is not a way to partially undo it.
      await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/deactivate`)
        .set(owner())
        .send({ reason: 'Already archived' })
        .expect(404);
    });
  });
});
