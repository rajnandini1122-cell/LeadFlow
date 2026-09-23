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

    /**
     * Enough of MULTI for the rate-limit storage, which issues exactly one
     * transaction: INCR, PEXPIRE ... NX, PTTL.
     *
     * Queued rather than executed immediately, and replayed in order on
     * exec(), so a test sees the same shape ioredis returns: one
     * `[error, result]` pair per queued command.
     */
    multi: () => {
      const queued: (() => [null, number])[] = [];

      const chain = {
        incr: (key: string) => {
          queued.push(() => [null, this.increment(key)]);
          return chain;
        },
        pexpire: (key: string, milliseconds: number, mode?: string) => {
          queued.push(() => [null, this.expire(key, milliseconds, mode)]);
          return chain;
        },
        pttl: (key: string) => {
          queued.push(() => [null, this.timeToLive(key)]);
          return chain;
        },
        exec: async (): Promise<[null, number][]> => queued.map((run) => run()),
      };

      return chain;
    },
  };

  /** INCR: creates the counter at 1, with no expiry of its own. */
  private increment(key: string): number {
    const current = Number(this.read(key) ?? 0) + 1;
    const existing = this.store.get(key);

    this.store.set(key, {
      value: String(current),
      expiresAt: existing && existing.expiresAt > Date.now() ? existing.expiresAt : Number.MAX_SAFE_INTEGER,
    });

    return current;
  }

  /** PEXPIRE with optional NX: only sets a window where none exists. */
  private expire(key: string, milliseconds: number, mode?: string): number {
    const entry = this.store.get(key);
    if (!entry) return 0;

    const hasWindow = entry.expiresAt !== Number.MAX_SAFE_INTEGER;
    if (mode === 'NX' && hasWindow) return 0;

    entry.expiresAt = Date.now() + milliseconds;
    return 1;
  }

  /** PTTL: milliseconds left, -1 without a window, -2 when absent. */
  private timeToLive(key: string): number {
    const entry = this.store.get(key);
    if (!entry) return -2;
    if (entry.expiresAt === Number.MAX_SAFE_INTEGER) return -1;

    const remaining = entry.expiresAt - Date.now();
    return remaining > 0 ? remaining : -2;
  }

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
