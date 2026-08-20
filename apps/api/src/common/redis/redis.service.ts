import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfig } from '../config/config.module';

/**
 * Redis is used for three things in Phase 1:
 *   1. the access-token deny list, so logout is immediate rather than waiting
 *      out the 15-minute token TTL;
 *   2. the membership cache, so revoking a user takes effect in seconds
 *      without a database round trip on every request;
 *   3. (Phase 6) the BullMQ connection for the follow-up engine.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly url: string;
  readonly client: Redis;

  constructor(config: AppConfig) {
    this.url = config.get('REDIS_URL');

    this.client = new Redis(this.url, {
      maxRetriesPerRequest: 1,
      lazyConnect: false,
      // MUST be false. With the offline queue enabled, commands issued while
      // Redis is unreachable are QUEUED rather than rejected, so every caller
      // below would hang instead of falling back — turning a cache outage into
      // an API outage. Failing fast is what makes the graceful degradation in
      // MembershipCacheService and TokenService actually work.
      enableOfflineQueue: false,
      commandTimeout: 1000,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
    });

    this.client.on('error', (error) => {
      // Logged, not thrown: Redis being briefly unavailable must degrade
      // gracefully rather than take the API down. Callers treat a Redis miss
      // as "not cached", never as "not authorised".
      this.logger.error(`Redis error: ${error.message}`);
    });
  }

  /**
   * A dedicated connection for BullMQ (Phase 6).
   *
   * BullMQ requires `maxRetriesPerRequest: null` and its own offline queue
   * semantics, which are the opposite of what the cache connection above wants.
   * Sharing one client would force one of the two to misbehave, so queues get
   * their own.
   */
  createQueueConnection(): Redis {
    return new Redis(this.url, {
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async getJson<T>(key: string): Promise<T | null> {
    try {
      const value = await this.client.get(key);
      return value ? (JSON.parse(value) as T) : null;
    } catch {
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (error) {
      this.logger.warn(`Failed to cache ${key}: ${(error as Error).message}`);
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.client.del(...keys);
    } catch (error) {
      this.logger.warn(`Failed to delete keys: ${(error as Error).message}`);
    }
  }
}
