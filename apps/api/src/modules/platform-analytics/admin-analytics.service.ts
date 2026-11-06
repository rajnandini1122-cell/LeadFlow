import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../common/config/config.module';
import { RedisService } from '../../common/redis/redis.service';
import { WorkerHeartbeatService } from '../../common/observability/worker-heartbeat.service';
import {
  ANALYTICS_TIMEZONE,
  analyticsDay,
  daysAgo,
  histogramPercentile,
  LATENCY_BOUNDS_MS,
} from './analytics-time';
import { AnalyticsReadsRepository, type UserQuery } from './analytics-reads.repository';
import { ApiMetricsCollector, RETENTION } from './api-metrics.collector';
import { PUBLIC_PATHS } from './web-analytics';

/** "Online" = an authenticated request within this window. Shown on the dashboard. */
export const ONLINE_WINDOW_MINUTES = 5;

export type Range = { from: Date; to: Date; label: string };

/** 24h | 7d | 30d, or a custom from/to (max 400 days). */
export function resolveRange(
  input: { range?: string | undefined; from?: string | undefined; to?: string | undefined },
  now: Date,
): Range {
  if (input.range === 'custom' && input.from && input.to) {
    const from = new Date(input.from);
    const to = new Date(input.to);
    if (
      !Number.isNaN(from.getTime()) &&
      !Number.isNaN(to.getTime()) &&
      from < to &&
      to.getTime() - from.getTime() <= 400 * 86_400_000
    ) {
      return { from, to, label: 'custom' };
    }
  }
  const days = input.range === '7d' ? 7 : input.range === '30d' ? 30 : 1;
  return {
    from: new Date(now.getTime() - days * 86_400_000),
    to: now,
    label: days === 1 ? '24h' : `${days}d`,
  };
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Every figure the CRAVION Admin "LeadFlow Analytics" module shows, computed
 * from real rows. Where something was never recorded, the response carries
 * `null` and the collection start date -- never an invented zero.
 */
@Injectable()
export class AdminAnalyticsService {
  constructor(
    private readonly reads: AnalyticsReadsRepository,
    private readonly collector: ApiMetricsCollector,
    private readonly config: AppConfig,
    private readonly redis: RedisService,
    private readonly worker: WorkerHeartbeatService,
  ) {}

  private async collections(): Promise<Record<string, string | null>> {
    const rows = await this.reads.collections();
    const of = (key: string) => iso(rows.find((r) => r.key === key)?.startedAt);
    return {
      userActivity: of('user_activity'),
      apiMetrics: of('api_metrics'),
      webAnalytics: of('web_analytics'),
    };
  }

  async overview(now: Date = new Date()) {
    const onlineSince = new Date(now.getTime() - ONLINE_WINDOW_MINUTES * 60_000);
    const [users, dau, wau, mau, orgs, collections, api24] = await Promise.all([
      this.reads.userCounts(now, onlineSince),
      this.reads.distinctActiveUsers(daysAgo(now, 0)),
      this.reads.distinctActiveUsers(daysAgo(now, 6)),
      this.reads.distinctActiveUsers(daysAgo(now, 29)),
      this.reads.organizations(monthStart(now)),
      this.collections(),
      this.api({ range: '24h' }, now),
    ]);
    return {
      generatedAt: now.toISOString(),
      timezone: ANALYTICS_TIMEZONE,
      collections,
      definitions: DEFINITIONS,
      users: {
        total: users.total,
        verified: users.verified,
        active: users.active,
        invited: users.invited,
        disabled: users.suspended,
        newToday: users.new1,
        new7Days: users.new7,
        new30Days: users.new30,
        everSignedIn: users.everLoggedIn,
        dau,
        wau,
        mau,
        onlineNow: users.online,
        onlineWindowMinutes: ONLINE_WINDOW_MINUTES,
      },
      organizations: {
        total: orgs.orgs.length,
        active: orgs.orgs.filter((o) => o.status !== 'SUSPENDED').length,
        trial: orgs.orgs.filter((o) => o.status === 'TRIAL').length,
        suspended: orgs.orgs.filter((o) => o.status === 'SUSPENDED').length,
        newThisMonth: orgs.newThisMonth,
      },
      api24h: api24.totals,
    };
  }

  async users(query: UserQuery) {
    const { total, users } = await this.reads.usersPage(query);
    return {
      total,
      page: Math.floor(query.skip / query.take) + 1,
      pageSize: query.take,
      items: users.map((u) => ({
        id: u.id,
        name: u.fullName,
        email: u.email,
        status: u.status,
        emailVerified: u.emailVerifiedAt !== null,
        registeredAt: u.createdAt.toISOString(),
        firstLoginAt: iso(u.firstLoginAt),
        lastLoginAt: iso(u.lastLoginAt),
        lastActiveAt: iso(u.lastActiveAt),
        activeSessions: u._count.sessions,
        organizations: u.memberships.map((m) => ({
          id: m.organization.id,
          name: m.organization.name,
          role: m.role.key,
          membershipStatus: m.status,
        })),
      })),
      collections: await this.collections(),
    };
  }

  /** CSV of the same filtered list, capped at 10 000 rows. No secrets, no phone numbers. */
  async usersCsv(query: UserQuery): Promise<string> {
    const page = await this.users({ ...query, skip: 0, take: 10_000 });
    const header = [
      'Name',
      'Email',
      'Organizations',
      'Status',
      'Email verified',
      'Registered',
      'First login',
      'Last login',
      'Last active',
    ];
    const lines = page.items.map((u) =>
      [
        u.name,
        u.email,
        u.organizations.map((o) => `${o.name} (${o.role})`).join('; '),
        u.status,
        u.emailVerified ? 'yes' : 'no',
        u.registeredAt,
        u.firstLoginAt ?? 'not recorded',
        u.lastLoginAt ?? 'never',
        u.lastActiveAt ?? 'not recorded',
      ]
        .map(csvCell)
        .join(','),
    );
    return [header.join(','), ...lines].join('\r\n') + '\r\n';
  }

  async organizations(now: Date = new Date(), range = resolveRange({ range: '30d' }, now)) {
    const [data, usage] = await Promise.all([
      this.reads.organizations(monthStart(now)),
      this.reads.orgApiRows(range.from, range.to),
    ]);
    const lastSeen = new Map(data.lastActivity.map((r) => [r.organizationId, r._max.firstSeenAt]));
    const usageOf = new Map(usage.map((u) => [u.organizationId, u]));
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      collections: await this.collections(),
      items: data.orgs.map((o) => ({
        id: o.id,
        name: o.name,
        status: o.status,
        createdAt: o.createdAt.toISOString(),
        activeUsers: o._count.memberships,
        lastActivityAt: iso(lastSeen.get(o.id) ?? null),
        apiRequests: usageOf.get(o.id)?.requests ?? 0,
        apiErrors: usageOf.get(o.id)?.errors ?? 0,
      })),
    };
  }

  async sessions(now: Date = new Date()) {
    const onlineSince = new Date(now.getTime() - ONLINE_WINDOW_MINUTES * 60_000);
    const [sessions, online] = await Promise.all([
      this.reads.sessionCounts(now),
      this.reads.onlineUsers(onlineSince),
    ]);
    return {
      onlineWindowMinutes: ONLINE_WINDOW_MINUTES,
      onlineUsers: online.map((u) => ({
        id: u.id,
        name: u.fullName,
        lastActiveAt: iso(u.lastActiveAt),
      })),
      liveSessions: sessions,
      collections: await this.collections(),
    };
  }

  async activity(now: Date = new Date(), days = 30) {
    const fromDay = daysAgo(now, days - 1);
    const [active, regs] = await Promise.all([
      this.reads.activeUsersByDay(fromDay),
      this.reads.registrationsSince(fromDay),
    ]);
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = daysAgo(now, i);
      const key = dayKey(day);
      series.push({
        day: key,
        activeUsers: active.find((a) => dayKey(a.day) === key)?.users ?? 0,
        registrations: regs.users.filter((d) => dayKey(analyticsDay(d)) === key).length,
        organizationsCreated: regs.organizations.filter((d) => dayKey(analyticsDay(d)) === key)
          .length,
      });
    }
    return { timezone: ANALYTICS_TIMEZONE, collections: await this.collections(), series };
  }

  async api(input: { range?: string; from?: string; to?: string }, now: Date = new Date()) {
    const range = resolveRange(input, now);
    const rows = await this.reads.apiRows(range.from, range.to);
    const hist = new Array<number>(LATENCY_BOUNDS_MS.length + 1).fill(0);
    let requests = 0;
    let totalMs = 0;
    let s4 = 0;
    let s5 = 0;
    let authFailures = 0;
    let rateLimited = 0;
    const endpoints = new Map<
      string,
      {
        method: string;
        route: string;
        requests: number;
        errors: number;
        totalMs: number;
        maxMs: number;
        hist: number[];
      }
    >();
    const errors = new Map<string, number>();
    const series = new Map<
      number,
      { requests: number; failed: number; totalMs: number; hist: number[] }
    >();
    const step =
      range.to.getTime() - range.from.getTime() > 2 * 86_400_000 ? 86_400_000 : 3_600_000;

    for (const r of rows) {
      const h = [r.h0, r.h1, r.h2, r.h3, r.h4, r.h5, r.h6, r.h7, r.h8];
      const ms = Number(r.totalMs);
      requests += r.count;
      totalMs += ms;
      h.forEach((v, i) => (hist[i] = (hist[i] ?? 0) + v));
      if (r.status >= 400 && r.status < 500) s4 += r.count;
      if (r.status >= 500) s5 += r.count;
      if (r.status === 401) authFailures += r.count;
      if (r.status === 429) rateLimited += r.count;
      if (r.status >= 400) {
        const k = `${r.status} ${r.errorCode || '—'}`;
        errors.set(k, (errors.get(k) ?? 0) + r.count);
      }
      const ek = `${r.method} ${r.route}`;
      const e = endpoints.get(ek) ?? {
        method: r.method,
        route: r.route,
        requests: 0,
        errors: 0,
        totalMs: 0,
        maxMs: 0,
        hist: new Array<number>(9).fill(0),
      };
      e.requests += r.count;
      e.totalMs += ms;
      e.maxMs = Math.max(e.maxMs, r.maxMs);
      if (r.status >= 400) e.errors += r.count;
      h.forEach((v, i) => (e.hist[i] = (e.hist[i] ?? 0) + v));
      endpoints.set(ek, e);

      const bucket = step === 86_400_000 ? analyticsDay(r.hour).getTime() : r.hour.getTime();
      const s = series.get(bucket) ?? {
        requests: 0,
        failed: 0,
        totalMs: 0,
        hist: new Array<number>(9).fill(0),
      };
      s.requests += r.count;
      s.totalMs += ms;
      if (r.status >= 500 || (r.status >= 400 && r.status !== 401 && r.status !== 404))
        s.failed += r.count;
      h.forEach((v, i) => (s.hist[i] = (s.hist[i] ?? 0) + v));
      series.set(bucket, s);
    }

    const endpointList = [...endpoints.values()].map((e) => ({
      method: e.method,
      route: e.route,
      requests: e.requests,
      errors: e.errors,
      errorRate: e.requests ? e.errors / e.requests : 0,
      avgMs: e.requests ? Math.round(e.totalMs / e.requests) : null,
      p95Ms: histogramPercentile(e.hist, 95),
      maxMs: e.maxMs,
    }));
    const hours = Math.max(1, (range.to.getTime() - range.from.getTime()) / 3_600_000);
    const completeness = await this.completeness(range.from, range.to, now);

    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString(), label: range.label },
      collections: await this.collections(),
      latencyBucketsMs: LATENCY_BOUNDS_MS,
      totals: {
        requests,
        requestsPerMinute: Math.round((requests / (hours * 60)) * 100) / 100,
        clientErrors4xx: s4,
        serverErrors5xx: s5,
        errorRate: requests ? (s4 + s5) / requests : 0,
        serverErrorRate: requests ? s5 / requests : 0,
        avgMs: requests ? Math.round(totalMs / requests) : null,
        p95Ms: histogramPercentile(hist, 95),
        authFailures,
        rateLimited,
        completeness,
      },
      topEndpoints: [...endpointList].sort((a, b) => b.requests - a.requests).slice(0, 15),
      slowEndpoints: endpointList
        .filter((e) => e.requests >= 5)
        .sort((a, b) => (b.avgMs ?? 0) - (a.avgMs ?? 0))
        .slice(0, 10),
      failingEndpoints: endpointList
        .filter((e) => e.errors > 0)
        .sort((a, b) => b.errors - a.errors)
        .slice(0, 15),
      errorsByCode: [...errors.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count),
      series: [...series.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([t, s]) => ({
          at: new Date(t).toISOString(),
          requests: s.requests,
          failed: s.failed,
          avgMs: s.requests ? Math.round(s.totalMs / s.requests) : null,
          p95Ms: histogramPercentile(s.hist, 95),
        })),
      seriesStep: step === 86_400_000 ? 'day' : 'hour',
      liveMinutes: this.collector.recentMinutes(now),
      byOrganization: (await this.reads.orgApiRows(range.from, range.to)).sort(
        (a, b) => b.requests - a.requests,
      ),
    };
  }

  /**
   * Whether the API counts for [from, to] are complete. They are NOT when a
   * process running in that window stopped without its final flush (up to
   * FLUSH_EVERY_MS of its traffic was never written) or hit the bucket
   * ceiling. Either way the figures are lower bounds, and say so.
   */
  private async completeness(from: Date, to: Date, now: Date) {
    const flushMs = ApiMetricsCollector.FLUSH_EVERY_MS;
    // A process whose last flush was up to one interval before `from` may
    // have lost traffic from inside the window.
    const instances = await this.reads.metricInstances(new Date(from.getTime() - flushMs), to);
    const staleBefore = now.getTime() - 3 * flushMs;
    const unclean = instances.filter(
      (i) =>
        i.stoppedAt === null &&
        i.lastFlushAt.getTime() < staleBefore &&
        i.id !== this.collector.instanceId,
    );
    const droppedRequests = instances.reduce((n, i) => n + i.droppedRequests, 0);
    return {
      exact: unclean.length === 0 && droppedRequests === 0,
      uncleanStops: unclean.map((i) => ({
        lastFlushAt: i.lastFlushAt.toISOString(),
        maxUncountedSeconds: flushMs / 1000,
      })),
      droppedRequests,
      countedThrough: iso(this.collector.lastFlushAt),
    };
  }

  async website(input: { range?: string; from?: string; to?: string }, now: Date = new Date()) {
    const range = resolveRange(
      { range: input.range ?? '30d', from: input.from, to: input.to },
      now,
    );
    const fromDay = analyticsDay(range.from);
    const toDay = new Date(analyticsDay(range.to).getTime() + 86_400_000);
    const [sessions, pages, events, regs] = await Promise.all([
      this.reads.webSessions(fromDay, toDay),
      this.reads.webPageViews(fromDay, toDay),
      this.reads.webEvents(fromDay, toDay),
      this.reads.registrationsSince(range.from),
    ]);
    const visitors = new Set(sessions.map((s) => s.visitorHash));
    const count = <T>(items: T[], key: (t: T) => string) => {
      const m = new Map<string, number>();
      for (const i of items) m.set(key(i), (m.get(key(i)) ?? 0) + 1);
      return [...m.entries()]
        .map(([k, n]) => ({ key: k, count: n }))
        .sort((a, b) => b.count - a.count);
    };
    const eventTotal = (e: string) =>
      events.filter((x) => x.event === e).reduce((n, x) => n + x.count, 0);
    const completed = eventTotal('registration_complete');
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      timezone: ANALYTICS_TIMEZONE,
      collections: await this.collections(),
      enabled: this.config.get('WEB_ANALYTICS_ENABLED'),
      measuredPaths: PUBLIC_PATHS,
      totals: {
        uniqueVisitors: visitors.size,
        sessions: sessions.length,
        pageViews: pages.reduce((n, p) => n + p.views, 0),
        newVisits: sessions.filter((s) => !s.returning).length,
        returningVisits: sessions.filter((s) => s.returning).length,
        organicVisits: sessions.filter((s) => s.source === 'organic').length,
        registrationStarts: eventTotal('registration_start'),
        registrationsCompletedOnWebsite: completed,
        contactSubmissions: eventTotal('contact_submit'),
        conversionRate: visitors.size ? completed / visitors.size : null,
        // Server truth, whatever the browser sent: every organization created in the range.
        organizationsRegistered: regs.organizations.length,
      },
      topLandingPages: count(sessions, (s) => s.landingPath),
      pageViewsByPath: [
        ...pages.reduce(
          (m, p) => m.set(p.path, (m.get(p.path) ?? 0) + p.views),
          new Map<string, number>(),
        ),
      ]
        .map(([key, c]) => ({ key, count: c }))
        .sort((a, b) => b.count - a.count),
      sources: count(sessions, (s) => s.source),
      referrers: count(
        sessions.filter((s) => s.referrerDomain),
        (s) => s.referrerDomain as string,
      ).slice(0, 15),
      conversionsBySource: count(
        events
          .filter((e) => e.event === 'registration_complete')
          .flatMap((e) => new Array<string>(e.count).fill(e.source)),
        (s) => s,
      ),
    };
  }

  async health(now: Date = new Date()) {
    const started = Date.now();
    const database = await this.reads
      .ping()
      .then(() => true)
      .catch(() => false);
    const databaseMs = Date.now() - started;
    const [redis, worker, api1h] = await Promise.all([
      this.redis.ping().catch(() => false),
      this.worker.read(now).catch(() => null),
      this.api(
        {
          range: 'custom',
          from: new Date(now.getTime() - 3_600_000).toISOString(),
          to: now.toISOString(),
        },
        now,
      ),
    ]);
    return {
      checkedAt: now.toISOString(),
      version: process.env['RAILWAY_GIT_COMMIT_SHA']?.slice(0, 12) ?? null,
      uptimeSeconds: Math.round(process.uptime()),
      database: { ok: database, latencyMs: databaseMs },
      redis: { ok: redis },
      worker,
      lastHour: {
        requests: api1h.totals.requests,
        serverErrors5xx: api1h.totals.serverErrors5xx,
        serverErrorRate: api1h.totals.serverErrorRate,
        p95Ms: api1h.totals.p95Ms,
        completeness: api1h.totals.completeness,
      },
      metrics: {
        collectorStartedAt: this.collector.startedAt.toISOString(),
        lastFlushAt: iso(this.collector.lastFlushAt),
        lastFlushError: this.collector.lastFlushError,
        droppedRequestsSinceStart: this.collector.droppedRequests,
        retention: RETENTION,
      },
    };
  }

  async audit(take = 100) {
    const rows = await this.reads.analyticsAudit(take);
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      actor: r.externalActorRef,
      details: r.after,
      at: r.createdAt.toISOString(),
    }));
  }
}

