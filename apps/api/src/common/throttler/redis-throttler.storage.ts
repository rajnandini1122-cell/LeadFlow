import { Injectable, Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { RedisService } from '../redis/redis.service';

/**
 * Rate-limit counters in Redis, so every API replica sees the same numbers.
 *
 * The default storage that ships with @nestjs/throttler keeps its counters in
 * process memory. With one replica that is invisible; with three it silently
 * triples every published limit, because each process enforces its own third
 * of the traffic. Redis is already a required dependency here — sessions, the
 * token deny-list and the queue all depend on it — so this reuses that
 * connection rather than introducing anything new.
 *
 * Keys are namespaced by policy so two limiters can never share a counter:
 *
 *   leadflow:ratelimit:<policy>:<hash>
 *
 * The hash comes from the throttler itself and already mixes the controller,
 * the handler and the caller's identity. Nothing sensitive is stored: no
 * token, header or email ever becomes part of a key.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  /** Set once per outage so a Redis failure cannot flood the log. */
  private degraded = false;

  constructor(private readonly redis: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const redisKey = `leadflow:ratelimit:${throttlerName}:${key}`;

    try {
      /*
       * One round trip, and atomic.
       *
       * INCR creates the key at 1 if it is absent, so there is no
       * read-then-write window for two replicas to fall into. PEXPIRE ... NX
       * attaches the window only to a key that does not already have one,
       * which keeps the window anchored to the FIRST request in it rather
       * than sliding forward with every later one.
       */
      const result = await this.redis.client
        .multi()
        .incr(redisKey)
        .pexpire(redisKey, ttl, 'NX')
        .pttl(redisKey)
        .exec();

      if (!result) throw new Error('Redis returned no result for the rate-limit transaction');

      const totalHits = Number(result[0]?.[1] ?? 0);
      const millisecondsLeft = Number(result[2]?.[1] ?? ttl);

      // A key with no expiry (-1) or one that vanished between commands (-2)
      // would otherwise report a nonsensical window.
      const timeToExpire = Math.ceil((millisecondsLeft > 0 ? millisecondsLeft : ttl) / 1000);
      const isBlocked = totalHits > limit;

      if (this.degraded) {
        this.degraded = false;
        this.logger.log('Redis is answering again — rate limits are shared across replicas');
      }

      return {
        totalHits,
        timeToExpire,
        isBlocked,
        timeToBlockExpire: isBlocked ? Math.max(timeToExpire, Math.ceil(blockDuration / 1000)) : 0,
      };
    } catch (error) {
      /*
       * Fail OPEN, loudly, and never into memory.
       *
       * The alternatives are worse. Falling back to a per-process counter is
       * how the multi-replica bug returns, quietly and only under load.
       * Failing closed would turn a Redis blip into a total outage of an API
       * that otherwise degrades gracefully — the membership cache already
       * falls back to Postgres and the token deny-list already fails open, so
       * this matches the architecture rather than contradicting it.
       *
       * The trade is an unthrottled window for as long as Redis is down,
       * which is visible in the log and on /readiness rather than silent.
       */
      if (!this.degraded) {
        this.degraded = true;
        this.logger.error(
          { throttler: throttlerName, err: error },
          'Rate-limit storage is unreachable — requests are passing UNTHROTTLED until Redis returns',
        );
      }

      return {
        totalHits: 0,
        timeToExpire: Math.ceil(ttl / 1000),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }
}
