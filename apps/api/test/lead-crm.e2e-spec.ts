import { ERROR_CODES } from '@leadflow/api-types';
import { createTestContext, type TestContext } from './helpers/test-app';

/**
 * Phase 4 — lead lifecycle, activities and the follow-up engine.
 *
 * The authorization cases matter most: every one of these endpoints can
 * modify or destroy customer data, and several reference the GLOBAL users
 * table, where nothing in the schema prevents a cross-tenant reference.
 */
describe('Lead CRM', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const mobile = (): string => `415${Math.floor(1000000 + Math.random() * 8999999)}`;
  const inDays = (days: number): string =>
    new Date(Date.now() + days * 86_400_000).toISOString();

  /** Creates a lead owned by the given user and returns its id. */
  const makeLead = async (token: string, assignedToId?: string): Promise<string> => {
    const response = await ctx
      .http()
      .post('/api/v1/leads')
      .set(auth(token))
      .send({
        firstName: 'Test',
        lastName: 'Lead',
        mobile: mobile(),
        estimatedValue: 50000,
        nextFollowUpAt: inDays(1),
        ...(assignedToId ? { assignedToId } : {}),
      })
      .expect(201);

    return response.body.data.id as string;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ---------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------

  describe('updating a lead', () => {
    it('updates contact and commercial details', async () => {
      const id = await makeLead(ctx.orgA.owner.accessToken);

      const response = await ctx
        .http()
        .patch(`/api/v1/leads/${id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          companyName: 'Updated Industrial',
          city: 'Denver',
          estimatedValue: 125000,
          priority: 'URGENT',
        })
        .expect(200);

      expect(response.body.data.companyName).toBe('Updated Industrial');
      expect(response.body.data.priority).toBe('URGENT');
      expect(response.body.data.estimatedValue).toBe('125000');
    });

    it('re-normalises an edited mobile to E.164', async () => {
      const id = await makeLead(ctx.orgA.owner.accessToken);

      const response = await ctx
        .http()
        .patch(`/api/v1/leads/${id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ mobile: '(415) 555-0199' })
        .expect(200);

      // Otherwise an edited number stops matching for duplicate detection.
      expect(response.body.data.mobile).toBe('+14155550199');
    });

    it('records an activity for the edit', async () => {
      const id = await makeLead(ctx.orgA.owner.accessToken);

      await ctx
        .http()
        .patch(`/api/v1/leads/${id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ city: 'Austin' })
        .expect(200);

      const activities = await ctx
        .http()
        .get(`/api/v1/leads/${id}/activities`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      const types = (activities.body.data.items as { type: string }[]).map((a) => a.type);
      expect(types).toContain('LEAD_UPDATED');
    });

    it('cannot update a lead in ANOTHER organization', async () => {
      const id = await makeLead(ctx.orgB.owner.accessToken);

      await ctx
        .http()
        .patch(`/api/v1/leads/${id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ city: 'Hacked' })
        .expect(404);
    });

    it('a SALES_REP cannot update a colleague’s lead', async () => {
      const id = await makeLead(ctx.orgA.owner.accessToken, ctx.orgA.owner.id);

      // Visibility governs writes as well as reads, and gives the same 404.
      await ctx
        .http()
        .patch(`/api/v1/leads/${id}`)
        .set(auth(ctx.orgA.rep.accessToken))
        .send({ city: 'Nope' })
        .expect(404);
    });

    it('a SALES_REP CAN update their own lead', async () => {
      const id = await makeLead(ctx.orgA.owner.accessToken, ctx.orgA.rep.id);

      await ctx
        .http()
        .patch(`/api/v1/leads/${id}`)
        .set(auth(ctx.orgA.rep.accessToken))
        .send({ city: 'Portland' })
        .expect(200);
    });
  });

  // ---------------------------------------------------------------------------
  // Status transitions and won/lost data
  // ---------------------------------------------------------------------------

  describe('status transitions', () => {
    it('moves forward through the pipeline', async () => {
      const id = await makeLead(ctx.orgA.owner.accessToken);

      const response = await ctx
        .http()
        .patch(`/api/v1/leads/${id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ status: 'QUALIFIED' })
        .expect(200);

      expect(response.body.data.status).toBe('QUALIFIED');
    });

    it('requires a reason when marking a lead lost', async () => {
      const id = await makeLead(ctx.orgA.owner.accessToken);

      const response = await ctx
        .http()
        .patch(`/api/v1/leads/${id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ status: 'LOST' })
        .expect(400);

      // "Why do we lose?" is the most valuable question in the dataset.
      expect(response.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
      expect(response.body.error.details.lostReason).toBeDefined();
    });

    it('records the lost reason and clears the next action', async () => {
      const id = await makeLead(ctx.orgA.owner.accessToken);

      const response = await ctx
        .http()
        .patch(`/api/v1/leads/${id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ status: 'LOST', lostReason: 'Chose a competitor' })
        .expect(200);

      expect(response.body.data.status).toBe('LOST');
      // A closed lead has no next action — the CHECK constraint's only exemption.
      expect(response.body.data.nextFollowUpAt).toBeNull();
    });

    it('records the won value separately from the estimate', async () => {
      const id = await makeLead(ctx.orgA.owner.accessToken);

      await ctx
        .http()
        .patch(`/api/v1/leads/${id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ status: 'WON', wonValue: 47500 })
        .expect(200);

      const detail = await ctx
        .http()
        .get(`/api/v1/leads/${id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      // The estimate survives, so forecast accuracy stays measurable.
      expect(detail.body.data.estimatedValue).toBe('50000');
      expect(detail.body.data.status).toBe('WON');
    });

    it('refuses to reopen a WON deal', async () => {
      const id = await makeLead(ctx.orgA.owner.accessToken);

      await ctx
        .http()
        .patch(`/api/v1/leads/${id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ status: 'WON', wonValue: 1000 })
        .expect(200);

      const response = await ctx
        .http()
        .patch(`/api/v1/leads/${id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ status: 'NEGOTIATION', nextFollowUpAt: inDays(1) })
        .expect(409);

      // Reopening would corrupt conversion figures already reported.
      expect(response.body.error.code).toBe(ERROR_CODES.INVALID_STATUS_TRANSITION);
    });

    it('allows a LOST lead to reopen into an active stage', async () => {
      const id = await makeLead(ctx.orgA.owner.accessToken);

      await ctx
        .http()
        .patch(`/api/v1/leads/${id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ status: 'LOST', lostReason: 'Budget frozen' })
        .expect(200);

      // Customers come back.
      const response = await ctx
        .http()
        .patch(`/api/v1/leads/${id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ status: 'CONTACTED', nextFollowUpAt: inDays(2) })
        .expect(200);

      expect(response.body.data.status).toBe('CONTACTED');
    });

    it('refuses LOST straight to WON', async () => {
      const id = await makeLead(ctx.orgA.owner.accessToken);

      await ctx
        .http()
        .patch(`/api/v1/leads/${id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ status: 'LOST', lostReason: 'Gone quiet' })
        .expect(200);

      await ctx
        .http()
        .patch(`/api/v1/leads/${id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ status: 'WON', wonValue: 5000 })
        .expect(409);
    });
  });

  // ---------------------------------------------------------------------------
  // Reassignment
  // ---------------------------------------------------------------------------

  describe('reassignment', () => {
    it('transfers ownership and logs it', async () => {
      const id = await makeLead(ctx.orgA.owner.accessToken, ctx.orgA.owner.id);

      const response = await ctx
        .http()
        .post(`/api/v1/leads/${id}/assign`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ assignedToId: ctx.orgA.rep.id, reason: 'Territory change' })
        .expect(200);

      expect(response.body.data.assignedTo.id).toBe(ctx.orgA.rep.id);

      const activities = await ctx
        .http()
        .get(`/api/v1/leads/${id}/activities`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      const types = (activities.body.data.items as { type: string }[]).map((a) => a.type);
      expect(types.some((t) => t === 'LEAD_REASSIGNED' || t === 'LEAD_ASSIGNED')).toBe(true);
    });

    it('refuses an assignee from ANOTHER organization', async () => {
      const id = await makeLead(ctx.orgA.owner.accessToken);

      // leads.assigned_to references the global users table, so nothing in the
      // schema stops this.
      const response = await ctx
        .http()
        .post(`/api/v1/leads/${id}/assign`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ assignedToId: ctx.orgB.rep.id })
        .expect(400);

      expect(response.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    });

    it('a SALES_REP cannot reassign', async () => {
      const id = await makeLead(ctx.orgA.owner.accessToken, ctx.orgA.rep.id);

      // lead.assign is a manager-and-above permission, distinct from lead.update.
      await ctx
        .http()
        .post(`/api/v1/leads/${id}/assign`)
        .set(auth(ctx.orgA.rep.accessToken))
        .send({ assignedToId: ctx.orgA.rep.id })
        .expect(403);
    });
  });

  // ---------------------------------------------------------------------------
  // Archive
  // ---------------------------------------------------------------------------

  describe('archiving', () => {
    it('removes the lead from listings but keeps its history', async () => {
      const id = await makeLead(ctx.orgA.owner.accessToken);

      await ctx
        .http()
        .delete(`/api/v1/leads/${id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(204);

      await ctx
        .http()
        .get(`/api/v1/leads/${id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(404);

      const list = await ctx
        .http()
        .get('/api/v1/leads')
        .query({ limit: 100 })
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect((list.body.data.items as { id: string }[]).map((l) => l.id)).not.toContain(id);
    });

    it('a SALES_REP cannot archive', async () => {
      const id = await makeLead(ctx.orgA.owner.accessToken, ctx.orgA.rep.id);

      await ctx
        .http()
        .delete(`/api/v1/leads/${id}`)
        .set(auth(ctx.orgA.rep.accessToken))
        .expect(403);
    });

    it('cannot archive another organization’s lead', async () => {
      const id = await makeLead(ctx.orgB.owner.accessToken);

      await ctx
        .http()
        .delete(`/api/v1/leads/${id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------------
  // Activities
  // ---------------------------------------------------------------------------

  describe('activities', () => {
    it.each(['CALL_COMPLETED', 'CALL_NOT_ANSWERED', 'CALL_BACK_LATER', 'WHATSAPP_SENT'])(
      'logs %s',
      async (activityType) => {
        const id = await makeLead(ctx.orgA.owner.accessToken);

        await ctx
          .http()
          .post(`/api/v1/leads/${id}/activities`)
          .set(auth(ctx.orgA.owner.accessToken))
          .send({ activityType, description: 'Spoke about pricing' })
          .expect(201);

        const activities = await ctx
          .http()
          .get(`/api/v1/leads/${id}/activities`)
          .set(auth(ctx.orgA.owner.accessToken))
          .expect(200);

        const types = (activities.body.data.items as { type: string }[]).map((a) => a.type);
        expect(types).toContain(activityType);
      },
    );

    it('refuses a system activity type from a client', async () => {
      const id = await makeLead(ctx.orgA.owner.accessToken);

      // Otherwise a client could fabricate history that never happened.
      await ctx
        .http()
        .post(`/api/v1/leads/${id}/activities`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ activityType: 'LEAD_WON', description: 'Fake' })
        .expect(400);
    });

    it('adds a note', async () => {
      const id = await makeLead(ctx.orgA.owner.accessToken);

      await ctx
        .http()
        .post(`/api/v1/leads/${id}/notes`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ body: 'Customer prefers a call after 4pm.' })
        .expect(201);

      const activities = await ctx
        .http()
        .get(`/api/v1/leads/${id}/activities`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      const note = (activities.body.data.items as { type: string; description: string }[]).find(
        (a) => a.type === 'NOTE_ADDED',
      );
      expect(note?.description).toBe('Customer prefers a call after 4pm.');
    });

    it('rejects an empty note', async () => {
      const id = await makeLead(ctx.orgA.owner.accessToken);

      await ctx
        .http()
        .post(`/api/v1/leads/${id}/notes`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ body: '   ' })
        .expect(400);
    });

    it('paginates the timeline', async () => {
      const id = await makeLead(ctx.orgA.owner.accessToken);

      for (let index = 0; index < 5; index += 1) {
        await ctx
          .http()
          .post(`/api/v1/leads/${id}/notes`)
          .set(auth(ctx.orgA.owner.accessToken))
          .send({ body: `Note ${index}` })
          .expect(201);
      }

      const page = await ctx
        .http()
        .get(`/api/v1/leads/${id}/activities`)
        .query({ limit: 3 })
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect(page.body.data.items).toHaveLength(3);
      expect(page.body.data.hasMore).toBe(true);
      expect(page.body.data.nextCursor).toBeTruthy();
    });

    it('cannot read another organization’s timeline', async () => {
      const id = await makeLead(ctx.orgB.owner.accessToken);

      await ctx
        .http()
        .get(`/api/v1/leads/${id}/activities`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------------
  // Follow-ups
  // ---------------------------------------------------------------------------

  describe('follow-ups', () => {
    const createFollowUp = async (leadId: string, token: string, when: string) => {
      const response = await ctx
        .http()
        .post(`/api/v1/leads/${leadId}/follow-ups`)
        .set(auth(token))
        .send({ scheduledAt: when, type: 'CALL', title: 'Check in' })
        .expect(201);
      return response.body.data as { id: string; scheduledAt: string };
    };

    it('schedules a follow-up and mirrors it onto the lead', async () => {
      const leadId = await makeLead(ctx.orgA.owner.accessToken);
      const when = inDays(3);

      await createFollowUp(leadId, ctx.orgA.owner.accessToken, when);

      const lead = await ctx
        .http()
        .get(`/api/v1/leads/${leadId}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      // leads.next_follow_up_at is a denormalised mirror of the earliest open
      // follow-up; the CHECK constraint reads it, so drift would be fatal.
      expect(new Date(lead.body.data.nextFollowUpAt).getTime()).toBe(
        new Date(when).getTime(),
      );
    });

    it('refuses to schedule on a closed lead', async () => {
      const leadId = await makeLead(ctx.orgA.owner.accessToken);

      await ctx
        .http()
        .patch(`/api/v1/leads/${leadId}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ status: 'WON', wonValue: 1000 })
        .expect(200);

      await ctx
        .http()
        .post(`/api/v1/leads/${leadId}/follow-ups`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ scheduledAt: inDays(1) })
        .expect(400);
    });

    it('refuses completion with no next action while the lead is open', async () => {
      const leadId = await makeLead(ctx.orgA.owner.accessToken);
      const followUp = await createFollowUp(leadId, ctx.orgA.owner.accessToken, inDays(1));

      const response = await ctx
        .http()
        .post(`/api/v1/follow-ups/${followUp.id}/complete`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ outcome: 'Spoke to customer' })
        .expect(400);

      // This is the product promise. A bare "done" is how leads get forgotten.
      expect(response.body.error.details.nextFollowUpAt).toBeDefined();
    });

    it('completes when the next action is scheduled', async () => {
      const leadId = await makeLead(ctx.orgA.owner.accessToken);
      const followUp = await createFollowUp(leadId, ctx.orgA.owner.accessToken, inDays(1));

      const response = await ctx
        .http()
        .post(`/api/v1/follow-ups/${followUp.id}/complete`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ outcome: 'Spoke to customer', nextFollowUpAt: inDays(7) })
        .expect(200);

      expect(response.body.data.followUp.status).toBe('COMPLETED');
      expect(response.body.data.nextFollowUpAt).toBeTruthy();
    });

    it('completes by closing the lead instead', async () => {
      const leadId = await makeLead(ctx.orgA.owner.accessToken);
      const followUp = await createFollowUp(leadId, ctx.orgA.owner.accessToken, inDays(1));

      await ctx
        .http()
        .post(`/api/v1/follow-ups/${followUp.id}/complete`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ outcome: 'Deal closed', leadStatus: 'WON', wonValue: 60000 })
        .expect(200);

      const lead = await ctx
        .http()
        .get(`/api/v1/leads/${leadId}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect(lead.body.data.status).toBe('WON');
      expect(lead.body.data.nextFollowUpAt).toBeNull();
    });

    it('refuses to complete the same follow-up twice', async () => {
      const leadId = await makeLead(ctx.orgA.owner.accessToken);
      const followUp = await createFollowUp(leadId, ctx.orgA.owner.accessToken, inDays(1));

      await ctx
        .http()
        .post(`/api/v1/follow-ups/${followUp.id}/complete`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ outcome: 'Done', nextFollowUpAt: inDays(5) })
        .expect(200);

      // A double submit must not record two completions.
      await ctx
        .http()
        .post(`/api/v1/follow-ups/${followUp.id}/complete`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ outcome: 'Again', nextFollowUpAt: inDays(6) })
        .expect(409);
    });

    it('reschedules by creating a replacement', async () => {
      const leadId = await makeLead(ctx.orgA.owner.accessToken);
      const followUp = await createFollowUp(leadId, ctx.orgA.owner.accessToken, inDays(1));
      const later = inDays(10);

      const response = await ctx
        .http()
        .post(`/api/v1/follow-ups/${followUp.id}/reschedule`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ scheduledAt: later, reason: 'Customer travelling' })
        .expect(200);

      // A new row, so the missed attempt stays visible.
      expect(response.body.data.id).not.toBe(followUp.id);
      expect(new Date(response.body.data.scheduledAt).getTime()).toBe(
        new Date(later).getTime(),
      );

      const onLead = await ctx
        .http()
        .get(`/api/v1/leads/${leadId}/follow-ups`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect((onLead.body.data as unknown[]).length).toBeGreaterThanOrEqual(2);
    });

    it('refuses to cancel the only follow-up on an open lead', async () => {
      const leadId = await makeLead(ctx.orgA.owner.accessToken);
      const followUp = await createFollowUp(leadId, ctx.orgA.owner.accessToken, inDays(1));

      const response = await ctx
        .http()
        .delete(`/api/v1/follow-ups/${followUp.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ reason: 'Not needed' })
        .expect(400);

      // Would leave the lead with no next action.
      expect(response.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    });

    it('cancels when another follow-up remains', async () => {
      const leadId = await makeLead(ctx.orgA.owner.accessToken);
      const first = await createFollowUp(leadId, ctx.orgA.owner.accessToken, inDays(1));
      await createFollowUp(leadId, ctx.orgA.owner.accessToken, inDays(4));

      await ctx
        .http()
        .delete(`/api/v1/follow-ups/${first.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ reason: 'Duplicate' })
        .expect(204);
    });

    it('buckets overdue, today and upcoming without overlap', async () => {
      const leadId = await makeLead(ctx.orgA.owner.accessToken, ctx.orgA.owner.id);
      await createFollowUp(leadId, ctx.orgA.owner.accessToken, inDays(-2));

      const overdue = await ctx
        .http()
        .get('/api/v1/follow-ups')
        .query({ bucket: 'overdue', limit: 200 })
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      const upcoming = await ctx
        .http()
        .get('/api/v1/follow-ups')
        .query({ bucket: 'upcoming', limit: 200 })
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      const overdueIds = (overdue.body.data as { id: string; isOverdue: boolean }[]).map(
        (f) => f.id,
      );
      const upcomingIds = (upcoming.body.data as { id: string }[]).map((f) => f.id);

      expect(overdueIds.length).toBeGreaterThan(0);
      expect((overdue.body.data as { isOverdue: boolean }[]).every((f) => f.isOverdue)).toBe(true);
      // Overlap would double-count and understate the overdue problem.
      expect(overdueIds.filter((id) => upcomingIds.includes(id))).toHaveLength(0);
    });

    it('a SALES_REP sees only their own follow-ups', async () => {
      const ownerLead = await makeLead(ctx.orgA.owner.accessToken, ctx.orgA.owner.id);
      const owned = await createFollowUp(ownerLead, ctx.orgA.owner.accessToken, inDays(2));

      const repView = await ctx
        .http()
        .get('/api/v1/follow-ups')
        .query({ bucket: 'upcoming', limit: 200 })
        .set(auth(ctx.orgA.rep.accessToken))
        .expect(200);

      expect((repView.body.data as { id: string }[]).map((f) => f.id)).not.toContain(owned.id);
    });

    it('cannot complete another organization’s follow-up', async () => {
      const leadId = await makeLead(ctx.orgB.owner.accessToken);
      const followUp = await createFollowUp(leadId, ctx.orgB.owner.accessToken, inDays(1));

      const response = await ctx
        .http()
        .post(`/api/v1/follow-ups/${followUp.id}/complete`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ outcome: 'Hijack', nextFollowUpAt: inDays(2) })
        .expect(404);

      expect(response.body.error.code).toBe(ERROR_CODES.FOLLOW_UP_NOT_FOUND);
    });

    it('cannot schedule a follow-up on another organization’s lead', async () => {
      const leadId = await makeLead(ctx.orgB.owner.accessToken);

      await ctx
        .http()
        .post(`/api/v1/leads/${leadId}/follow-ups`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ scheduledAt: inDays(1) })
        .expect(404);
    });

    it('refuses an assignee from another organization', async () => {
      const leadId = await makeLead(ctx.orgA.owner.accessToken);

      await ctx
        .http()
        .post(`/api/v1/leads/${leadId}/follow-ups`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ scheduledAt: inDays(1), assignedUserId: ctx.orgB.rep.id })
        .expect(400);
    });
  });
});
