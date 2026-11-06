import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';

/** One aggregated API bucket, as the collector hands it over at flush time. */
export interface ApiBucketRow {
  hour: Date;
  method: string;
  route: string;
  status: number;
  errorCode: string;
  count: number;
  totalMs: number;
  maxMs: number;
  histogram: number[];
}

export interface OrgBucketRow {
  hour: Date;
  organizationId: string;
  count: number;
  errorCount: number;
}

const HIST_KEYS = ['h0', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8'] as const;

/**
 * Every database read and write behind platform analytics.
 *
 * Platform-level, cross-tenant BY DESIGN: these reads run under an explicit
 * system scope with a stated reason, and the only caller is the signed,
 * read-only CRAVION Admin analytics API (plus the background writers). No
 * tenant-facing endpoint reaches this repository.
 */
@Injectable()
export class PlatformAnalyticsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private get db() {
    return this.prisma.client;
  }

  private system<T>(reason: string, run: () => Promise<T>): Promise<T> {
    return this.tenantContext.runAsSystem(`platform analytics: ${reason}`, run);
  }

  // ---------------------------------------------------------------------------
  // Writes (background, never on the request's critical path)
  // ---------------------------------------------------------------------------

  async touchActivity(userId: string, organizationId: string, at: Date, day: Date): Promise<void> {
    await this.system('record user activity', async () => {
      await this.db.user.updateMany({ where: { id: userId }, data: { lastActiveAt: at } });
      await this.db.userActivityDay.createMany({
        data: [{ userId, organizationId, day, firstSeenAt: at }],
        skipDuplicates: true,
      });
    });
  }

  async flushApiBuckets(rows: ApiBucketRow[], orgRows: OrgBucketRow[]): Promise<void> {
    await this.system('flush API metrics', async () => {
      for (const row of rows) {
        const key = {
          hour: row.hour,
          method: row.method,
          route: row.route,
          status: row.status,
          errorCode: row.errorCode,
        };
        const hist = Object.fromEntries(HIST_KEYS.map((k, i) => [k, row.histogram[i] ?? 0]));
        await this.db.apiMetricHour.upsert({
          where: { hour_method_route_status_errorCode: key },
          create: {
            ...key,
            count: row.count,
            totalMs: BigInt(row.totalMs),
            maxMs: row.maxMs,
            ...hist,
          },
          update: {
            count: { increment: row.count },
            totalMs: { increment: BigInt(row.totalMs) },
            ...Object.fromEntries(
              HIST_KEYS.map((k, i) => [k, { increment: row.histogram[i] ?? 0 }]),
            ),
          },
        });
        // Max is not additive: raise it only when this flush saw a slower request.
        await this.db.apiMetricHour.updateMany({
          where: { ...key, maxMs: { lt: row.maxMs } },
          data: { maxMs: row.maxMs },
        });
      }
      for (const row of orgRows) {
        await this.db.apiOrganizationHour.upsert({
          where: { hour_organizationId: { hour: row.hour, organizationId: row.organizationId } },
          create: row,
          update: { count: { increment: row.count }, errorCount: { increment: row.errorCount } },
        });
      }
    });
  }

  async recordWebHit(input: {
    visitorHash: string;
    sessionHash: string;
    day: Date;
    at: Date;
    path: string;
    source: string;
    referrerDomain: string | null;
    event: 'page_view' | 'registration_start' | 'registration_complete' | 'contact_submit';
  }): Promise<void> {
    await this.system('record public website hit', async () => {
      const existing = await this.db.webVisitor.findUnique({
        where: { visitorHash: input.visitorHash },
      });
      const returning = existing !== null && existing.firstSeenAt < input.day;
      if (existing) {
        await this.db.webVisitor.update({
          where: { visitorHash: input.visitorHash },
          data: { lastSeenAt: input.at },
        });
      } else {
        await this.db.webVisitor.createMany({
          data: [
            {
              visitorHash: input.visitorHash,
              firstSeenAt: input.at,
              lastSeenAt: input.at,
              firstSource: input.source,
              firstLanding: input.path,
            },
          ],
          skipDuplicates: true,
        });
      }

      await this.db.webSession.upsert({
        where: { sessionHash: input.sessionHash },
        create: {
          sessionHash: input.sessionHash,
          visitorHash: input.visitorHash,
          day: input.day,
          startedAt: input.at,
          landingPath: input.path,
          source: input.source,
          referrerDomain: input.referrerDomain,
          pageViews: input.event === 'page_view' ? 1 : 0,
          returning,
        },
        update: input.event === 'page_view' ? { pageViews: { increment: 1 } } : {},
      });

      if (input.event === 'page_view') {
        await this.db.webPageDay.upsert({
          where: { day_path: { day: input.day, path: input.path } },
          create: { day: input.day, path: input.path, views: 1 },
          update: { views: { increment: 1 } },
        });
      } else {
        // Conversion events are attributed to the visit's own source.
        const session = await this.db.webSession.findUnique({
          where: { sessionHash: input.sessionHash },
          select: { source: true },
        });
        const source = session?.source ?? input.source;
        await this.db.webEventDay.upsert({
          where: { day_event_source: { day: input.day, event: input.event, source } },
          create: { day: input.day, event: input.event, source, count: 1 },
          update: { count: { increment: 1 } },
        });
      }
    });
  }

  /** Deletes what is older than the retention windows. Returns rows removed. */
  async applyRetention(cutoffs: { hourly: Date; daily: Date }): Promise<number> {
    return this.system('apply retention', async () => {
      const results = await Promise.all([
        this.db.apiMetricHour.deleteMany({ where: { hour: { lt: cutoffs.hourly } } }),
        this.db.apiOrganizationHour.deleteMany({ where: { hour: { lt: cutoffs.hourly } } }),
        this.db.userActivityDay.deleteMany({ where: { day: { lt: cutoffs.daily } } }),
        this.db.webSession.deleteMany({ where: { day: { lt: cutoffs.daily } } }),
        this.db.webPageDay.deleteMany({ where: { day: { lt: cutoffs.daily } } }),
        this.db.webEventDay.deleteMany({ where: { day: { lt: cutoffs.daily } } }),
        this.db.webVisitor.deleteMany({ where: { lastSeenAt: { lt: cutoffs.daily } } }),
      ]);
      return results.reduce((n, r) => n + r.count, 0);
    });
  }
}
