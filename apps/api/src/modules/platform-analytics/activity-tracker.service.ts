import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { analyticsDay } from './analytics-time';
import { PlatformAnalyticsRepository } from './platform-analytics.repository';

/**
 * "Last active" and daily activity, from authenticated requests.
 *
 * Called by the authentication guard on EVERY authenticated request, so it
 * must be cheap and must never fail the request:
 *   * at most one write per user per organization per minute (and on the first
 *     request of each analytics day), whatever the number of tabs or devices;
 *   * the write is fire-and-forget; an error is logged and dropped.
 *
 * The throttle is per process. LeadFlow runs one API replica; with more, each
 * would write at most once a minute -- still bounded.
 */
@Injectable()
export class ActivityTrackerService implements OnModuleInit {
  static readonly WRITE_EVERY_MS = 60_000;
  private static readonly MAX_ENTRIES = 10_000;

  private readonly logger = new Logger(ActivityTrackerService.name);
  private readonly lastWrite = new Map<string, { at: number; day: number }>();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly repository: PlatformAnalyticsRepository) {}

  onModuleInit(): void {
    // Writes already started finish before the database disconnects.
    this.repository.beforeDisconnect(() => this.settle());
  }

  touch(userId: string, organizationId: string, now: Date = new Date()): void {
    const key = `${userId}:${organizationId}`;
    const day = analyticsDay(now);
    const previous = this.lastWrite.get(key);
    if (
      previous &&
      previous.day === day.getTime() &&
      now.getTime() - previous.at < ActivityTrackerService.WRITE_EVERY_MS
    ) {
      return;
    }
    this.lastWrite.set(key, { at: now.getTime(), day: day.getTime() });
    if (this.lastWrite.size > ActivityTrackerService.MAX_ENTRIES) this.prune(now);

    const write = this.repository
      .touchActivity(userId, organizationId, now, day)
      .catch((error: unknown) => {
        this.logger.warn({ err: error }, 'Could not record user activity (request unaffected)');
      })
      .finally(() => this.inFlight.delete(write));
    this.inFlight.add(write);
  }

  /** Waits for writes already started. For tests and orderly shutdown. */
  async settle(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }

  private prune(now: Date): void {
    for (const [key, entry] of this.lastWrite) {
      if (now.getTime() - entry.at > ActivityTrackerService.WRITE_EVERY_MS)
        this.lastWrite.delete(key);
    }
  }
}
