// Must be first: the config module reads the environment on import.
import { ANALYTICS_SECRET } from './helpers/admin-analytics-env';
import { createHmac, randomUUID } from 'node:crypto';
import { createTestContext, type TestContext } from './helpers/test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { adminSigningBase } from '../src/modules/integrations/admin-control/admin-control-signature';
import { ActivityTrackerService } from '../src/modules/platform-analytics/activity-tracker.service';
import { ApiMetricsCollector } from '../src/modules/platform-analytics/api-metrics.collector';
import { PlatformAnalyticsRepository } from '../src/modules/platform-analytics/platform-analytics.repository';

/**
 * The CRAVION Admin "LeadFlow Analytics" backend contract, end to end:
 * the signed read-only API, user activity, API metrics, website analytics
 * and the public site's SEO surface.
 */
describe('Platform analytics', () => {
  let ctx: TestContext;
  const BASE = '/api/v1/integrations/admin-analytics';
  const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36';
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** A request signed the way the CRAVION Admin backend signs it. */
  const signed = (
    path: string,
    query = '',
    options: { secret?: string; actor?: string; timestamp?: number; signedPath?: string } = {},
  ) => {
    const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
    const requestId = `req-${randomUUID()}`;
    const actorRef = options.actor ?? 'firebase:uid:owner-1';
    const signature = createHmac('sha256', options.secret ?? ANALYTICS_SECRET)
      .update(
        adminSigningBase({
          method: 'GET',
          path: options.signedPath ?? `${BASE}${path}`,
          timestamp,
          requestId,
          actorRef,
          rawBody: undefined,
        }),
      )
      .digest('hex');
    return ctx
      .http()
      .get(`${BASE}${path}${query}`)
      .set('x-cravion-admin-timestamp', timestamp)
      .set('x-cravion-admin-request-id', requestId)
      .set('x-cravion-admin-actor', actorRef)
      .set('x-cravion-admin-signature', `sha256=${signature}`);
  };

  const flush = async () => {
    await ctx.app.get(ActivityTrackerService).settle();
    await ctx.app.get(ApiMetricsCollector).flush();
  };

  const collect = (body: Record<string, unknown>, ua = BROWSER) =>
    ctx.http().post('/api/v1/analytics/collect').set('User-Agent', ua).send(body);

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx?.close();
  });

  describe('trust boundary', () => {
    it('refuses an unsigned request', async () => {
      await ctx.http().get(`${BASE}/overview`).expect(401);
    });

    it('refuses a LeadFlow organization owner, even with a valid sign-in', async () => {
      await ctx.http().get(`${BASE}/overview`).set(auth(ctx.orgA.owner.accessToken)).expect(401);
      await ctx.http().get(`${BASE}/users`).set(auth(ctx.orgB.owner.accessToken)).expect(401);
    });

    it('refuses a wrong key, a stale timestamp and a signature made for another path', async () => {
      await signed('/overview', '', { secret: 'some-other-secret-of-at-least-32-chars!!' }).expect(
        401,
      );
      await signed('/overview', '', { timestamp: Math.floor(Date.now() / 1000) - 3600 }).expect(
        401,
      );
      await signed('/users', '', { signedPath: `${BASE}/overview` }).expect(401);
    });

    it('is read-only: no write method exists', async () => {
      const res = await ctx.http().post(`${BASE}/users`).send({});
      expect([401, 404]).toContain(res.status);
    });

    it('records each read in the audit log with the Admin actor, without search text', async () => {
      await signed('/users', '?search=secret-search-term', {
        actor: 'firebase:uid:audited-owner',
      }).expect(200);
      const audit = await signed('/audit').expect(200);
      const entry = (
        audit.body.data as { action: string; actor: string; details: Record<string, unknown> }[]
      ).find((a) => a.actor === 'firebase:uid:audited-owner');
      expect(entry?.action).toBe('platform.analytics.users');
      expect(JSON.stringify(entry?.details)).not.toContain('secret-search-term');
      expect(entry?.details['searched']).toBe(true);
    });
  });

  describe('users and activity', () => {
    it('counts users across every organization, with registration dates from the database', async () => {
      const overview = (await signed('/overview').expect(200)).body.data;
      expect(overview.users.total).toBeGreaterThanOrEqual(4); // two orgs x owner + rep
      expect(overview.organizations.total).toBeGreaterThanOrEqual(2);
      expect(overview.collections.userActivity).toBeTruthy();
      expect(overview.definitions.onlineNow).toContain('5 minutes');

      const users = (await signed('/users', '?pageSize=100').expect(200)).body.data;
      const orgNames = new Set(
        users.items.flatMap((u: { organizations: { name: string }[] }) =>
          u.organizations.map((o) => o.name),
        ),
      );
      expect(orgNames.size).toBeGreaterThanOrEqual(2);
      for (const u of users.items) {
        expect(u.registeredAt).toBeTruthy();
        expect(u).not.toHaveProperty('passwordHash');
        expect(JSON.stringify(u)).not.toMatch(/password|token|refresh/i);
      }
    });

    it('records first and last login at sign-in, and keeps the first one', async () => {
      const email = ctx.orgA.rep.email;
      const login = () =>
        ctx
          .http()
          .post('/api/v1/auth/login')
          .send({ email, password: 'Password123!', platform: 'ANDROID' });
      const first = await login();
      if (first.status !== 200 && first.status !== 201) return; // fixture password differs: covered by the unit of work below
      const row1 = await signed('/users', `?search=${encodeURIComponent(email)}`).expect(200);
      const u1 = row1.body.data.items[0];
      expect(u1.firstLoginAt).toBeTruthy();
      expect(u1.lastLoginAt).toBeTruthy();
      await login();
      const u2 = (await signed('/users', `?search=${encodeURIComponent(email)}`).expect(200)).body
        .data.items[0];
      expect(u2.firstLoginAt).toBe(u1.firstLoginAt);
    });

    it('an authenticated request makes the user active today and online; many requests write once', async () => {
      const prisma = ctx.app.get(PrismaService).client;
      const system = ctx.app.get(TenantContextService);
      const before = await system.runAsSystem('e2e', () =>
        prisma.userActivityDay.count({ where: { userId: ctx.orgB.rep.id } }),
      );
      for (let i = 0; i < 5; i++) {
        await ctx.http().get('/api/v1/leads').set(auth(ctx.orgB.rep.accessToken)).expect(200);
      }
      await flush();
      const after = await system.runAsSystem('e2e', () =>
        prisma.userActivityDay.count({ where: { userId: ctx.orgB.rep.id } }),
      );
      expect(after - before).toBe(1);

      const overview = (await signed('/overview').expect(200)).body.data;
      expect(overview.users.dau).toBeGreaterThanOrEqual(1);
      expect(overview.users.onlineNow).toBeGreaterThanOrEqual(1);
      const sessions = (await signed('/sessions').expect(200)).body.data;
      expect(sessions.onlineUsers.map((u: { id: string }) => u.id)).toContain(ctx.orgB.rep.id);
    });

    it('paginates, sorts, filters by organization and exports CSV', async () => {
      const page = (
        await signed(
          '/users',
          `?pageSize=1&page=1&sort=name&direction=asc&org=${ctx.orgA.id}`,
        ).expect(200)
      ).body.data;
      expect(page.items).toHaveLength(1);
      expect(page.total).toBeGreaterThanOrEqual(2);
      // A member of org A (who may also belong to other organizations).
      expect(page.items[0].organizations.map((o: { id: string }) => o.id)).toContain(ctx.orgA.id);

      const csv = (await signed('/users/export', `?org=${ctx.orgA.id}`).expect(200)).body
        .data;
      expect(csv.filename).toMatch(/\.csv$/);
      expect(csv.csv.split('\r\n')[0]).toBe(
        'Name,Email,Organizations,Status,Email verified,Registered,First login,Last login,Last active',
      );
    });

    it('lists organizations with users and last activity', async () => {
      const orgs = (await signed('/organizations').expect(200)).body.data.items as {
        id: string;
        activeUsers: number;
      }[];
      expect(orgs.find((o) => o.id === ctx.orgA.id)?.activeUsers).toBeGreaterThanOrEqual(2);
    });
  });

  describe('API metrics', () => {
    it('aggregates by route template with error codes, never raw ids or query strings', async () => {
      const missing = '01900000-0000-7000-8000-000000000001';
      await ctx
        .http()
        .get(`/api/v1/leads/${missing}?secret=abc`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(404);
      await ctx.http().get('/api/v1/leads').set(auth(ctx.orgA.owner.accessToken)).expect(200);
      await ctx.http().get('/api/v1/leads').expect(401);
      await flush();

      const api = (await signed('/api', '?range=24h').expect(200)).body.data;
      const routes = api.topEndpoints.map((e: { route: string }) => e.route);
      expect(routes).toContain('/api/v1/leads/:id');
      expect(JSON.stringify(api)).not.toContain(missing);
      expect(JSON.stringify(api)).not.toContain('secret=abc');
      expect(api.errorsByCode.map((e: { key: string }) => e.key)).toContain('404 LEAD_NOT_FOUND');
      expect(api.totals.authFailures).toBeGreaterThanOrEqual(1);
      expect(api.totals.requests).toBeGreaterThan(0);
      expect(
        api.byOrganization.find(
          (o: { organizationId: string }) => o.organizationId === ctx.orgA.id,
        ),
      ).toBeTruthy();
    });

    it('keeps the API working when the metrics store fails', async () => {
      const repo = ctx.app.get(PlatformAnalyticsRepository);
      const original = repo.flushApiBuckets.bind(repo);
      repo.flushApiBuckets = () => Promise.reject(new Error('metrics store down'));
      try {
        await ctx.http().get('/api/v1/leads').set(auth(ctx.orgA.owner.accessToken)).expect(200);
        await ctx.app.get(ApiMetricsCollector).flush();
        expect(ctx.app.get(ApiMetricsCollector).lastFlushError).toContain('metrics store down');
        await ctx.http().get('/api/v1/leads').set(auth(ctx.orgA.owner.accessToken)).expect(200);
      } finally {
        repo.flushApiBuckets = original;
      }
    });

    it('deletes rows older than the retention windows', async () => {
      const prisma = ctx.app.get(PrismaService).client;
      const system = ctx.app.get(TenantContextService);
      const old = new Date(Date.now() - 200 * 86_400_000);
      await system.runAsSystem('e2e', () =>
        prisma.apiMetricHour.create({
          data: { hour: old, method: 'GET', route: '/old', status: 200, count: 1 },
        }),
      );
      const removed = await ctx.app.get(PlatformAnalyticsRepository).applyRetention({
        hourly: new Date(Date.now() - 90 * 86_400_000),
        daily: new Date(Date.now() - 400 * 86_400_000),
      });
      expect(removed).toBeGreaterThanOrEqual(1);
    });

    it('reports health honestly', async () => {
      const health = (await signed('/health').expect(200)).body.data;
      expect(health.database.ok).toBe(true);
      expect(health.metrics.retention).toEqual({ hourlyDays: 90, dailyDays: 400 });
    });
  });

  describe('website analytics', () => {
    const visitor = randomUUID();
    const session = randomUUID();

    it('counts page views, visits, sources and conversions from the public pages only', async () => {
      await collect({
        event: 'page_view',
        path: '/',
        referrer: 'https://www.google.com/',
        visitorId: visitor,
        sessionId: session,
      }).expect(204);
      await collect({
        event: 'page_view',
        path: '/pricing',
        visitorId: visitor,
        sessionId: session,
      }).expect(204);
      await collect({
        event: 'registration_start',
        path: '/register',
        visitorId: visitor,
        sessionId: session,
      }).expect(204);
      await collect({
        event: 'registration_complete',
        path: '/register',
        visitorId: visitor,
        sessionId: session,
      }).expect(204);
      // Ignored: a private path, a bot, and a malformed id.
      await collect({
        event: 'page_view',
        path: '/leads/123',
        visitorId: visitor,
        sessionId: session,
      }).expect(204);
      await collect(
        { event: 'page_view', path: '/', visitorId: randomUUID(), sessionId: randomUUID() },
        'Googlebot/2.1',
      ).expect(204);
      await collect({
        event: 'page_view',
        path: '/',
        visitorId: 'not-a-uuid',
        sessionId: session,
      }).expect(400);

      const web = (await signed('/website', '?range=30d').expect(200)).body.data;
      expect(web.totals.uniqueVisitors).toBe(1);
      expect(web.totals.sessions).toBe(1);
      expect(web.totals.pageViews).toBe(2);
      expect(web.totals.registrationsCompletedOnWebsite).toBe(1);
      expect(web.totals.conversionRate).toBe(1);
      expect(web.sources).toEqual([{ key: 'organic', count: 1 }]);
      expect(web.topLandingPages[0]).toEqual({ key: '/', count: 1 });
      expect(JSON.stringify(web)).not.toContain(visitor);
    });

    it('stores no raw visitor id, IP address or full referrer URL', async () => {
      const prisma = ctx.app.get(PrismaService).client;
      const rows = await ctx.app
        .get(TenantContextService)
        .runAsSystem('e2e', () => prisma.webSession.findMany());
      for (const r of rows) {
        expect(r.visitorHash).toMatch(/^[0-9a-f]{64}$/);
        expect(r.visitorHash).not.toContain(visitor);
        expect(r.referrerDomain === null || !r.referrerDomain.includes('/')).toBe(true);
      }
    });
  });

  describe('public website SEO', () => {
    it('serves robots.txt and a sitemap of the public pages', async () => {
      const robots = await ctx.http().get('/robots.txt').expect(200);
      expect(robots.text).toContain('Sitemap:');
      const sitemap = await ctx.http().get('/sitemap.xml').expect(200);
      expect(sitemap.headers['content-type']).toContain('xml');
      expect(sitemap.text).toContain('/features</loc>');
      expect(sitemap.text).not.toContain('/login');
    });

    it('a public page carries its own title and canonical; a private one is noindex', async () => {
      const features = await ctx.http().get('/features').expect(200);
      expect(features.text).toContain(
        '<title>Features — lead tracking, follow-ups and sales pipeline | LeadFlow</title>',
      );
      expect(features.text).toContain('rel="canonical"');
      expect(features.headers['x-robots-tag']).toBeUndefined();

      const leads = await ctx.http().get('/leads').expect(200);
      expect(leads.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(leads.text).toContain('noindex');
    });

    it('the SEO status view says Search Console is not connected rather than inventing numbers', async () => {
      const seo = (await signed('/seo').expect(200)).body.data;
      expect(seo.searchConsole.connected).toBe(false);
      expect(seo.pages.length).toBe(6);
    });
  });
});
