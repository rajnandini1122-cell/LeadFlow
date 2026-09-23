import { Logger } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import {
  HEARTBEAT_INTERVAL_SECONDS,
  HEARTBEAT_KEY,
  HEARTBEAT_STALE_AFTER_SECONDS,
  HEARTBEAT_TTL_SECONDS,
  WorkerHeartbeatService,
  type WorkerHeartbeat,
} from './worker-heartbeat.service';

/**
 * The worker's pulse.
 *
 * The worker binds no port and fails silently — a dead sweep produces no
 * error, no log and no failed request, and the first evidence is a customer
 * nobody called. These tests cover the states an operator has to be able to
 * tell apart, and the one that must never happen: a green report from a
 * process that is gone.
 */
describe('WorkerHeartbeatService', () => {
  /**
   * A Redis stand-in that honours TTL, because TTL IS the crash behaviour.
   *
   * Expiry is what makes a dead worker report as dead without anything having
   * to notice the death. A double that ignored `ttlSeconds` would let every
   * test below pass while the real failure — a heartbeat that outlives its
   * writer — went uncovered.
   */
  class FakeRedis {
    private store = new Map<string, { value: string; expiresAt: number }>();
    now = Date.now();
    failing = false;

    async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
      if (this.failing) throw new Error('redis down');
      this.store.set(key, { value: JSON.stringify(value), expiresAt: this.now + ttlSeconds * 1000 });
    }

    async getJson<T>(key: string): Promise<T | null> {
      if (this.failing) throw new Error('redis down');

      const entry = this.store.get(key);
      if (!entry) return null;

      if (entry.expiresAt <= this.now) {
        this.store.delete(key);
        return null;
      }

      return JSON.parse(entry.value) as T;
    }

    /** What a caller would see in Redis, ignoring expiry. */
    raw(key: string) {
      return this.store.get(key);
    }
  }

  const build = (workerEnabled: boolean) => {
    const redis = new FakeRedis();
    const metrics = new MetricsService();
    const config = { get: (key: string) => (key === 'WORKER_ENABLED' ? workerEnabled : undefined) };

    const service = new WorkerHeartbeatService(
      config as never,
      redis as never,
      metrics as never,
    );

    return { service, redis, metrics };
  };

  beforeAll(() => {
    // The service logs a line per boot and warns on a failed write, both of
    // which are correct in production and pure noise in a suite that boots it
    // a dozen times and fails Redis on purpose.
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('writing (the worker process)', () => {
    it('writes a heartbeat as soon as it boots', async () => {
      jest.useFakeTimers();
      const { service, redis } = build(true);

      await service.onApplicationBootstrap();

      /*
       * Immediately, not after one interval.
       *
       * A worker that waited 30 seconds to say anything would be
       * indistinguishable from a dead one for those 30 seconds — every deploy
       * would trip the alarm it is supposed to prove is quiet.
       */
      const beat = await redis.getJson<WorkerHeartbeat>(HEARTBEAT_KEY);
      expect(beat).not.toBeNull();
      expect(beat!.workerId).toHaveLength(36);

      service.onModuleDestroy();
    });

    it('writes with a TTL of three intervals', async () => {
      jest.useFakeTimers();
      const { service, redis } = build(true);

      await service.onApplicationBootstrap();

      const stored = redis.raw(HEARTBEAT_KEY);
      expect(stored!.expiresAt - redis.now).toBe(HEARTBEAT_TTL_SECONDS * 1000);
      // The TTL must outlive the write interval, or a healthy worker would
      // flicker to MISSING between two perfectly ordinary beats.
      expect(HEARTBEAT_TTL_SECONDS).toBeGreaterThan(HEARTBEAT_INTERVAL_SECONDS);

      service.onModuleDestroy();
    });

    it('does not beat in an API process', async () => {
      const { service, redis } = build(false);

      await service.onApplicationBootstrap();

      /*
       * The single most important assertion here. If an API replica wrote the
       * key, a deployment whose worker never started would report a healthy
       * worker — the exact false green this whole mechanism exists to remove.
       */
      expect(await redis.getJson(HEARTBEAT_KEY)).toBeNull();
    });

    it('survives a Redis outage without taking the worker down', async () => {
      jest.useFakeTimers();
      const { service, redis } = build(true);
      redis.failing = true;

      // The heartbeat observes the work; it is not a precondition for doing
      // it. A worker that died because it could not report would be worse
      // than one that is briefly unobservable.
      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();

      service.onModuleDestroy();
    });
  });

  describe('reading (the API process)', () => {
    it('reads a heartbeat the WORKER wrote', async () => {
      jest.useFakeTimers();
      const worker = build(true);
      await worker.service.onApplicationBootstrap();
      worker.service.onModuleDestroy();

      /*
       * The point of the whole design: a DIFFERENT process, with its own
       * memory, answering a question about the worker. An API instance shares
       * nothing with the worker except Redis.
       */
      const api = new WorkerHeartbeatService(
        { get: () => false } as never,
        worker.redis as never,
        new MetricsService() as never,
      );

      const health = await api.read();

      expect(health.status).toBe('HEALTHY');
      expect(health.workerId).toBeTruthy();
      expect(health.ageSeconds).toBe(0);
    });

    it('reports HEALTHY for a fresh beat', async () => {
      jest.useFakeTimers();
      const { service, redis } = build(true);
      await service.onApplicationBootstrap();
      service.onModuleDestroy();

      const health = await service.read(new Date(redis.now + 5_000));

      expect(health.status).toBe('HEALTHY');
      expect(health.ageSeconds).toBe(5);
    });

    it('reports STALE when a beat stops advancing but has not expired', async () => {
      jest.useFakeTimers();
      const { service, redis } = build(true);
      await service.onApplicationBootstrap();
      service.onModuleDestroy();

      /*
       * A worker that is running and wedged, rather than gone. The key is
       * still there — the TTL has not collected it — but nothing is refreshing
       * it. Worth telling apart from MISSING: "stopped beating" and "not
       * there at all" lead an operator to different first questions.
       */
      const justStale = (HEARTBEAT_STALE_AFTER_SECONDS + 1) * 1000;
      const health = await service.read(new Date(redis.now + justStale));

      expect(health.status).toBe('STALE');
      expect(health.beatAt).not.toBeNull();
    });

    it('reports MISSING once the TTL expires — a crashed worker', async () => {
      jest.useFakeTimers();
      const { service, redis } = build(true);
      await service.onApplicationBootstrap();
      service.onModuleDestroy();

      /*
       * The crash path, and the reason Redis rather than a table. Nothing has
       * to observe the death or write a tombstone: the worker simply stops
       * refreshing and the key evaporates on its own.
       */
      redis.now += (HEARTBEAT_TTL_SECONDS + 1) * 1000;

      const health = await service.read(new Date(redis.now));

      expect(health.status).toBe('MISSING');
      expect(health.beatAt).toBeNull();
      expect(health.workerId).toBeNull();
    });

    it('reports MISSING when no worker has ever run', async () => {
      const { service } = build(false);

      expect((await service.read()).status).toBe('MISSING');
    });

    it('reports UNKNOWN rather than MISSING when Redis itself is unreachable', async () => {
      const { service, redis } = build(false);
      redis.failing = true;

      // "We cannot see" is not "the worker is dead". Readiness already fails
      // on Redis; blaming the worker would send somebody to the wrong process.
      expect((await service.read()).status).toBe('UNKNOWN');
    });

    it('carries the last sweep across the process boundary', async () => {
      jest.useFakeTimers();
      const { service, redis, metrics } = build(true);

      metrics.recordSweep({ failures: 0 });
      await service.onApplicationBootstrap();
      service.onModuleDestroy();

      const beat = await redis.getJson<WorkerHeartbeat>(HEARTBEAT_KEY);
      expect(beat!.lastSweepAt).not.toBeNull();

      const health = await service.read();
      expect(health.lastSweepAt).toBe(beat!.lastSweepAt);
    });

    it('is healthy but sweepless for a worker that has just started', async () => {
      jest.useFakeTimers();
      const { service } = build(true);

      await service.onApplicationBootstrap();
      service.onModuleDestroy();

      // Up, reachable, and has not completed a sweep yet — a real state, and
      // not the same as a dead worker.
      const health = await service.read();
      expect(health.status).toBe('HEALTHY');
      expect(health.lastSweepAt).toBeNull();
    });
  });
});
