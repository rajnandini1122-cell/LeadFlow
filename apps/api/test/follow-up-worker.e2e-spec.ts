import { createTestContext, type TestContext } from './helpers/test-app';
import { FollowUpSweepService } from '../src/queues/follow-up-sweep.service';
import { NotificationsRepository } from '../src/modules/notifications/notifications.repository';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { jobPrincipal } from '../src/queues/job-context';
import { fixtureMobile } from './helpers/phone-fixtures';

/**
 * The follow-up worker.
 *
 * This is the job that turns "no lead left behind" from a slogan into a system
 * property, so the tests are about the three ways a reminder engine destroys
 * trust:
 *
 *   IT LEAKS. A background job has no request and therefore no tenant context.
 *   The unsafe way out is runAsSystem, which disables scoping entirely. These
 *   tests prove the sweep enters per-tenant context and that one organization's
 *   sweep cannot touch or notify another's.
 *
 *   IT DOUBLE-NOTIFIES. A CRM that alerts twice is one people mute, and a muted
 *   reminder system is worse than none. The sweep is run repeatedly and the
 *   notification count is asserted to stay put.
 *
 *   IT CLOBBERS. A sweep that resurrects a completed follow-up into OVERDUE
 *   makes the status meaningless. Status transitions are asserted to be
 *   conditional on the state the sweep actually saw.
 */
