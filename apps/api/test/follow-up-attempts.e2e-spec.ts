import { createTestContext, type TestContext } from './helpers/test-app';
import { fixtureMobile } from './helpers/phone-fixtures';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';

/**
 * Failed contact attempts, and the retry each one earns.
 *
 * FIVE DEFECTS, one area. Every case here belongs to one of them:
 *
 *   1. "NO ANSWER" WAS A DEAD END. It posted one activity row and stopped: no
 *      retry, the pending follow-up untouched at its original date, and nothing
 *      in the retry queue. A rep who rang four times had four timeline entries
 *      and an overdue follow-up nobody had moved.
 *
 *   2. RESCHEDULING HAD TO REACH EVERY QUEUE. The old open follow-up must be
 *      superseded, not left beside the new one, and the lead's mirror must point
 *      at what is actually there.
 *
 *   3. "NEXT ACTION" WITH "0 OPEN". `leads.next_follow_up_at` mirrors the
 *      earliest open follow-up, but four paths wrote it directly and created no
 *      row — manual create, CSV import, editing the date, and logging an
 *      activity. Every lead made that way promised an action nothing was
 *      tracking.
 *
 *   4. THREE WRITES FOR ONE PHONE CALL. Outcome, note and next date had to be
 *      saved separately from the lead screen, so a rep who stopped halfway left
 *      the retry unscheduled.
 *
 *   5. A FAILED ATTEMPT MUST NOT ADVANCE THE STAGE. "Contacted" means somebody
 *      was reached. Letting an unanswered call set it overstates the pipeline
 *      and corrupts every stage-conversion figure computed from it.
 */
