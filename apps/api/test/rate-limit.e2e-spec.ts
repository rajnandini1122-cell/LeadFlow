// MUST be first. It installs the suite's limits into process.env, and
// @nestjs/config reads process.env when AppModule's config module is imported
// — which the next line does. See the file for why.
import {
  CREDENTIAL_LIMIT,
  CREDENTIAL_TTL_SECONDS,
  GENERAL_LIMIT,
} from './helpers/throttle-limits';
import type { Express } from 'express';
import { connect } from 'node:net';
import Redis from 'ioredis';
import { createTestContext, PASSWORD, type TestContext } from './helpers/test-app';
import { RedisThrottlerStorage } from '../src/common/throttler/redis-throttler.storage';
import type { RedisService } from '../src/common/redis/redis.service';

/**
 * Rate limiting, by policy.
 *
 * This suite exists because the defect it covers was invisible to every other
 * one: @nestjs/throttler applies each named limiter to EVERY route unless that
 * name is skipped, so the credential policy — a handful of attempts per IP per
 * fifteen minutes — also governed CRM reads, token refresh and Meta's webhook
 * deliveries. A sales office behind one address shared five requests between
 * everyone in it, and provider deliveries were throttled into redelivery
 * loops.
 *
 * The assertions are therefore about the BOUNDARIES between policies, not the
 * numbers inside them. Counters live in Redis (an in-memory double locally, a
 * real redis:8 in CI), so emptying it between cases is a complete reset and no
 * result depends on what ran before it.
 */
/**
 * Is there a Redis to talk to?
 *
 * A bare socket, opened and closed by hand, rather than letting a client
 * discover it: a Redis client that fails to connect keeps retry state behind
 * it, and this suite must leave nothing running when it finishes.
 */
async function redisIsReachable(): Promise<boolean> {
  const url = new URL(process.env['REDIS_URL'] as string);

  return new Promise((resolve) => {
    const socket = connect({ host: url.hostname, port: Number(url.port || 6379), timeout: 1000 });

    const settle = (reachable: boolean): void => {
      socket.destroy();
      resolve(reachable);
    };

    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.once('timeout', () => settle(false));
  });
}

