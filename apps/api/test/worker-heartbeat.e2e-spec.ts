import { createTestContext, type TestContext } from './helpers/test-app';
import { RedisService } from '../src/common/redis/redis.service';
import {
  HEARTBEAT_KEY,
  HEARTBEAT_STALE_AFTER_SECONDS,
  type WorkerHeartbeat,
} from '../src/common/observability/worker-heartbeat.service';

/**
 * Can the API tell whether the worker is alive?
 *
 * Through the real endpoint, over real HTTP, reading what a real worker would
 * have written — because the failure this closes was precisely that the two
 * processes could not see each other. The worker binds no port and dies
 * silently, so `/api/metrics` is the only place the answer can appear, and a
 * unit test of the service alone would not prove the endpoint reports it.
 */
describe('Worker heartbeat over /api/metrics', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await ctx.app.get(RedisService).del(HEARTBEAT_KEY);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const metrics = () =>
    ctx.http().get('/api/metrics').set({ Authorization: `Bearer ${ctx.orgA.owner.accessToken}` });

  /** Exactly what the worker process writes, written from outside it. */
  const writeHeartbeat = async (beatAt: Date, lastSweepAt: string | null = null) => {
    const beat: WorkerHeartbeat = {
      workerId: 'worker-under-test',
      startedAt: new Date(beatAt.getTime() - 60_000).toISOString(),
      beatAt: beatAt.toISOString(),
      lastSweepAt,
    };

    await ctx.app.get(RedisService).setJson(HEARTBEAT_KEY, beat, 300);
  };

  it('reports MISSING when no worker has ever run', async () => {
    const response = await metrics().expect(200);

    /*
     * The honest answer for a deployment whose worker was never started, and
     * the one that must never be mistaken for healthy. Nobody is sweeping, so
     * nobody is being reminded of anything.
     */
    expect(response.body.workerProcess).toMatchObject({
      status: 'MISSING',
      workerId: null,
      beatAt: null,
    });
  });

  it('reports HEALTHY from a heartbeat written by another process', async () => {
    await writeHeartbeat(new Date());

    const response = await metrics().expect(200);

    // The whole point: this API process wrote nothing. Redis carried it.
    expect(response.body.workerProcess).toMatchObject({
      status: 'HEALTHY',
      workerId: 'worker-under-test',
    });
    expect(response.body.workerProcess.ageSeconds).toBeLessThan(5);
  });

  it('carries the last sweep across the process boundary', async () => {
    const sweptAt = new Date(Date.now() - 30_000).toISOString();
    await writeHeartbeat(new Date(), sweptAt);

    const response = await metrics().expect(200);

    expect(response.body.workerProcess.lastSweepAt).toBe(sweptAt);
  });

  it('reports STALE when the heartbeat stops advancing', async () => {
    // Present but no longer moving — a worker that is up and wedged, which
    // looks different to an operator than one that is gone.
    await writeHeartbeat(new Date(Date.now() - (HEARTBEAT_STALE_AFTER_SECONDS + 10) * 1000));

    const response = await metrics().expect(200);

    expect(response.body.workerProcess.status).toBe('STALE');
    expect(response.body.workerProcess.ageSeconds).toBeGreaterThan(
      HEARTBEAT_STALE_AFTER_SECONDS,
    );
  });

  it('returns to MISSING once the key is gone, as a TTL expiry leaves it', async () => {
    await writeHeartbeat(new Date());
    expect((await metrics().expect(200)).body.workerProcess.status).toBe('HEALTHY');

    /*
     * What a crash actually looks like. The worker stops refreshing, Redis
     * collects the key on its own, and the report flips without anything
     * having had to notice the death — no tombstone, no cleanup job, and no
     * row left behind saying "healthy".
     */
    await ctx.app.get(RedisService).del(HEARTBEAT_KEY);

    expect((await metrics().expect(200)).body.workerProcess.status).toBe('MISSING');
  });

  describe('no regression to the rest of the endpoint', () => {
    it('still reports the existing metric blocks', async () => {
      const response = await metrics().expect(200);

      // The in-process blocks are unchanged and still present; the heartbeat
      // was added beside them, not in place of them.
      expect(response.body).toHaveProperty('api');
      expect(response.body).toHaveProperty('worker');
      expect(response.body).toHaveProperty('notifications');
      expect(response.body).toHaveProperty('database');
    });

    it('keeps the in-process worker block, which an API replica cannot fill', async () => {
      const response = await metrics().expect(200);

      /*
       * Left exactly as it was, and this is why it could never be the thing to
       * alert on: an API process has no sweeps of its own to report, so this
       * block reads empty whether the worker is thriving or dead.
       */
      expect(response.body.worker).toMatchObject({ sweeps: 0, failures: 0, lastSweepAt: null });
    });

    it('is still not public', async () => {
      await ctx.http().get('/api/metrics').expect(401);
    });

    it('still answers as bare JSON rather than the envelope', async () => {
      const response = await metrics().expect(200);

      // Consumed by infrastructure, which does not speak the success envelope.
      expect(response.body).not.toHaveProperty('success');
      expect(response.body).not.toHaveProperty('data');
    });
  });
});
