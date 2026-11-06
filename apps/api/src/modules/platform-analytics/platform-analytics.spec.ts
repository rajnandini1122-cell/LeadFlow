import { analyticsDay, histogramPercentile, latencyBucket } from './analytics-time';
import { ActivityTrackerService } from './activity-tracker.service';
import { ApiMetricsCollector } from './api-metrics.collector';
import { resolveRange } from './admin-analytics.service';
import { classifySource, isBot, measuredPath, referrerDomain } from './web-analytics';
import {
  canonicalPath,
  headFor,
  renderIndexHtml,
  robotsTxt,
  sitemapXml,
} from '../../common/web/seo';
import type { PlatformAnalyticsRepository } from './platform-analytics.repository';

const BASE = 'https://leadflow.cravionventures.com';

describe('analytics time', () => {
  it('counts days in Asia/Kolkata', () => {
    // 20:00 UTC on 1 Nov is 01:30 on 2 Nov in India.
    expect(analyticsDay(new Date('2026-11-01T20:00:00Z')).toISOString()).toBe(
      '2026-11-02T00:00:00.000Z',
    );
    expect(analyticsDay(new Date('2026-11-01T10:00:00Z')).toISOString()).toBe(
      '2026-11-01T00:00:00.000Z',
    );
  });

  it('buckets latency and estimates p95 from the histogram (upper bound)', () => {
    expect(latencyBucket(10)).toBe(0);
    expect(latencyBucket(25)).toBe(0);
    expect(latencyBucket(26)).toBe(1);
    expect(latencyBucket(99_999)).toBe(8);
    // 100 requests: 95 under 50 ms, 5 at 600 ms -> p95 in the 50 ms bucket.
    const buckets = [0, 95, 0, 0, 0, 5, 0, 0, 0];
    expect(histogramPercentile(buckets, 95)).toBe(50);
    expect(histogramPercentile(buckets, 99)).toBe(1000);
    expect(histogramPercentile([0, 0, 0, 0, 0, 0, 0, 0, 3], 95)).toBeNull(); // over 5 s
    expect(histogramPercentile(new Array(9).fill(0), 95)).toBeNull();
  });

  it('resolves ranges and refuses nonsense custom ones', () => {
    const now = new Date('2026-11-06T12:00:00Z');
    expect(resolveRange({ range: '7d' }, now).label).toBe('7d');
    expect(resolveRange({}, now).label).toBe('24h');
    expect(
      resolveRange(
        { range: 'custom', from: '2026-11-05T00:00:00Z', to: '2026-11-04T00:00:00Z' },
        now,
      ).label,
    ).toBe('24h');
    expect(
      resolveRange(
        { range: 'custom', from: '2026-11-01T00:00:00Z', to: '2026-11-04T00:00:00Z' },
        now,
      ).label,
    ).toBe('custom');
  });
});

describe('ActivityTrackerService', () => {
  const repo = (impl?: () => Promise<void>) => ({
    touchActivity: jest.fn(impl ?? (() => Promise.resolve())),
  });

  it('writes at most once a minute per user and organization, however many tabs or devices', async () => {
    const r = repo();
    const tracker = new ActivityTrackerService(r as unknown as PlatformAnalyticsRepository);
    const t0 = new Date('2026-11-06T06:00:00Z');
    for (let i = 0; i < 20; i++) tracker.touch('u1', 'o1', new Date(t0.getTime() + i * 1000));
    await tracker.settle();
    expect(r.touchActivity).toHaveBeenCalledTimes(1);
    tracker.touch('u1', 'o1', new Date(t0.getTime() + 61_000));
    tracker.touch('u1', 'o2', new Date(t0.getTime() + 1_000)); // another organization
    await tracker.settle();
    expect(r.touchActivity).toHaveBeenCalledTimes(3);
  });

  it('writes again on the first request of a new day', async () => {
    const r = repo();
    const tracker = new ActivityTrackerService(r as unknown as PlatformAnalyticsRepository);
    tracker.touch('u1', 'o1', new Date('2026-11-06T18:29:50Z')); // 23:59:50 IST
    tracker.touch('u1', 'o1', new Date('2026-11-06T18:30:05Z')); // 00:00:05 IST next day
    await tracker.settle();
    expect(r.touchActivity).toHaveBeenCalledTimes(2);
  });

  it('never throws into the request when the write fails', async () => {
    const tracker = new ActivityTrackerService(
      repo(() => Promise.reject(new Error('db down'))) as unknown as PlatformAnalyticsRepository,
    );
    expect(() => tracker.touch('u1', 'o1')).not.toThrow();
    await expect(tracker.settle()).resolves.toBeUndefined();
  });
});

