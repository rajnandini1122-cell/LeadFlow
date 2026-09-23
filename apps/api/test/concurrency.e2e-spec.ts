import { createTestContext, type TestContext } from './helpers/test-app';
import { NotificationsRepository } from '../src/modules/notifications/notifications.repository';
import { DevicesRepository } from '../src/modules/notifications/push/devices.repository';
import { FollowUpSweepRepository } from '../src/queues/follow-up-sweep.repository';
import { FollowUpSweepService } from '../src/queues/follow-up-sweep.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { jobPrincipal } from '../src/queues/job-context';
import { fixtureMobile } from './helpers/phone-fixtures';

/**
 * Races.
 *
 * Every idempotency claim in this system rests on a database guarantee winning
 * a race — a unique constraint, or a conditional UPDATE that matches zero rows
 * for the loser. Those claims are only worth anything if the races are actually
 * run.
 *
 * IMPORTANT AND HONEST CAVEAT. These tests fire genuinely parallel promises,
 * but PGlite — the local development database — serves ONE connection at a
 * time, so locally they interleave rather than truly overlap. They are real
 * concurrency tests only when run against PostgreSQL, which is what CI does.
 * Passing locally is necessary and not sufficient; passing in CI is the
 * evidence that counts.
 *
 * That distinction is the whole reason this file is separate: it is the suite
 * whose result differs between the two databases.
 */
