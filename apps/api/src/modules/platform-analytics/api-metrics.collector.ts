import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { latencyBucket, LATENCY_BOUNDS_MS } from './analytics-time';
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
 * traffic. Recording is a few map operations and cannot throw into a request.
 *
 * WHAT CAN BE LOST, AND HOW WE KNOW. Counts live in memory for up to a minute.
 *   - Graceful stop (every Railway deploy or restart): the final flush runs
 *     before the database disconnects (PrismaService.beforeDisconnect), and
 *     the process is marked stopped cleanly. Nothing is lost.
 *   - Failed flush: each chunk is one transaction, so a failed chunk wrote
 *     nothing; it goes back into memory and is retried next minute.
 *   - Crash, OOM or kill: up to one minute is lost. The process's heartbeat
 *     row then has no stoppedAt and stops advancing, and the dashboard marks
 *     every figure covering that time as a lower bound, not exact.
 *   - Bucket ceiling: requests that would need a new bucket beyond
 *     MAX_BUCKETS are not recorded; they are COUNTED, and reported the same way.
 * Several replicas are safe: every write is an increment.
 */
@Injectable()
export class ApiMetricsCollector implements OnModuleInit {
  static readonly FLUSH_EVERY_MS = 60_000;
  /** Buckets per transaction, far inside Prisma's 5 s interactive-transaction limit. */
  static readonly CHUNK = 200;
  /** A hard ceiling on distinct buckets held in memory: bounds memory. */
  private static readonly MAX_BUCKETS = 5_000;

  private readonly logger = new Logger(ApiMetricsCollector.name);
  private buckets = new Map<string, ApiBucketRow>();
  private orgBuckets = new Map<string, OrgBucketRow>();
  /** Requests per minute for the last 60 minutes (this process), for "requests per minute". */
  private readonly minutes = new Map<number, number>();
  private timer: NodeJS.Timeout | null = null;
  private lastRetentionAt = 0;
  /** Flushes run one at a time, in call order. */
  private chain: Promise<void> = Promise.resolve();
  /** Dropped requests not yet written to this process's heartbeat row. */
  private unreportedDrops = 0;

  /** Identifies this process's heartbeat row. */
  readonly instanceId = randomUUID();
  readonly startedAt = new Date();
  lastFlushAt: Date | null = null;
  lastFlushError: string | null = null;
  /** Requests this process saw but could not record (bucket ceiling). */
  droppedRequests = 0;

