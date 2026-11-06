import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { hourStart, latencyBucket, LATENCY_BOUNDS_MS } from './analytics-time';
import {
  PlatformAnalyticsRepository,
  type ApiBucketRow,
  type OrgBucketRow,
} from './platform-analytics.repository';

export interface ApiObservation {
  method: string;
  /** The ROUTE TEMPLATE (/api/v1/leads/:id), never the concrete URL. */
  route: string;
  status: number;
  /** The API error code for 4xx/5xx, '' otherwise. */
  errorCode: string;
  durationMs: number;
  organizationId?: string | undefined;
  at?: Date | undefined;
}

/** How long each kind of analytics row is kept. Enforced once a day. */
export const RETENTION = { hourlyDays: 90, dailyDays: 400 } as const;

/**
 * API traffic, aggregated in memory and written once a minute.
 *
 * One database row per hour x method x route template x status x error code
 * -- never one row per request -- so cost grows with the API's SHAPE, not its
 * traffic. Recording is a few map operations and cannot throw into a request;
 * a failed flush is logged and those counts are dropped (the API keeps working).
 */
@Injectable()
export class ApiMetricsCollector implements OnModuleInit, OnApplicationShutdown {
  static readonly FLUSH_EVERY_MS = 60_000;
  /** A hard ceiling on distinct buckets between flushes: bounds memory. */
  private static readonly MAX_BUCKETS = 5_000;

  private readonly logger = new Logger(ApiMetricsCollector.name);
  private buckets = new Map<string, ApiBucketRow>();
  private orgBuckets = new Map<string, OrgBucketRow>();
  /** Requests per minute for the last 60 minutes (this process), for "requests per minute". */
  private readonly minutes = new Map<number, number>();
  private timer: NodeJS.Timeout | null = null;
  private lastRetentionAt = 0;
  private flushing: Promise<void> | null = null;

  readonly startedAt = new Date();
  lastFlushAt: Date | null = null;
  lastFlushError: string | null = null;
  dropped = 0;

  constructor(private readonly repository: PlatformAnalyticsRepository) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.flush(), ApiMetricsCollector.FLUSH_EVERY_MS);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  record(observation: ApiObservation): void {
    const at = observation.at ?? new Date();
    const hour = hourStart(at);
    const route = observation.route.slice(0, 200);
    const method = observation.method.toUpperCase().slice(0, 8);
    const errorCode = observation.status >= 400 ? observation.errorCode.slice(0, 60) : '';
    const key = `${hour.getTime()}|${method}|${route}|${observation.status}|${errorCode}`;

    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= ApiMetricsCollector.MAX_BUCKETS) {
        this.dropped++;
        return;
      }
      bucket = {
        hour,
        method,
        route,
        status: observation.status,
        errorCode,
        count: 0,
        totalMs: 0,
        maxMs: 0,
        histogram: new Array<number>(LATENCY_BOUNDS_MS.length + 1).fill(0),
      };
      this.buckets.set(key, bucket);
    }
    const ms = Math.max(0, Math.round(observation.durationMs));
    bucket.count++;
    bucket.totalMs += ms;
    bucket.maxMs = Math.max(bucket.maxMs, ms);
    bucket.histogram[latencyBucket(ms)] = (bucket.histogram[latencyBucket(ms)] ?? 0) + 1;

    if (observation.organizationId) {
      const orgKey = `${hour.getTime()}|${observation.organizationId}`;
      const org = this.orgBuckets.get(orgKey) ?? {
        hour,
        organizationId: observation.organizationId,
        count: 0,
        errorCount: 0,
      };
      org.count++;
      if (observation.status >= 400) org.errorCount++;
      this.orgBuckets.set(orgKey, org);
    }

    const minute = Math.floor(at.getTime() / 60_000);
    this.minutes.set(minute, (this.minutes.get(minute) ?? 0) + 1);
    for (const m of this.minutes.keys()) if (m < minute - 60) this.minutes.delete(m);
  }

  /** Requests in each of the last 60 whole minutes seen by THIS process. */
  recentMinutes(now: Date = new Date()): { minute: string; requests: number }[] {
    const current = Math.floor(now.getTime() / 60_000);
    const out: { minute: string; requests: number }[] = [];
    for (let m = current - 59; m <= current; m++) {
      out.push({ minute: new Date(m * 60_000).toISOString(), requests: this.minutes.get(m) ?? 0 });
    }
    return out;
  }

  /** Writes what has been collected. Safe to call concurrently (calls are serialised). */
  async flush(now: Date = new Date()): Promise<void> {
    if (this.flushing) await this.flushing;
    const rows = [...this.buckets.values()];
    const orgRows = [...this.orgBuckets.values()];
    this.buckets = new Map();
    this.orgBuckets = new Map();

    this.flushing = (async () => {
      try {
        if (rows.length > 0 || orgRows.length > 0)
          await this.repository.flushApiBuckets(rows, orgRows);
        this.lastFlushAt = now;
        this.lastFlushError = null;
        if (now.getTime() - this.lastRetentionAt > 86_400_000) {
          this.lastRetentionAt = now.getTime();
          await this.repository.applyRetention({
            hourly: new Date(now.getTime() - RETENTION.hourlyDays * 86_400_000),
            daily: new Date(now.getTime() - RETENTION.dailyDays * 86_400_000),
          });
        }
      } catch (error) {
        this.lastFlushError = error instanceof Error ? error.message.slice(0, 200) : 'flush failed';
        this.logger.warn(
          { err: error },
          'API metrics flush failed; counts for this minute dropped',
        );
      }
    })();
    await this.flushing;
    this.flushing = null;
  }
}
