import { Logger } from '@nestjs/common';
import { RedisThrottlerStorage } from './redis-throttler.storage';
import { CredentialThrottle, isCredentialEndpoint } from './credential-throttle.decorator';
import type { RedisService } from '../redis/redis.service';
import type { ExecutionContext } from '@nestjs/common';

/**
 * A MULTI chain that records what was queued and answers with a scripted
 * result, so each case can state exactly what Redis replied.
 */
function redisDouble(exec: () => Promise<unknown>) {
  const queued: unknown[][] = [];

  const chain = {
    incr: (key: string) => {
      queued.push(['incr', key]);
      return chain;
    },
    pexpire: (key: string, ms: number, mode?: string) => {
      queued.push(['pexpire', key, ms, mode]);
      return chain;
    },
    pttl: (key: string) => {
      queued.push(['pttl', key]);
      return chain;
    },
    exec,
  };

  const redis = { client: { multi: () => chain } } as unknown as RedisService;

  return { redis, queued };
}

const reply = (hits: number, pttl: number) =>
  Promise.resolve([
    [null, hits],
    [null, 1],
    [null, pttl],
  ]);

describe('RedisThrottlerStorage', () => {
  beforeEach(() => {
    // The fail-open path logs at error level on purpose; keep the suite output
    // about failures that matter.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('counts in one atomic round trip, namespaced by policy', async () => {
    const { redis, queued } = redisDouble(() => reply(1, 60_000));
    const storage = new RedisThrottlerStorage(redis);

    const record = await storage.increment('abc123', 60_000, 5, 60_000, 'credential');

    expect(queued).toEqual([
      ['incr', 'leadflow:ratelimit:credential:abc123'],
      // NX, so the window stays anchored to the first request in it rather
      // than sliding forward with every later one — which would let a steady
      // stream of traffic hold a bucket open indefinitely.
      ['pexpire', 'leadflow:ratelimit:credential:abc123', 60_000, 'NX'],
      ['pttl', 'leadflow:ratelimit:credential:abc123'],
    ]);
    expect(record).toEqual({
      totalHits: 1,
      timeToExpire: 60,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  });

  it('keeps each policy in its own key', async () => {
    const { redis, queued } = redisDouble(() => reply(1, 1_000));
    const storage = new RedisThrottlerStorage(redis);

    await storage.increment('same-key', 1_000, 5, 1_000, 'default');
    await storage.increment('same-key', 1_000, 5, 1_000, 'credential');

    expect(queued[0]).toEqual(['incr', 'leadflow:ratelimit:default:same-key']);
    expect(queued[3]).toEqual(['incr', 'leadflow:ratelimit:credential:same-key']);
  });

  it('blocks only past the limit, and says how long for', async () => {
    const atLimit = redisDouble(() => reply(5, 30_000));
    expect(
      await new RedisThrottlerStorage(atLimit.redis).increment('k', 60_000, 5, 60_000, 'credential'),
    ).toMatchObject({ isBlocked: false, timeToBlockExpire: 0 });

    const overLimit = redisDouble(() => reply(6, 30_000));
    expect(
      await new RedisThrottlerStorage(overLimit.redis).increment(
        'k',
        60_000,
        5,
        90_000,
        'credential',
      ),
    ).toMatchObject({ isBlocked: true, timeToBlockExpire: 90 });
  });

  it('reports a sane window when the key has no TTL or has vanished', async () => {
    // -1 (no expiry set) and -2 (key gone between commands) are both real
    // Redis answers; either would otherwise become a negative Retry-After.
    for (const pttl of [-1, -2]) {
      const { redis } = redisDouble(() => reply(1, pttl));
      const record = await new RedisThrottlerStorage(redis).increment(
        'k',
        45_000,
        5,
        45_000,
        'default',
      );

      expect(record.timeToExpire).toBe(45);
    }
  });

  it('fails open, loudly, when Redis is unreachable — and never into memory', async () => {
    const error = jest.spyOn(Logger.prototype, 'error');
    const { redis } = redisDouble(() => Promise.reject(new Error('ECONNREFUSED')));
    const storage = new RedisThrottlerStorage(redis);

    const first = await storage.increment('k', 60_000, 5, 60_000, 'credential');
    expect(first).toEqual({
      totalHits: 0,
      timeToExpire: 60,
      isBlocked: false,
      timeToBlockExpire: 0,
    });

    /*
     * Ten more requests during the outage still report zero hits. A
     * process-local fallback would count them, which is precisely the
     * multi-replica bug this storage exists to remove: three replicas each
     * enforcing their own copy of the limit is three times the published one.
     * An unthrottled window that is visible in the log is the deliberate
     * trade.
     */
    for (let i = 0; i < 10; i += 1) {
      expect((await storage.increment('k', 60_000, 5, 60_000, 'credential')).totalHits).toBe(0);
    }

    // Logged once for the outage, not once per request.
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('announces recovery once Redis answers again', async () => {
    const log = jest.spyOn(Logger.prototype, 'log');
    let failing = true;

    const { redis } = redisDouble(() =>
      failing ? Promise.reject(new Error('ECONNREFUSED')) : reply(1, 60_000),
    );
    const storage = new RedisThrottlerStorage(redis);

    await storage.increment('k', 60_000, 5, 60_000, 'default');
    failing = false;

    const recovered = await storage.increment('k', 60_000, 5, 60_000, 'default');

    expect(recovered.totalHits).toBe(1);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('treats an empty transaction result as a failure rather than zero hits', async () => {
    // ioredis returns null from exec() when the transaction was discarded.
    const { redis } = redisDouble(() => Promise.resolve(null));

    const record = await new RedisThrottlerStorage(redis).increment(
      'k',
      60_000,
      5,
      60_000,
      'credential',
    );

    expect(record.isBlocked).toBe(false);
    expect(Logger.prototype.error).toHaveBeenCalled();
  });
});

describe('isCredentialEndpoint', () => {
  class Marked {
    @CredentialThrottle()
    login(): void {}

    refresh(): void {}
  }

  @CredentialThrottle()
  class MarkedController {
    anything(): void {}
  }

  class Ordinary {
    list(): void {}
  }

  const contextFor = (target: object, method: string): ExecutionContext =>
    ({
      getHandler: () => (target as Record<string, unknown>)[method],
      getClass: () => target.constructor ?? target,
    }) as unknown as ExecutionContext;

  it('recognises a marked handler', () => {
    expect(isCredentialEndpoint(contextFor(Marked.prototype, 'login'))).toBe(true);
  });

  it('recognises a marked controller', () => {
    const context = {
      getHandler: () => MarkedController.prototype.anything,
      getClass: () => MarkedController,
    } as unknown as ExecutionContext;

    expect(isCredentialEndpoint(context)).toBe(true);
  });

  it('treats everything else as ordinary traffic', () => {
    // Opt in, never opt out: refresh sits on a marked controller's neighbour
    // and must stay outside the credential policy, or a background tab
    // rotating tokens spends a user's login budget.
    expect(isCredentialEndpoint(contextFor(Marked.prototype, 'refresh'))).toBe(false);
    expect(isCredentialEndpoint(contextFor(Ordinary.prototype, 'list'))).toBe(false);
  });
});
