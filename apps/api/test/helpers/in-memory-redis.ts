import type { RedisService } from '../../src/common/redis/redis.service';

/**
 * In-memory stand-in for RedisService.
 *
 * Redis is used in Phase 1 only as a cache and a deny list — plain key/value
 * with TTL. Faking that faithfully is a few lines, and it keeps the e2e suite
 * runnable on a machine with no Redis. CI runs the same suite against a real
 * Redis via Testcontainers, which is where genuine client behaviour (pipelining,
 * reconnects, eviction) gets exercised.
 */
export class InMemoryRedis {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();

  private read(key: string): string | null {
    const entry = this.store.get(key);
    if (!entry) return null;

    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  readonly client = {
    get: async (key: string): Promise<string | null> => this.read(key),

    set: async (key: string, value: string, _mode: string, ttl: number): Promise<'OK'> => {
      this.store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
      return 'OK';
    },

    exists: async (key: string): Promise<number> => (this.read(key) !== null ? 1 : 0),

    del: async (...keys: string[]): Promise<number> => {
      let removed = 0;
      for (const key of keys) if (this.store.delete(key)) removed += 1;
      return removed;
    },

    ping: async (): Promise<string> => 'PONG',
    quit: async (): Promise<'OK'> => 'OK',
    on: (): void => {},
  };

  async ping(): Promise<boolean> {
    return true;
  }

  async getJson<T>(key: string): Promise<T | null> {
    const value = this.read(key);
    return value ? (JSON.parse(value) as T) : null;
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    this.store.set(key, {
      value: JSON.stringify(value),
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async del(...keys: string[]): Promise<void> {
    for (const key of keys) this.store.delete(key);
  }

  async onModuleDestroy(): Promise<void> {
    this.store.clear();
  }

  /** Lets a test simulate cache expiry without waiting for the TTL. */
  flush(): void {
    this.store.clear();
  }
}

export const asRedisService = (fake: InMemoryRedis): RedisService =>
  fake as unknown as RedisService;