  constructor(private readonly repository: PlatformAnalyticsRepository) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.flush(), ApiMetricsCollector.FLUSH_EVERY_MS);
    this.timer.unref();
    this.repository.beforeDisconnect(() => this.stop());
    // The heartbeat row exists from the start, so even a crash in the first
    // minute is visible.
    void this.flush();
  }

  /** The final flush, marking this process as stopped cleanly. Called on shutdown. */
  async stop(now: Date = new Date()): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush(now, true);
  }

  record(observation: ApiObservation): void {
    const atMs = observation.at?.getTime() ?? Date.now();
    const hourMs = atMs - (atMs % 3_600_000);
    const route = observation.route.slice(0, 200);
    const method = observation.method.toUpperCase().slice(0, 8);
    const errorCode = observation.status >= 400 ? observation.errorCode.slice(0, 60) : '';
    const ms = Math.max(0, Math.round(observation.durationMs));
    const slot = latencyBucket(ms);

    // Hot path: the bucket exists, so update it in place without allocating.
    const key = `${hourMs}|${method}|${route}|${observation.status}|${errorCode}`;
    const bucket = this.buckets.get(key);
    if (bucket) {
      bucket.count++;
      bucket.totalMs += ms;
      if (ms > bucket.maxMs) bucket.maxMs = ms;
      bucket.histogram[slot] = (bucket.histogram[slot] ?? 0) + 1;
    } else {
      const histogram = new Array<number>(LATENCY_BOUNDS_MS.length + 1).fill(0);
      histogram[slot] = 1;
      this.addBucket({
        hour: new Date(hourMs),
        method,
        route,
        status: observation.status,
        errorCode,
        count: 1,
        totalMs: ms,
        maxMs: ms,
        histogram,
      });
    }
    if (observation.organizationId) {
      const org = this.orgBuckets.get(`${hourMs}|${observation.organizationId}`);
      if (org) {
        org.count++;
        if (observation.status >= 400) org.errorCount++;
      } else {
        this.addOrgBucket({
          hour: new Date(hourMs),
          organizationId: observation.organizationId,
          count: 1,
          errorCount: observation.status >= 400 ? 1 : 0,
        });
      }
    }

    const minute = Math.floor(atMs / 60_000);
    const seen = this.minutes.get(minute);
    if (seen === undefined) {
      // A new minute: the only time old ones can need pruning.
      for (const m of this.minutes.keys()) if (m < minute - 60) this.minutes.delete(m);
    }
    this.minutes.set(minute, (seen ?? 0) + 1);
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

  /** Writes what has been collected. Calls are serialised. */
  flush(now: Date = new Date(), final = false): Promise<void> {
    const run = this.chain.then(() => this.flushOnce(now, final));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async flushOnce(now: Date, final: boolean): Promise<void> {
    const rows = [...this.buckets.values()];
    const orgRows = [...this.orgBuckets.values()];
    this.buckets = new Map();
    this.orgBuckets = new Map();
    let failure: unknown = null;

    for (let i = 0; i < rows.length; i += ApiMetricsCollector.CHUNK) {
      const chunk = rows.slice(i, i + ApiMetricsCollector.CHUNK);
      try {
        await this.repository.flushApiBuckets(chunk, []);
      } catch (error) {
        failure ??= error;
        for (const row of chunk) this.addBucket(row);
      }
    }
    for (let i = 0; i < orgRows.length; i += ApiMetricsCollector.CHUNK) {
      const chunk = orgRows.slice(i, i + ApiMetricsCollector.CHUNK);
      try {
        await this.repository.flushApiBuckets([], chunk);
      } catch (error) {
        failure ??= error;
        for (const row of chunk) this.addOrgBucket(row);
      }
    }

    const drops = this.unreportedDrops;
    try {
      await this.repository.recordMetricInstance({
        id: this.instanceId,
        startedAt: this.startedAt,
        at: now,
        // Clean only if nothing is left unwritten.
        stopped: final && failure === null,
        droppedRequests: drops,
      });
      this.unreportedDrops -= drops;
    } catch (error) {
      failure ??= error;
    }

    if (failure !== null) {
      this.lastFlushError =
        failure instanceof Error ? failure.message.slice(0, 200) : 'flush failed';
      this.logger.warn(
        { err: failure },
        final
          ? 'Final API metrics flush failed; up to a minute of counts is lost and is reported as such'
          : 'API metrics flush failed; the counts are kept and retried next minute',
      );
      return;
    }
    this.lastFlushAt = now;
    this.lastFlushError = null;

    if (!final && now.getTime() - this.lastRetentionAt > 86_400_000) {
      this.lastRetentionAt = now.getTime();
      try {
        await this.repository.applyRetention({
          hourly: new Date(now.getTime() - RETENTION.hourlyDays * 86_400_000),
          daily: new Date(now.getTime() - RETENTION.dailyDays * 86_400_000),
        });
      } catch (error) {
        this.logger.warn({ err: error }, 'Analytics retention failed; retried tomorrow');
      }
    }
  }

  /** Adds a bucket's counts into memory, or counts them as dropped at the ceiling. */
  private addBucket(row: ApiBucketRow): void {
    const key = `${row.hour.getTime()}|${row.method}|${row.route}|${row.status}|${row.errorCode}`;
    const bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= ApiMetricsCollector.MAX_BUCKETS) {
        this.droppedRequests += row.count;
        this.unreportedDrops += row.count;
        return;
      }
      this.buckets.set(key, { ...row, histogram: [...row.histogram] });
      return;
    }
    bucket.count += row.count;
    bucket.totalMs += row.totalMs;
    bucket.maxMs = Math.max(bucket.maxMs, row.maxMs);
    row.histogram.forEach((v, i) => (bucket.histogram[i] = (bucket.histogram[i] ?? 0) + v));
  }

  private addOrgBucket(row: OrgBucketRow): void {
    const key = `${row.hour.getTime()}|${row.organizationId}`;
    const org = this.orgBuckets.get(key);
    if (!org) {
      this.orgBuckets.set(key, { ...row });
      return;
    }
    org.count += row.count;
    org.errorCount += row.errorCount;
  }
}
