import { Injectable } from '@nestjs/common';

/**
 * The four things worth measuring, and nothing else.
 *
 * The autopsy's guidance was explicit: avoid metric explosion. A dashboard with
 * two hundred series is one nobody reads, and an alert on every one of them is
 * a pager nobody answers. These are the families that actually change what you
 * do at 3am — request health, database health, worker health, notification
 * health.
 *
 * Deliberately in-process and dependency-free. A Prometheus client would be the
 * next step, but adding one before there is anything scraping it is
 * infrastructure without a consumer. The shape here is already the shape a
 * scraper wants, so that step is a transport change rather than a rewrite.
 *
 * Counters reset when the process does. That is correct for counters — a
 * scraper computes rates from deltas and handles restarts — and it is why
 * nothing here tries to persist.
 */
@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();

  /**
   * Request latencies, as a bounded ring.
   *
   * A fixed window rather than every sample ever seen: p95 over the last
   * thousand requests is the number that describes how the service is behaving
   * now, and an unbounded array would be a memory leak dressed as telemetry.
   */
  private readonly latencies: number[] = [];
  private static readonly LATENCY_WINDOW = 1000;

  private readonly startedAt = Date.now();

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  observeLatency(milliseconds: number): void {
    this.latencies.push(milliseconds);
    if (this.latencies.length > MetricsService.LATENCY_WINDOW) {
      this.latencies.shift();
    }
  }

  /**
   * A percentile over the current window.
   *
   * Returns null when there is nothing to compute from — the same discipline
   * the KPI layer follows. A p95 of 0 for a service that has served no requests
   * says something false about it.
   */
  percentile(p: number): number | null {
    if (this.latencies.length === 0) return null;

    const sorted = [...this.latencies].sort((a, b) => a - b);
    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
    );

    return sorted[index] ?? null;
  }

  private readonly pushLatencies: number[] = [];

  /**
   * Push round-trip time, in its own window.
   *
   * Kept separate from request latency: a slow provider and a slow API are
   * different problems with different owners, and averaging them together
   * hides both.
   */
  observePushLatency(milliseconds: number): void {
    this.pushLatencies.push(milliseconds);
    if (this.pushLatencies.length > MetricsService.LATENCY_WINDOW) {
      this.pushLatencies.shift();
    }
  }

  pushP95(): number | null {
    if (this.pushLatencies.length === 0) return null;
    const sorted = [...this.pushLatencies].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1));
    return sorted[index] ?? null;
  }

  counter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  /** Everything, in the shape a scraper or a health page wants. */
  snapshot(): {
    uptimeSeconds: number;
    api: { requests: number; errors: number; errorRate: number | null; p95Ms: number | null };
    database: { queryFailures: number };
    worker: { sweeps: number; failures: number; lastSweepAt: string | null };
    push: {
      attempts: number;
      delivered: number;
      failed: number;
      invalidTokens: number;
      registrations: number;
      p95Ms: number | null;
    };
    notifications: { created: number; suppressed: number };
  } {
    const requests = this.counter(METRIC.API_REQUESTS);
    const errors = this.counter(METRIC.API_ERRORS);

    return {
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      api: {
        requests,
        errors,
        // Null rather than 0 for a service that has served nothing yet.
        errorRate: requests === 0 ? null : errors / requests,
        p95Ms: this.percentile(95),
      },
      database: { queryFailures: this.counter(METRIC.DB_QUERY_FAILURES) },
      worker: {
        sweeps: this.counter(METRIC.WORKER_SWEEPS),
        failures: this.counter(METRIC.WORKER_FAILURES),
        lastSweepAt: this.lastSweepAt,
      },
      push: {
        attempts: this.counter('push.attempt'),
        delivered: this.counter('push.success'),
        failed: this.counter('push.failure'),
        // Rising steadily means devices are going stale faster than they are
        // re-registering, which is a client problem rather than a push one.
        invalidTokens: this.counter('push.invalid_token'),
        registrations: this.counter('push.registrations'),
        p95Ms: this.pushP95(),
      },
      notifications: {
        created: this.counter(METRIC.NOTIFICATIONS_CREATED),
        // The count of retries that correctly did nothing. Worth watching:
        // if this is zero forever, idempotency is never being exercised, and
        // if it dwarfs `created`, something is looping.
        suppressed: this.counter(METRIC.NOTIFICATIONS_SUPPRESSED),
      },
    };
  }

  private lastSweepAt: string | null = null;

  recordSweep(result: { failures: number }): void {
    this.increment(METRIC.WORKER_SWEEPS);
    if (result.failures > 0) this.increment(METRIC.WORKER_FAILURES, result.failures);
    this.lastSweepAt = new Date().toISOString();
  }
}

/** Metric names, in one place so a typo cannot silently create a new series. */
export const METRIC = {
  API_REQUESTS: 'api.requests',
  API_ERRORS: 'api.errors',
  DB_QUERY_FAILURES: 'database.query_failures',
  WORKER_SWEEPS: 'worker.sweeps',
  WORKER_FAILURES: 'worker.failures',
  NOTIFICATIONS_CREATED: 'notifications.created',
  NOTIFICATIONS_SUPPRESSED: 'notifications.suppressed',
} as const;