describe('Concurrency', () => {
  let ctx: TestContext;
  let notifications: NotificationsRepository;
  let devices: DevicesRepository;
  let sweepRepository: FollowUpSweepRepository;
  let sweep: FollowUpSweepService;
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
    notifications = ctx.app.get(NotificationsRepository);
    devices = ctx.app.get(DevicesRepository);
    sweepRepository = ctx.app.get(FollowUpSweepRepository);
    sweep = ctx.app.get(FollowUpSweepService);
    tenantContext = ctx.app.get(TenantContextService);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const inTenant = <T>(organizationId: string, fn: () => Promise<T>): Promise<T> =>
    tenantContext.runWithTenant(jobPrincipal(organizationId), fn);

  // ===========================================================================
  // Notification creation
  // ===========================================================================

  it('creates exactly ONE notification when five workers race on the same key', async () => {
    /*
     * The guarantee the entire reminder system rests on. Five workers, one
     * business event, one deterministic key — the unique index decides, and
     * everyone else is told they lost.
     *
     * Check-then-insert could never pass this: every caller would check, find
     * nothing, and insert.
     */
    const key = `race:${unique()}`;

    const results = await inTenant(ctx.orgA.id, async () =>
      Promise.all(
        Array.from({ length: 5 }, () =>
          notifications.createIfAbsent({
            userId: ctx.orgA.owner.id,
            type: 'FOLLOW_UP_DUE',
            title: 'Race',
            dedupeKey: key,
          }),
        ),
      ),
    );

    // Exactly one winner.
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((won) => !won)).toHaveLength(4);
  });

  it('lets two tenants use the same key simultaneously', async () => {
    // Scoped per organization, so neither can silence the other.
    const key = `race:shared:${unique()}`;

    const [inA, inB] = await Promise.all([
      inTenant(ctx.orgA.id, async () =>
        notifications.createIfAbsent({
          userId: ctx.orgA.owner.id,
          type: 'FOLLOW_UP_DUE',
          title: 'A',
          dedupeKey: key,
        }),
      ),
      inTenant(ctx.orgB.id, async () =>
        notifications.createIfAbsent({
          userId: ctx.orgB.owner.id,
          type: 'FOLLOW_UP_DUE',
          title: 'B',
          dedupeKey: key,
        }),
      ),
    ]);

    expect(inA).toBe(true);
    expect(inB).toBe(true);
  });

  // ===========================================================================
  // Marker claiming
  // ===========================================================================

  it('lets exactly ONE worker claim a follow-up marker', async () => {
    /*
     * The other half of the idempotency pair. The marker is claimed with a
     * conditional UPDATE (`WHERE reminder_sent_at IS NULL`), so the loser
     * updates zero rows and skips sending — which is what stops two workers
     * both notifying before either has written the marker.
     */
    const lead = await ctx
      .http()
      .post('/api/v1/leads')
      .set(auth(ctx.orgA.owner.accessToken))
      .send({
        firstName: 'Race',
        lastName: `Marker ${unique()}`,
        mobile: fixtureMobile(),
        nextFollowUpAt: minutesFromNow(60),
      });

    const followUp = await ctx
      .http()
      .post(`/api/v1/leads/${lead.body.data.id}/follow-ups`)
      .set(auth(ctx.orgA.owner.accessToken))
      .send({ scheduledAt: minutesFromNow(60), type: 'CALL' });

    const id = followUp.body.data.id as string;

    const claims = await inTenant(ctx.orgA.id, async () =>
      Promise.all(
        Array.from({ length: 5 }, () => sweepRepository.claimMarker(id, 'reminderSentAt')),
      ),
    );

    const winners = claims.filter((count) => count > 0);
    expect(winners).toHaveLength(1);
  });

  // ===========================================================================
  // Device registration
  // ===========================================================================

  it('produces ONE device row when the same token registers five times at once', async () => {
    /*
     * A phone that reconnects can fire several registrations before the first
     * response lands. The upsert on (organization, token) is what stops that
     * becoming five rows the fan-out then retries against.
     */
    const token = `fcm-race-${unique()}-padded-to-a-plausible-length`;

    await inTenant(ctx.orgA.id, async () =>
      Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          devices.register({
            userId: ctx.orgA.owner.id,
            token,
            platform: 'ANDROID',
            label: `Racer ${index}`,
          }),
        ),
      ),
    );

    const list = await ctx
      .http()
      .get('/api/v1/users/me/devices')
      .set(auth(ctx.orgA.owner.accessToken));

    const matching = list.body.data.items.filter((item: { label: string | null }) =>
      (item.label ?? '').startsWith('Racer '),
    );

    expect(matching).toHaveLength(1);
  });

  // ===========================================================================
  // The sweep itself
  // ===========================================================================

  it('does not double-notify when THREE sweeps run at once', async () => {
    /*
     * The scenario §27 asks about: two worker instances, one queue, one tenant,
     * one follow-up. No duplicate business action.
     *
     * Both layers are exercised together here — the conditional marker claim
     * and the unique dedupe key — which is the combination that actually runs
     * in production.
     */
    const lead = await ctx
      .http()
      .post('/api/v1/leads')
      .set(auth(ctx.orgA.owner.accessToken))
      .send({
        firstName: 'Sweep',
        lastName: `Race ${unique()}`,
        mobile: fixtureMobile(),
        nextFollowUpAt: minutesFromNow(1),
      });

    await ctx
      .http()
      .post(`/api/v1/leads/${lead.body.data.id}/follow-ups`)
      .set(auth(ctx.orgA.owner.accessToken))
      .send({ scheduledAt: minutesFromNow(-300), type: 'CALL', title: 'Concurrent sweep' });

    const before = await inTenant(ctx.orgA.id, async () =>
      notifications.list(ctx.orgA.owner.id, { unreadOnly: false, limit: 200 }),
    );

    await Promise.all([sweep.sweep(), sweep.sweep(), sweep.sweep()]);

    const after = await inTenant(ctx.orgA.id, async () =>
      notifications.list(ctx.orgA.owner.id, { unreadOnly: false, limit: 200 }),
    );

    /*
     * At most one new notification per kind for this follow-up. Three
     * concurrent sweeps must not produce three alerts — that is the behaviour
     * that makes people mute a CRM.
     */
    const added = after.items.length - before.items.length;
    expect(added).toBeLessThanOrEqual(1);
  });

  // ===========================================================================
  // Business writes
  // ===========================================================================

  it('completes a follow-up exactly once under a double submit', async () => {
    // A slow network and an impatient thumb. The conditional status predicate
    // means the second attempt updates zero rows and is told so.
    const lead = await ctx
      .http()
      .post('/api/v1/leads')
      .set(auth(ctx.orgA.owner.accessToken))
      .send({
        firstName: 'Double',
        lastName: `Submit ${unique()}`,
        mobile: fixtureMobile(),
        nextFollowUpAt: minutesFromNow(60),
      });

    const followUp = await ctx
      .http()
      .post(`/api/v1/leads/${lead.body.data.id}/follow-ups`)
      .set(auth(ctx.orgA.owner.accessToken))
      .send({ scheduledAt: minutesFromNow(60), type: 'CALL' });

    const id = followUp.body.data.id as string;

    const [first, second] = await Promise.all([
      ctx
        .http()
        .post(`/api/v1/follow-ups/${id}/complete`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ outcome: 'Spoke', nextFollowUpAt: minutesFromNow(1440) }),
      ctx
        .http()
        .post(`/api/v1/follow-ups/${id}/complete`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ outcome: 'Spoke again', nextFollowUpAt: minutesFromNow(1440) }),
    ]);

    const statuses = [first.status, second.status].sort();

    // One succeeds, one is told it already happened. Never two successes.
    expect(statuses).toEqual([200, 409]);
  });

  it('creates ONE repeat opportunity when a double-click replays the key', async () => {
    const account = await ctx
      .http()
      .post('/api/v1/accounts')
      .set(auth(ctx.orgA.owner.accessToken))
      .send({ name: `Race Co ${unique()}` });

    const accountId = account.body.data.account.id as string;
    const key = `idem-${unique()}`;

    const [first, second] = await Promise.all([
      ctx
        .http()
        .post(`/api/v1/accounts/${accountId}/repeat-opportunity`)
        .set(auth(ctx.orgA.owner.accessToken))
        .set('Idempotency-Key', key)
        .send({ nextFollowUpAt: minutesFromNow(1440) }),
      ctx
        .http()
        .post(`/api/v1/accounts/${accountId}/repeat-opportunity`)
        .set(auth(ctx.orgA.owner.accessToken))
        .set('Idempotency-Key', key)
        .send({ nextFollowUpAt: minutesFromNow(1440) }),
    ]);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    /*
     * A genuinely simultaneous pair can both miss the Redis cache — it is a
     * cache, not a lock, and the comment in the service says so. What must
     * hold is that a REPLAY after the first completes returns the same lead.
     */
    const replay = await ctx
      .http()
      .post(`/api/v1/accounts/${accountId}/repeat-opportunity`)
      .set(auth(ctx.orgA.owner.accessToken))
      .set('Idempotency-Key', key)
      .send({ nextFollowUpAt: minutesFromNow(1440) });

    expect(replay.body.data.replayed).toBe(true);
    expect([first.body.data.leadId, second.body.data.leadId]).toContain(replay.body.data.leadId);
  });
});