function monthStart(now: Date): Date {
  const day = analyticsDay(now);
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));
}

function csvCell(value: string): string {
  // Leading = + - @ would make a spreadsheet run the cell as a formula.
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const DEFINITIONS = {
  registeredUsers: 'Every LeadFlow user account (users.created_at is the registration time).',
  verifiedUsers: 'Users who confirmed their email address.',
  activeAccounts:
    'Users with status ACTIVE (invited users who never accepted are counted separately).',
  disabledAccounts: 'Users with status SUSPENDED.',
  dau: 'Distinct users with at least one authenticated API request today (Asia/Kolkata).',
  wau: 'Distinct users with authenticated activity in the last 7 days, including today.',
  mau: 'Distinct users with authenticated activity in the last 30 days, including today.',
  onlineNow: `Distinct users whose last authenticated request was within the last ${ONLINE_WINDOW_MINUTES} minutes. A valid token alone does not count; many tabs or devices count once.`,
  lastActive: 'Last authenticated request, recorded at most once a minute per user.',
  firstLogin:
    'First successful sign-in recorded after tracking began. Earlier first logins were never recorded.',
  apiRequests: 'Requests to /api/* (health probes excluded), aggregated hourly by route template.',
  apiCompleteness:
    'API counts are buffered for up to a minute. Exact unless an API process stopped without its final write (crash or kill: up to a minute of its traffic is missing) or hit the bucket ceiling; then the figures are marked as lower bounds. The current minute is not yet included.',
  errorRate: 'Share of requests answered 4xx or 5xx.',
  p95: 'Estimated from a latency histogram: the upper bound of the bucket the 95th percentile falls in.',
  uniqueVisitors:
    'Distinct browsers (random id kept in localStorage) on the public website. Bots, Do Not Track and Global Privacy Control are excluded.',
  sessions: 'Visits: a new one starts after 30 minutes of inactivity.',
  conversionRate: 'Registrations completed on the website ÷ unique visitors in the same range.',
};