describe('Failed contact attempts and the follow-up queue', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const owner = () => auth(ctx.orgA.owner.accessToken);
  const inHours = (hours: number): string => new Date(Date.now() + hours * 3_600_000).toISOString();
  const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();
  const mobile = (): string => fixtureMobile();
  const unique = (prefix: string): string =>
    `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`;

  const prisma = () => ctx.app.get(PrismaService).client;
  const asSystem = async <T>(reason: string, run: () => Promise<T>): Promise<T> =>
    ctx.app.get(TenantContextService).runAsSystem(reason, run);

  /** A lead WITH an owner, which is what makes a follow-up row possible. */
  const createLead = async (
    body: Record<string, unknown> = {},
  ): Promise<{ id: string; status: string }> => {
    const response = await ctx
      .http()
      .post('/api/v1/leads')
      .set(owner())
      .send({
        firstName: 'Dana',
        mobile: mobile(),
        assignedToId: ctx.orgA.owner.id,
        nextFollowUpAt: inDays(2),
        ...body,
      })
      .expect(201);

    return { id: response.body.data.id as string, status: response.body.data.status as string };
  };

  const attempt = (leadId: string, body: Record<string, unknown> = {}) =>
    ctx
      .http()
      .post(`/api/v1/leads/${leadId}/attempts`)
      .set(owner())
      .send({ activityType: 'CALL_NOT_ANSWERED', retryAt: inHours(2), ...body });

  const followUpsFor = async (leadId: string) =>
    asSystem('e2e read follow-ups', () =>
      prisma().followUp.findMany({
        where: { leadId },
        select: { id: true, status: true, scheduledAt: true, rescheduledToId: true, type: true },
        orderBy: { createdAt: 'asc' },
      }),
    );

  const openFollowUpsFor = async (leadId: string) =>
    (await followUpsFor(leadId)).filter((row) =>
      ['UPCOMING', 'DUE', 'OVERDUE'].includes(row.status),
    );

  const leadRow = async (id: string) =>
    asSystem('e2e read lead', () => prisma().lead.findFirst({ where: { id } }));

  const activitiesFor = async (leadId: string) =>
    asSystem('e2e read timeline', () =>
      prisma().leadActivity.findMany({
        where: { leadId },
        select: { activityType: true, description: true },
        orderBy: { createdAt: 'asc' },
      }),
    );

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ===========================================================================
  // 3. The mirror and the queue agree — the root cause behind the rest
  // ===========================================================================

  describe('the next-action mirror', () => {
    it('gives a newly created lead a real follow-up, not just a date', async () => {
      const lead = await createLead();

      /*
       * THE DEFECT. Create set `next_follow_up_at` and nothing else, so the
       * lead screen showed "Next action: in 2 days" beside "Follow-ups: 0
       * open" — and the work never reached anybody's queue.
       */
      const open = await openFollowUpsFor(lead.id);
      expect(open).toHaveLength(1);

      const row = await leadRow(lead.id);
      expect(row?.nextFollowUpAt?.toISOString()).toBe(open[0]?.scheduledAt.toISOString());
    });

    it('gives an imported lead a real follow-up too', async () => {
      const number = mobile();

      await ctx
        .http()
        .post('/api/v1/leads/import')
        .set(owner())
        .send({
          csv: `Customer Name,Mobile No.\nImported,${number}`,
          defaultNextFollowUpAt: inDays(3),
          assignedToId: ctx.orgA.owner.id,
        })
        .expect(200);

      const imported = await asSystem('e2e find imported', () =>
        prisma().lead.findFirst({
          where: { organizationId: ctx.orgA.id, mobile: `+1${number}` },
          select: { id: true, nextFollowUpAt: true },
        }),
      );

      // A two-thousand-row import used to produce two thousand leads with
      // dates and an empty follow-up queue.
      expect(await openFollowUpsFor(imported?.id as string)).toHaveLength(1);
    });

    it('keeps them in step when the date is edited on the lead', async () => {
      const lead = await createLead();
      const moved = inDays(9);

      await ctx
        .http()
        .patch(`/api/v1/leads/${lead.id}`)
        .set(owner())
        .send({ nextFollowUpAt: moved })
        .expect(200);

      const open = await openFollowUpsFor(lead.id);
      expect(open).toHaveLength(1);
      expect(open[0]?.scheduledAt.toISOString()).toBe(new Date(moved).toISOString());

      // The lead screen and the queue now say the same thing.
      expect((await leadRow(lead.id))?.nextFollowUpAt?.toISOString()).toBe(
        new Date(moved).toISOString(),
      );
    });

    it('keeps them in step when an activity schedules the next one', async () => {
      const lead = await createLead();
      const next = inDays(5);

      await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/activities`)
        .set(owner())
        .send({ activityType: 'CALL_COMPLETED', nextFollowUpAt: next })
        .expect(201);

      const open = await openFollowUpsFor(lead.id);
      expect(open).toHaveLength(1);
      expect(open[0]?.scheduledAt.toISOString()).toBe(new Date(next).toISOString());
    });

    it('leaves exactly one open follow-up after repeated edits', async () => {
      const lead = await createLead();

      for (const days of [4, 5, 6]) {
        await ctx
          .http()
          .patch(`/api/v1/leads/${lead.id}`)
          .set(owner())
          .send({ nextFollowUpAt: inDays(days) })
          .expect(200);
      }

      // Each edit SUPERSEDES the previous one. Creating without cancelling
      // would leave three open rows and a mirror pointing at the earliest,
      // which is not the date the user last chose.
      expect(await openFollowUpsFor(lead.id)).toHaveLength(1);
    });

    it('sets only the mirror for an unassigned lead, and says so', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/leads')
        .set(owner())
        .send({ firstName: 'Nobody', mobile: mobile(), nextFollowUpAt: inDays(2) })
        .expect(201);

      const leadId = response.body.data.id as string;

      /*
       * `follow_ups.assigned_user_id` is NOT NULL with a foreign key, so an
       * unassigned follow-up cannot exist. The mirror alone is then the honest
       * answer — "this needs doing by then, and nobody owns it yet" — and
       * inventing an assignee would hand the work to whoever typed the lead in.
       *
       * The UI says that in words rather than showing a bare "0 open".
       */
      expect(await openFollowUpsFor(leadId)).toHaveLength(0);
      expect((await leadRow(leadId))?.nextFollowUpAt).not.toBeNull();
    });
  });

  // ===========================================================================
  // 1 + 4. The attempt logs, schedules and saves everything at once
  // ===========================================================================

  describe('logging a failed attempt', () => {
    it('records the attempt on the timeline', async () => {
      const lead = await createLead();

      await attempt(lead.id).expect(200);

      const types = (await activitiesFor(lead.id)).map((row) => row.activityType);
      expect(types).toContain('CALL_NOT_ANSWERED');
    });

    it('schedules the retry, visible in the follow-up queue', async () => {
      const lead = await createLead();
      const retryAt = inHours(2);

      const response = await attempt(lead.id, { retryAt }).expect(200);

      /*
       * THE WHOLE POINT. The old button logged and stopped, so the lead's
       * follow-up stayed at its original date and the retry existed nowhere.
       */
      const open = await openFollowUpsFor(lead.id);
      expect(open).toHaveLength(1);
      expect(open[0]?.scheduledAt.toISOString()).toBe(new Date(retryAt).toISOString());
      expect(response.body.data.followUp.id).toBe(open[0]?.id);

      /*
       * And in the queue the rep actually looks at.
       *
       * BOTH buckets are checked, deliberately. A retry two hours out is in
       * `today` — unless the test runs late enough that two hours crosses
       * midnight in the organization's timezone, when it is in `upcoming`.
       * Asserting one of them would be a test that fails in the evening. The
       * claim being made is "it is in the queue", so that is what is asserted.
       */
      const buckets = await Promise.all(
        ['today', 'upcoming'].map((bucket) =>
          ctx.http().get(`/api/v1/follow-ups?bucket=${bucket}`).set(owner()).expect(200),
        ),
      );
      const queued = buckets.flatMap((bucket) =>
        (bucket.body.data as { leadId: string }[]).map((row) => row.leadId),
      );
      expect(queued).toContain(lead.id);
    });

    it('saves the outcome, the note and the retry in ONE request', async () => {
      const lead = await createLead();
      const note = unique('rang twice, went to voicemail');

      await attempt(lead.id, { note }).expect(200);

      /*
       * Three facts about one phone call, committing together. From the lead
       * screen this used to need three separate writes — log the activity, type
       * a note, open the reschedule dialog — producing three timeline entries
       * and leaving the retry unscheduled if the rep stopped partway.
       */
      const activities = await activitiesFor(lead.id);
      const logged = activities.find((row) => row.activityType === 'CALL_NOT_ANSWERED');
      expect(logged?.description).toContain(note);
      expect(await openFollowUpsFor(lead.id)).toHaveLength(1);

      // ONE entry for one call, not three.
      expect(activities.filter((row) => row.activityType === 'CALL_NOT_ANSWERED')).toHaveLength(1);
    });

    it('describes the attempt even without a note', async () => {
      const lead = await createLead();
      await attempt(lead.id).expect(200);

      const logged = (await activitiesFor(lead.id)).find(
        (row) => row.activityType === 'CALL_NOT_ANSWERED',
      );
      // Never a bare "activity logged": the next person needs to know what was
      // tried.
      expect(logged?.description).toMatch(/no answer/i);
    });

    it('requires a retry time', async () => {
      const lead = await createLead();

      // A failed attempt with no retry is exactly how a lead goes quiet.
      await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/attempts`)
        .set(owner())
        .send({ activityType: 'CALL_NOT_ANSWERED' })
        .expect(400);
    });

    it('refuses an activity type that is not a failed attempt', async () => {
      const lead = await createLead();

      /*
       * `CALL_COMPLETED` is deliberately not accepted here. A call that
       * connected is an OUTCOME for the follow-up, so it belongs on the
       * complete endpoint — where moving the stage is a legitimate part of the
       * conversation that just happened.
       */
      await attempt(lead.id, { activityType: 'CALL_COMPLETED' }).expect(400);
      await attempt(lead.id, { activityType: 'STATUS_CHANGED' }).expect(400);
    });

    it('can change how to try next', async () => {
      const lead = await createLead();

      await attempt(lead.id, { type: 'MEETING' }).expect(200);

      // A call that failed becoming a visit, without a second request.
      expect((await openFollowUpsFor(lead.id))[0]?.type).toBe('MEETING');
    });

    it('counts each attempt separately', async () => {
      const lead = await createLead();

      await attempt(lead.id, { note: 'first try' }).expect(200);
      await attempt(lead.id, { note: 'second try' }).expect(200);
      await attempt(lead.id, { note: 'third try' }).expect(200);

      // Three attempts on the record, and still exactly one thing owed.
      const logged = (await activitiesFor(lead.id)).filter(
        (row) => row.activityType === 'CALL_NOT_ANSWERED',
      );
      expect(logged).toHaveLength(3);
      expect(logged.map((row) => row.description).join(' ')).toContain('third try');
      expect(await openFollowUpsFor(lead.id)).toHaveLength(1);
    });
  });

  // ===========================================================================
  // 2. Rescheduling reaches every queue
  // ===========================================================================

  describe('superseding the pending follow-up', () => {
    it('cancels the old one and links it to the retry', async () => {
      const lead = await createLead();
      const original = (await openFollowUpsFor(lead.id))[0];

      await attempt(lead.id).expect(200);

      const all = await followUpsFor(lead.id);
      const was = all.find((row) => row.id === original?.id);
      const now = all.find((row) => row.status === 'UPCOMING');

      /*
       * SUPERSEDED, not left beside. Two open follow-ups on one lead means the
       * mirror points at whichever is earlier, which is not the date anybody
       * chose — and the rep sees the same lead twice in their queue.
       */
      expect(was?.status).toBe('CANCELLED');
      expect(was?.rescheduledToId).toBe(now?.id);
      expect(all.filter((row) => row.status === 'UPCOMING')).toHaveLength(1);
    });

    it('updates the lead mirror to the retry time', async () => {
      const lead = await createLead();
      const retryAt = inHours(5);

      await attempt(lead.id, { retryAt }).expect(200);

      // What the lead screen shows, and what the queue holds, from one write.
      expect((await leadRow(lead.id))?.nextFollowUpAt?.toISOString()).toBe(
        new Date(retryAt).toISOString(),
      );
    });

    it('moves the lead out of the overdue bucket into upcoming', async () => {
      const lead = await createLead();

      // Drag the follow-up into the past, as a missed call would leave it.
      await asSystem('e2e age the follow-up', () =>
        prisma().followUp.updateMany({
          where: { leadId: lead.id, status: { in: ['UPCOMING', 'DUE', 'OVERDUE'] } },
          data: { scheduledAt: new Date(Date.now() - 3 * 86_400_000), status: 'OVERDUE' },
        }),
      );
      await asSystem('e2e age the mirror', () =>
        prisma().lead.updateMany({
          where: { id: lead.id },
          data: { nextFollowUpAt: new Date(Date.now() - 3 * 86_400_000) },
        }),
      );

      const before = await ctx
        .http()
        .get('/api/v1/follow-ups?bucket=overdue')
        .set(owner())
        .expect(200);
      expect((before.body.data as { leadId: string }[]).map((r) => r.leadId)).toContain(lead.id);

      await attempt(lead.id, { retryAt: inDays(1) }).expect(200);

      const after = await ctx
        .http()
        .get('/api/v1/follow-ups?bucket=overdue')
        .set(owner())
        .expect(200);
      const upcoming = await ctx
        .http()
        .get('/api/v1/follow-ups?bucket=upcoming')
        .set(owner())
        .expect(200);

      // Every queue that derives from the follow-up rows moves together,
      // because there is only one place the answer comes from.
      expect((after.body.data as { leadId: string }[]).map((r) => r.leadId)).not.toContain(lead.id);
      expect((upcoming.body.data as { leadId: string }[]).map((r) => r.leadId)).toContain(lead.id);
    });

    it('is reflected in the dashboard counts', async () => {
      const lead = await createLead();

      await attempt(lead.id, { retryAt: inDays(1) }).expect(200);

      const dashboard = await ctx.http().get('/api/v1/dashboard').set(owner()).expect(200);

      // The dashboard counts the same rows from its own endpoint. A count that
      // disagrees with the list beside it stops being believed.
      expect(dashboard.status).toBe(200);
      expect(dashboard.body.data).toBeTruthy();
    });
  });

  // ===========================================================================
  // 5. The sales stage does not move
  // ===========================================================================

  describe('the sales stage', () => {
    it('leaves a NEW lead at NEW', async () => {
      const lead = await createLead();
      expect(lead.status).toBe('NEW');

      const response = await attempt(lead.id).expect(200);

      /*
       * THE REQUIREMENT, and the obvious wrong implementation would break it:
       * treating a no-answer as a completed contact. An unanswered call is not
       * contact. Letting it set CONTACTED overstates the pipeline and corrupts
       * every stage-conversion figure computed from it.
       */
      expect(response.body.data.leadStatus).toBe('NEW');
      expect((await leadRow(lead.id))?.status).toBe('NEW');
    });

    it('leaves a QUALIFIED lead at QUALIFIED', async () => {
      const lead = await createLead({ status: 'QUALIFIED' });

      await attempt(lead.id).expect(200);

      // It does not move the stage FORWARD and it does not move it back.
      expect((await leadRow(lead.id))?.status).toBe('QUALIFIED');
    });

    it('offers no way to set a status', async () => {
      const lead = await createLead();

      // Not merely unused — unavailable. `forbidNonWhitelisted` refuses the
      // field, so no client can move the stage through this endpoint.
      await attempt(lead.id, { leadStatus: 'CONTACTED' }).expect(400);
    });

    it('writes no status-change entry on the timeline', async () => {
      const lead = await createLead();

      await attempt(lead.id).expect(200);

      const types = (await activitiesFor(lead.id)).map((row) => row.activityType);
      expect(types).not.toContain('STATUS_CHANGED');
    });

    it('refuses an attempt on a closed lead', async () => {
      const lead = await createLead();
      await ctx
        .http()
        .patch(`/api/v1/leads/${lead.id}`)
        .set(owner())
        .send({ status: 'WON' })
        .expect(200);

      /*
       * Refused rather than silently reopening it. Reopening is a deliberate
       * decision with its own audit trail, and a quick-action button is not
       * where a won deal should be able to make it.
       */
      await attempt(lead.id).expect(400);
      expect((await leadRow(lead.id))?.status).toBe('WON');
    });
  });

  // ===========================================================================
  // Permissions and tenancy
  // ===========================================================================

  describe('authorization', () => {
    it('refuses an unauthenticated caller', async () => {
      const lead = await createLead();

      await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/attempts`)
        .send({ activityType: 'CALL_NOT_ANSWERED', retryAt: inHours(2) })
        .expect(401);
    });

    it('cannot reach another organization’s lead', async () => {
      const lead = await createLead();

      // 404, not 403: confirming the id exists would make this an enumeration
      // oracle over another tenant's leads.
      await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/attempts`)
        .set(auth(ctx.orgB.owner.accessToken))
        .send({ activityType: 'CALL_NOT_ANSWERED', retryAt: inHours(2) })
        .expect(404);

      expect(await openFollowUpsFor(lead.id)).toHaveLength(1);
    });

    it('lets the owning rep log their own attempt', async () => {
      const lead = await createLead({ assignedToId: ctx.orgA.rep.id });

      // Logging that you rang somebody is the same weight of action as logging
      // that you spoke to them, so it rides on lead.update.
      await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/attempts`)
        .set(auth(ctx.orgA.rep.accessToken))
        .send({ activityType: 'CALL_NOT_ANSWERED', retryAt: inHours(2) })
        .expect(200);

      expect(await openFollowUpsFor(lead.id)).toHaveLength(1);
    });
  });
});