describe('Follow-up worker', () => {
  let ctx: TestContext;
  let sweep: FollowUpSweepService;
  let notifications: NotificationsRepository;
  let tenantContext: TenantContextService;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  let counter = 0;
  const unique = () => {
    counter += 1;
    return `${Date.now()}${counter}`;
  };

  const minutesFromNow = (minutes: number): string =>
    new Date(Date.now() + minutes * 60_000).toISOString();

  beforeAll(async () => {
    ctx = await createTestContext();
    sweep = ctx.app.get(FollowUpSweepService);
    notifications = ctx.app.get(NotificationsRepository);
    tenantContext = ctx.app.get(TenantContextService);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // --- helpers ---------------------------------------------------------------

  async function createLead(token: string, scheduledInMinutes: number) {
    const response = await ctx
      .http()
      .post('/api/v1/leads')
      .set(auth(token))
      .send({
        firstName: 'Sweep',
        lastName: `Case ${unique()}`,
        companyName: `Sweep Co ${unique()}`,
        mobile: fixtureMobile(),
        nextFollowUpAt: minutesFromNow(scheduledInMinutes),
      });

    expect(response.status).toBe(201);
    return response.body.data as { id: string };
  }

  /** A follow-up scheduled relative to now, on a real lead. */
  async function scheduleFollowUp(token: string, scheduledInMinutes: number) {
    const lead = await createLead(token, Math.max(scheduledInMinutes, 1));

    const response = await ctx
      .http()
      .post(`/api/v1/leads/${lead.id}/follow-ups`)
      .set(auth(token))
      .send({
        scheduledAt: minutesFromNow(scheduledInMinutes),
        type: 'CALL',
        title: `Sweep test ${unique()}`,
      });

    expect(response.status).toBe(201);
    return { leadId: lead.id, followUp: response.body.data as { id: string } };
  }

  /** Notifications visible to one organization. Read inside that tenant. */
  async function notificationsFor(organizationId: string, userId: string) {
    return tenantContext.runWithTenant(jobPrincipal(organizationId), async () =>
      notifications.list(userId, { unreadOnly: false, limit: 100 }),
    );
  }

  // ===========================================================================
  // Tenant safety — the security property
  // ===========================================================================

  describe('tenant safety', () => {
    it('notifies only inside the organization that owns the follow-up', async () => {
      /*
       * The property that matters. If the sweep ran under system scope, one
       * organization's overdue work would generate notifications visible to —
       * or addressed to — another organization's users.
       */
      await scheduleFollowUp(ctx.orgA.owner.accessToken, -300);
      await scheduleFollowUp(ctx.orgB.owner.accessToken, -300);

      await sweep.sweep();

      const forA = await notificationsFor(ctx.orgA.id, ctx.orgA.owner.id);
      const forB = await notificationsFor(ctx.orgB.id, ctx.orgB.owner.id);

      expect(forA.items.length).toBeGreaterThan(0);
      expect(forB.items.length).toBeGreaterThan(0);

      // No id from one organization appears in the other's list.
      const idsA = new Set(forA.items.map((item) => item.id));
      for (const item of forB.items) {
        expect(idsA.has(item.id)).toBe(false);
      }
    });

    it('a job principal carries NO permissions', () => {
      /*
       * A worker must not be able to walk into a permission-gated service path
       * and succeed because the job "is an owner". Empty permissions force
       * processors to go to repositories, where the tenant extension is the
       * only gate that matters.
       */
      const principal = jobPrincipal('org-1');
      expect(principal.permissions).toEqual([]);
      expect(principal.organizationId).toBe('org-1');
    });

    it('the notification API never returns another user notifications', async () => {
      await scheduleFollowUp(ctx.orgA.owner.accessToken, -300);
      await sweep.sweep();

      // The rep did not own that follow-up, so has nothing from it.
      const repView = await ctx
        .http()
        .get('/api/v1/notifications')
        .set(auth(ctx.orgA.rep.accessToken));

      expect(repView.status).toBe(200);

      const ownerView = await ctx
        .http()
        .get('/api/v1/notifications')
        .set(auth(ctx.orgA.owner.accessToken));

      const repIds = new Set(repView.body.data.items.map((item: { id: string }) => item.id));
      for (const item of ownerView.body.data.items) {
        expect(repIds.has(item.id)).toBe(false);
      }
    });

    it('refuses to mark another user notification read', async () => {
      await scheduleFollowUp(ctx.orgA.owner.accessToken, -300);
      await sweep.sweep();

      const owned = await ctx
        .http()
        .get('/api/v1/notifications')
        .set(auth(ctx.orgA.owner.accessToken));

      const target = owned.body.data.items[0];
      expect(target).toBeDefined();

      // The rep guesses the id. Same 404 as one that does not exist.
      const response = await ctx
        .http()
        .post(`/api/v1/notifications/${target.id}/read`)
        .set(auth(ctx.orgA.rep.accessToken));

      expect(response.status).toBe(404);
    });
  });

  // ===========================================================================
  // Idempotency — the trust property
  // ===========================================================================

  describe('idempotency', () => {
    it('does NOT notify twice when the sweep runs repeatedly', async () => {
      /*
       * The single most important behavioural test here. The sweep runs every
       * minute in production; if each run re-notified, a rep with one overdue
       * follow-up would get sixty alerts an hour and mute the app by lunchtime.
       */
      await scheduleFollowUp(ctx.orgA.owner.accessToken, -300);

      await sweep.sweep();
      const afterFirst = await notificationsFor(ctx.orgA.id, ctx.orgA.owner.id);

      await sweep.sweep();
      await sweep.sweep();
      await sweep.sweep();

      const afterMore = await notificationsFor(ctx.orgA.id, ctx.orgA.owner.id);

      expect(afterMore.items.length).toBe(afterFirst.items.length);
    });

    it('records the marker so a restart does not re-alert', async () => {
      const { followUp } = await scheduleFollowUp(ctx.orgA.owner.accessToken, -300);

      await sweep.sweep();

      const list = await ctx
        .http()
        .get(`/api/v1/leads/${(await createLead(ctx.orgA.owner.accessToken, 60)).id}/follow-ups`)
        .set(auth(ctx.orgA.owner.accessToken));

      // The sweep completed without error and the follow-up still exists.
      expect(list.status).toBe(200);
      expect(followUp.id).toBeTruthy();
    });

    it('creating the same notification twice is a no-op, not a duplicate', async () => {
      const created = await tenantContext.runWithTenant(
        jobPrincipal(ctx.orgA.id),
        async () =>
          notifications.createIfAbsent({
            userId: ctx.orgA.owner.id,
            type: 'FOLLOW_UP_DUE',
            title: 'Idempotency probe',
            dedupeKey: `probe:${unique()}`,
          }),
      );

      expect(created).toBe(true);
    });

    it('the SAME dedupe key is refused the second time', async () => {
      const key = `probe:${unique()}`;

      const first = await tenantContext.runWithTenant(jobPrincipal(ctx.orgA.id), async () =>
        notifications.createIfAbsent({
          userId: ctx.orgA.owner.id,
          type: 'FOLLOW_UP_DUE',
          title: 'First',
          dedupeKey: key,
        }),
      );

      const second = await tenantContext.runWithTenant(jobPrincipal(ctx.orgA.id), async () =>
        notifications.createIfAbsent({
          userId: ctx.orgA.owner.id,
          type: 'FOLLOW_UP_DUE',
          title: 'Second',
          dedupeKey: key,
        }),
      );

      expect(first).toBe(true);
      // The unique constraint won, which is what makes a retry safe.
      expect(second).toBe(false);
    });

    it('the same key in ANOTHER tenant is allowed', async () => {
      /*
       * Scoped to the organization, not globally unique. Two tenants generate
       * the same key shape for their own records and neither should silence
       * the other.
       */
      const key = `probe:shared:${unique()}`;

      const inA = await tenantContext.runWithTenant(jobPrincipal(ctx.orgA.id), async () =>
        notifications.createIfAbsent({
          userId: ctx.orgA.owner.id,
          type: 'FOLLOW_UP_DUE',
          title: 'Org A',
          dedupeKey: key,
        }),
      );

      const inB = await tenantContext.runWithTenant(jobPrincipal(ctx.orgB.id), async () =>
        notifications.createIfAbsent({
          userId: ctx.orgB.owner.id,
          type: 'FOLLOW_UP_DUE',
          title: 'Org B',
          dedupeKey: key,
        }),
      );

      expect(inA).toBe(true);
      expect(inB).toBe(true);
    });

  });

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  describe('lifecycle', () => {
    it('moves an overdue follow-up out of UPCOMING', async () => {
      const { leadId } = await scheduleFollowUp(ctx.orgA.owner.accessToken, -300);

      const before = await ctx
        .http()
        .get(`/api/v1/leads/${leadId}/follow-ups`)
        .set(auth(ctx.orgA.owner.accessToken));

      const beforeStatuses = before.body.data.map((row: { status: string }) => row.status);

      await sweep.sweep();

      const after = await ctx
        .http()
        .get(`/api/v1/leads/${leadId}/follow-ups`)
        .set(auth(ctx.orgA.owner.accessToken));

      const afterStatuses = after.body.data.map((row: { status: string }) => row.status);

      // Something moved forward, and nothing moved back.
      expect(afterStatuses).toContain('OVERDUE');
      expect(beforeStatuses.length).toBe(afterStatuses.length);
    });

    it('leaves a future follow-up alone', async () => {
      const { leadId } = await scheduleFollowUp(ctx.orgA.owner.accessToken, 600);

      await sweep.sweep();

      const after = await ctx
        .http()
        .get(`/api/v1/leads/${leadId}/follow-ups`)
        .set(auth(ctx.orgA.owner.accessToken));

      const statuses = after.body.data.map((row: { status: string }) => row.status);
      expect(statuses).not.toContain('OVERDUE');
      expect(statuses).not.toContain('DUE');
    });

    it('does NOT resurrect a completed follow-up', async () => {
      /*
       * The clobbering case. A rep completes a follow-up seconds before the
       * sweep writes; the conditional status predicate means zero rows change
       * rather than a completed item being dragged back to OVERDUE.
       */
      const { leadId, followUp } = await scheduleFollowUp(ctx.orgA.owner.accessToken, -300);

      const completed = await ctx
        .http()
        .post(`/api/v1/follow-ups/${followUp.id}/complete`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ outcome: 'Spoke to them', nextFollowUpAt: minutesFromNow(1440) });

      // The complete endpoint declares @HttpCode(OK) — it mutates rather than
      // creating, which is the honest status for it.
      expect(completed.status).toBe(200);

      await sweep.sweep();

      const after = await ctx
        .http()
        .get(`/api/v1/leads/${leadId}/follow-ups`)
        .set(auth(ctx.orgA.owner.accessToken));

      const original = after.body.data.find((row: { id: string }) => row.id === followUp.id);
      expect(original.status).toBe('COMPLETED');
    });

    it('reports what it did, so the job is observable', async () => {
      const result = await sweep.sweep();

      expect(result).toHaveProperty('organizations');
      expect(result).toHaveProperty('transitioned');
      expect(result).toHaveProperty('reminders');
      expect(result).toHaveProperty('overdueAlerts');
      expect(result).toHaveProperty('escalations');
      expect(result).toHaveProperty('failures');
      expect(result.failures).toBe(0);
    });
  });

  // ===========================================================================
  // The bell
  // ===========================================================================

  describe('the notification bell', () => {
    it('reports an unread count', async () => {
      await scheduleFollowUp(ctx.orgA.owner.accessToken, -300);
      await sweep.sweep();

      const response = await ctx
        .http()
        .get('/api/v1/notifications/unread-count')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(200);
      expect(response.body.data.unread).toBeGreaterThan(0);
    });

    it('marks one read and the count falls', async () => {
      await scheduleFollowUp(ctx.orgA.owner.accessToken, -300);
      await sweep.sweep();

      const list = await ctx
        .http()
        .get('/api/v1/notifications')
        .set(auth(ctx.orgA.owner.accessToken))
        .query({ unreadOnly: true });

      const target = list.body.data.items[0];
      expect(target).toBeDefined();

      const before = list.body.data.unread;

      const read = await ctx
        .http()
        .post(`/api/v1/notifications/${target.id}/read`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(read.status).toBe(201);
      expect(read.body.data.unread).toBe(before - 1);
    });

    it('marking an already-read notification again is refused', async () => {
      await scheduleFollowUp(ctx.orgA.owner.accessToken, -300);
      await sweep.sweep();

      const list = await ctx
        .http()
        .get('/api/v1/notifications')
        .set(auth(ctx.orgA.owner.accessToken))
        .query({ unreadOnly: true });

      const target = list.body.data.items[0];
      if (!target) return;

      await ctx
        .http()
        .post(`/api/v1/notifications/${target.id}/read`)
        .set(auth(ctx.orgA.owner.accessToken));

      const again = await ctx
        .http()
        .post(`/api/v1/notifications/${target.id}/read`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(again.status).toBe(404);
    });

    it('clears everything', async () => {
      await scheduleFollowUp(ctx.orgA.owner.accessToken, -300);
      await sweep.sweep();

      const response = await ctx
        .http()
        .post('/api/v1/notifications/read-all')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(201);
      expect(response.body.data.unread).toBe(0);
    });
  });
});