describe('Rate limiting', () => {
  let ctx: TestContext;

  /** The Express instance underneath Nest, for reading and setting trust proxy. */
  const express = (): Express => ctx.app.getHttpAdapter().getInstance() as Express;

  const badLogin = (headers: Record<string, string> = {}) => {
    const attempt = ctx
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.test', password: 'not-the-password', platform: 'WEB' });

    for (const [name, value] of Object.entries(headers)) attempt.set(name, value);
    return attempt;
  };

  /** Spends a caller's credential allowance, and one request beyond it. */
  const exhaustCredentials = async (headers: Record<string, string> = {}): Promise<void> => {
    for (let attempt = 0; attempt <= CREDENTIAL_LIMIT; attempt += 1) await badLogin(headers);
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    // The fixture signed four seeded users in from this same address. Start
    // every case from an untouched bucket.
    ctx.redis.flush();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(() => {
    ctx.redis.flush();
  });

  describe('the credential policy', () => {
    it('allows the configured attempts, then refuses', async () => {
      const statuses: number[] = [];

      for (let attempt = 0; attempt < CREDENTIAL_LIMIT + 2; attempt += 1) {
        statuses.push((await badLogin()).status);
      }

      // Wrong credentials answer 401 until the allowance is spent.
      expect(statuses).toEqual([
        ...Array.from({ length: CREDENTIAL_LIMIT }, () => 401),
        429,
        429,
      ]);
    });

    it('refuses with 429 and a Retry-After, never a 500', async () => {
      await exhaustCredentials();

      const blocked = await badLogin();

      expect(blocked.status).toBe(429);
      // A named throttler suffixes its headers, so this is the credential
      // policy answering and not the general one.
      expect(blocked.headers['retry-after-credential']).toBeDefined();
      expect(blocked.body).toMatchObject({ success: false });
      // Nothing about the limiter's internals reaches the caller.
      expect(JSON.stringify(blocked.body)).not.toContain('leadflow:ratelimit');
    });

    it('lets the caller back in once the window has passed', async () => {
      await exhaustCredentials();
      expect((await badLogin()).status).toBe(429);

      await new Promise((resolve) => setTimeout(resolve, CREDENTIAL_TTL_SECONDS * 1000 + 250));

      expect((await badLogin()).status).toBe(401);
    });
  });

  describe('policies do not leak into one another', () => {
    it('leaves ordinary CRM traffic alone', async () => {
      await exhaustCredentials();

      // The same caller, immediately, on a business route.
      const leads = await ctx
        .http()
        .get('/api/v1/leads')
        .set('Authorization', `Bearer ${ctx.orgA.rep.accessToken}`);

      expect(leads.status).toBe(200);
    });

    it('leaves provider webhooks alone', async () => {
      await exhaustCredentials();

      const delivery = await ctx
        .http()
        .post('/api/v1/webhooks/whatsapp')
        .set('x-hub-signature-256', 'sha256=0000')
        .send({ object: 'whatsapp_business_account', entry: [] });

      // Refused for the reason it should be — the signature is nonsense — and
      // not because somebody mistyped a password four times.
      expect(delivery.status).toBe(403);
    });

    it('leaves token refresh alone', async () => {
      const login = await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email: ctx.orgB.rep.email, password: PASSWORD, platform: 'ANDROID' })
        .expect(200);

      await exhaustCredentials();

      // Several tabs rotating tokens must never spend a team's login budget.
      const refreshed = await ctx
        .http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: login.body.data.tokens.refreshToken as string });

      expect(refreshed.status).toBe(200);
    });

    it('counts the two policies in separate buckets', async () => {
      // A credential endpoint is governed by both policies, and says so.
      const credential = await badLogin();
      expect(credential.headers['x-ratelimit-limit-credential']).toBe(String(CREDENTIAL_LIMIT));
      expect(credential.headers['x-ratelimit-limit']).toBe(String(GENERAL_LIMIT));

      // A public, non-credential route is governed by the general policy only.
      const plans = await ctx.http().get('/api/v1/plans');
      expect(plans.status).toBe(200);
      expect(plans.headers['x-ratelimit-limit']).toBe(String(GENERAL_LIMIT));
      expect(plans.headers['x-ratelimit-limit-credential']).toBeUndefined();

      // And spending the credential allowance leaves the general one alone.
      await exhaustCredentials();
      const afterBlock = await ctx.http().get('/api/v1/plans');
      expect(afterBlock.status).toBe(200);
      expect(Number(afterBlock.headers['x-ratelimit-remaining'])).toBeGreaterThan(
        GENERAL_LIMIT - 10,
      );
    });
  });

  describe('who the caller is', () => {
    it('ignores X-Forwarded-For when no proxy is trusted', async () => {
      // The value came from configuration at boot, exactly as in main.ts.
      expect(express().get('trust proxy')).toBe(0);

      await exhaustCredentials();

      /*
       * With nothing trusted, X-Forwarded-For is just a string a stranger sent
       * and req.ip stays the socket address. Were it honoured here, one header
       * would buy an attacker an unlimited supply of fresh credential buckets
       * and the limit would mean nothing at all.
       */
      expect((await badLogin({ 'X-Forwarded-For': '203.0.113.7' })).status).toBe(429);
      expect((await badLogin({ 'X-Forwarded-For': '198.51.100.99' })).status).toBe(429);
    });

    it('separates clients when exactly one proxy is trusted', async () => {
      // The deployment shape LeadFlow ships in: one load balancer in front,
      // TRUST_PROXY_HOPS=1, so the address it appends is the real client.
      express().set('trust proxy', 1);

      const attempt = (clientIp: string) => badLogin({ 'X-Forwarded-For': clientIp });
      const guessing = '198.51.100.10';
      const innocent = '198.51.100.11';

      try {
        await exhaustCredentials({ 'X-Forwarded-For': guessing });
        expect((await attempt(guessing)).status).toBe(429);

        // The customer at the next desk is a different caller, and unaffected:
        // this is the half of the fix that keeps a shared office IP from
        // locking out a whole team.
        expect((await attempt(innocent)).status).toBe(401);
      } finally {
        express().set('trust proxy', 0);
      }
    });
  });

  describe('shared storage', () => {
    /**
     * The one claim an in-process double cannot support.
     *
     * Two fakes sharing a Map say nothing about two API replicas sharing a
     * count, so this case talks to a real Redis: CI runs it against redis:8,
     * and a development machine without one skips it rather than pretending.
     */
    it('counts one bucket across independent instances', async () => {
      if (!(await redisIsReachable())) {
        console.warn('shared-storage case skipped: no reachable Redis at REDIS_URL');
        return;
      }

      const client = new Redis(process.env['REDIS_URL'] as string, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        commandTimeout: 1000,
        // No reconnect timer: this client belongs to one test and must not
        // outlive it.
        retryStrategy: () => null,
      });

      const second = client.duplicate();
      const replicaA = new RedisThrottlerStorage({ client } as unknown as RedisService);
      const replicaB = new RedisThrottlerStorage({ client: second } as unknown as RedisService);

      // Unique per run, so a re-run never inherits a previous count.
      const key = `e2e-${Date.now()}-${Math.round(Math.random() * 1e9)}`;

      try {
        const first = await replicaA.increment(key, 5_000, 3, 5_000, 'credential');
        const next = await replicaB.increment(key, 5_000, 3, 5_000, 'credential');

        expect(first.totalHits).toBe(1);
        // The second replica continues the first one's count instead of
        // starting its own — the entire point of moving these counters out of
        // process memory, where three replicas each enforced their own third
        // of every published limit.
        expect(next.totalHits).toBe(2);
        expect(next.isBlocked).toBe(false);
        expect(next.timeToExpire).toBeGreaterThan(0);

        await replicaA.increment(key, 5_000, 3, 5_000, 'credential');
        expect((await replicaB.increment(key, 5_000, 3, 5_000, 'credential')).isBlocked).toBe(true);

        // Same caller, different policy, different counter.
        expect((await replicaA.increment(key, 5_000, 3, 5_000, 'default')).totalHits).toBe(1);
      } finally {
        await client.del(
          `leadflow:ratelimit:credential:${key}`,
          `leadflow:ratelimit:default:${key}`,
        );
        await client.quit();
        await second.quit();
      }
    });
  });
});