describe('ApiMetricsCollector', () => {
  const makeRepo = () => ({
    flushApiBuckets: jest.fn(() => Promise.resolve()),
    applyRetention: jest.fn(() => Promise.resolve(0)),
  });

  it('aggregates by hour, method, route template, status and error code', async () => {
    const repo = makeRepo();
    const c = new ApiMetricsCollector(repo as unknown as PlatformAnalyticsRepository);
    const at = new Date('2026-11-06T06:10:00Z');
    c.record({
      method: 'get',
      route: '/api/v1/leads/:id',
      status: 200,
      errorCode: '',
      durationMs: 20,
      organizationId: 'o1',
      at,
    });
    c.record({
      method: 'GET',
      route: '/api/v1/leads/:id',
      status: 200,
      errorCode: '',
      durationMs: 300,
      organizationId: 'o1',
      at,
    });
    c.record({
      method: 'GET',
      route: '/api/v1/leads/:id',
      status: 404,
      errorCode: 'LEAD_NOT_FOUND',
      durationMs: 5,
      organizationId: 'o1',
      at,
    });
    c.record({
      method: 'GET',
      route: '/api/v1/leads',
      status: 200,
      errorCode: 'IGNORED_ON_SUCCESS',
      durationMs: 5,
      at,
    });
    await c.flush(at);

    const [rows, orgRows] = repo.flushApiBuckets.mock.calls[0] as unknown as [
      {
        route: string;
        status: number;
        errorCode: string;
        count: number;
        maxMs: number;
        histogram: number[];
        hour: Date;
      }[],
      { organizationId: string; count: number; errorCount: number }[],
    ];
    const ok = rows.find((r) => r.route === '/api/v1/leads/:id' && r.status === 200)!;
    expect(ok).toMatchObject({ count: 2, maxMs: 300, errorCode: '' });
    expect(ok.hour.toISOString()).toBe('2026-11-06T06:00:00.000Z');
    expect(ok.histogram[0]).toBe(1);
    expect(ok.histogram[4]).toBe(1);
    expect(rows.find((r) => r.status === 404)?.errorCode).toBe('LEAD_NOT_FOUND');
    expect(rows.find((r) => r.route === '/api/v1/leads')?.errorCode).toBe('');
    expect(orgRows).toEqual([
      expect.objectContaining({ organizationId: 'o1', count: 3, errorCount: 1 }),
    ]);
  });

  it('a failed flush is recorded and does not throw', async () => {
    const repo = {
      flushApiBuckets: jest.fn(() => Promise.reject(new Error('db down'))),
      applyRetention: jest.fn(),
    };
    const c = new ApiMetricsCollector(repo as unknown as PlatformAnalyticsRepository);
    c.record({ method: 'GET', route: '/api/v1/x', status: 200, errorCode: '', durationMs: 1 });
    await expect(c.flush()).resolves.toBeUndefined();
    expect(c.lastFlushError).toContain('db down');
  });

  it('applies retention at most once a day', async () => {
    const repo = makeRepo();
    const c = new ApiMetricsCollector(repo as unknown as PlatformAnalyticsRepository);
    const now = new Date('2026-11-06T06:00:00Z');
    await c.flush(now);
    await c.flush(new Date(now.getTime() + 60_000));
    expect(repo.applyRetention).toHaveBeenCalledTimes(1);
    const cutoffs = (
      repo.applyRetention.mock.calls[0] as unknown as [{ hourly: Date; daily: Date }]
    )[0];
    expect(cutoffs.hourly.toISOString()).toBe(
      new Date(now.getTime() - 90 * 86_400_000).toISOString(),
    );
  });
});

describe('website analytics rules', () => {
  it('accepts only the public paths, without query strings', () => {
    expect(measuredPath('/pricing?utm_source=x')).toBe('/pricing');
    expect(measuredPath('/features/')).toBe('/features');
    expect(measuredPath('/')).toBe('/');
    expect(measuredPath('/leads/123')).toBeNull();
    expect(measuredPath('/reset-password/token')).toBeNull();
  });

  it('keeps only the referring host, and none for ourselves', () => {
    expect(
      referrerDomain('https://www.google.com/search?q=crm', 'leadflow.cravionventures.com'),
    ).toBe('www.google.com');
    expect(
      referrerDomain(
        'https://leadflow.cravionventures.com/features',
        'leadflow.cravionventures.com',
      ),
    ).toBeNull();
    expect(referrerDomain('not a url', 'x')).toBeNull();
  });

  it.each([
    [{ referrerDomain: null }, 'direct'],
    [{ referrerDomain: 'www.google.com' }, 'organic'],
    [{ referrerDomain: 'www.bing.com' }, 'organic'],
    [{ referrerDomain: 'l.facebook.com' }, 'social'],
    [{ referrerDomain: 'www.linkedin.com' }, 'social'],
    [{ referrerDomain: 'blog.example.org' }, 'referral'],
    [{ referrerDomain: 'www.google.com', utmSource: 'newsletter' }, 'campaign'],
  ])('classifies %j as %s', (input, expected) => {
    expect(classifySource(input)).toBe(expected);
  });

  it('treats crawlers and missing user agents as bots', () => {
    expect(isBot('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe(true);
    expect(isBot(undefined)).toBe(true);
    expect(isBot('Mozilla/5.0 (Windows NT 10.0) Chrome/130')).toBe(false);
  });
});

describe('SEO', () => {
  it('gives each public page its own title, canonical, social tags and JSON-LD', () => {
    const head = headFor('/features/', BASE);
    expect(head.indexable).toBe(true);
    expect(head.tags).toContain(`<link rel="canonical" href="${BASE}/features" />`);
    expect(head.tags).toContain('og:title');
    expect(head.tags).toContain('application/ld+json');
    expect(headFor('/', BASE).tags).toContain('SoftwareApplication');
  });

  it.each([
    '/login',
    '/leads',
    '/leads/0190',
    '/today',
    '/invite/abc',
    '/reset-password/xyz',
    '/settings',
  ])('marks %s noindex', (path) => {
    const head = headFor(path, BASE);
    expect(head.indexable).toBe(false);
    expect(head.tags).toContain('noindex');
  });

  it('rewrites the template head without duplicating the description', () => {
    const template =
      '<html><head><title>Old</title><meta name="description" content="old" /></head><body></body></html>';
    const { html } = renderIndexHtml(template, '/pricing', BASE);
    expect(html).toContain('<title>Pricing — LeadFlow sales CRM</title>');
    expect(html.match(/name="description"/g)).toHaveLength(1);
    expect(html).not.toContain('content="old"');
  });

  it('cannot break out of the JSON-LD script', () => {
    expect(headFor('/', BASE).tags).not.toMatch(/<\/script>[\s\S]*<\/script>[\s\S]*<\/script>/);
  });

  it('robots.txt points at the sitemap and keeps crawlers out of the API', () => {
    const robots = robotsTxt(BASE);
    expect(robots).toContain(`Sitemap: ${BASE}/sitemap.xml`);
    expect(robots).toContain('Disallow: /api/');
  });

  it('the sitemap lists exactly the public pages, on the canonical host', () => {
    const xml = sitemapXml(`${BASE}/some/path`);
    expect(xml.match(/<loc>/g)).toHaveLength(6);
    expect(xml).toContain(`<loc>${BASE}/</loc>`);
    expect(xml).not.toContain('/login');
    expect(canonicalPath('/about///')).toBe('/about');
  });
});
