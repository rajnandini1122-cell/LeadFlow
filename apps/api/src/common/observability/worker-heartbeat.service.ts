import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../config/config.module';
import { RedisService } from '../redis/redis.service';
import { MetricsService } from './metrics.service';

/**
 * Is the worker alive?
 *
 * The worker owns follow-up reminders — the whole "no lead left behind"
 * promise — and it is the one process that cannot be asked. It binds no port
 * (`createApplicationContext` starts the container without an HTTP listener),
 * so nothing can probe it, and a dead sweep is SILENT: no error, no log, no
 * failed request. The first evidence is a customer who was never called.
 *
 * Metrics alone could not answer this. They live in the memory of the process
 * that recorded them, so the worker's sweep timestamp sat in the worker while
 * `/api/metrics` was served by the API — which therefore reported the worker's
 * state as null forever, whether it was healthy or gone.
 *
 * REDIS IS THE AUTHORITY, for three reasons that all matter:
 *
 *   it is already mandatory shared infrastructure — both processes connect to
 *   it, so this adds no dependency and no new failure mode;
 *
 *   TTL expiry is the crash behaviour, and it is free. A worker that dies
 *   writes nothing more and the key evaporates on its own. Nothing has to
 *   notice the death, which is the part a database table would get wrong —
 *   a row saying "healthy" outlives the process that wrote it;
 *
 *   it survives an API restart, because it is not the API's memory.
 */
@Injectable()
export class WorkerHeartbeatService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WorkerHeartbeatService.name);
  private timer: NodeJS.Timeout | undefined;

  /** This process, so a heartbeat says WHICH worker is alive. */
  private readonly workerId = randomUUID();
  private readonly startedAt = new Date().toISOString();

  constructor(
    private readonly config: AppConfig,
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    /*
     * Only the worker beats. An API replica reads this key; if it also wrote
     * it, the heartbeat would report "a worker is alive" on a deployment whose
     * worker had never started — the exact false green this exists to remove.
     */
    if (!this.config.get('WORKER_ENABLED')) return;

    // Immediately, then on the interval. Waiting a full interval first would
    // leave a freshly deployed worker indistinguishable from a dead one.
    await this.beat();

    this.timer = setInterval(() => {
      void this.beat();
    }, HEARTBEAT_INTERVAL_SECONDS * 1000);

    // Never hold the process open. A shutting-down worker should exit when its
    // work is done, not when a timer next fires.
    this.timer.unref();

    this.logger.log(`Worker heartbeat started (every ${HEARTBEAT_INTERVAL_SECONDS}s)`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One beat.
   *
   * Never throws. A Redis blip must not take down the worker whose job is
   * reminding salespeople — the heartbeat is how we OBSERVE that work, not a
   * precondition for doing it. A failed write simply means the key ages, and
   * if the blip outlasts the TTL the worker reports as unavailable, which is
   * honest: we genuinely cannot confirm it is alive.
   */
  private async beat(): Promise<void> {
    const beat: WorkerHeartbeat = {
      workerId: this.workerId,
      startedAt: this.startedAt,
      beatAt: new Date().toISOString(),
      lastSweepAt: this.metrics.lastSweep,
    };

    try {
      await this.redis.setJson(HEARTBEAT_KEY, beat, HEARTBEAT_TTL_SECONDS);
    } catch (error) {
      this.logger.warn({ err: error }, 'Worker heartbeat write failed');
    }
  }

  /**
   * What the API can say about the worker right now.
   *
   * Three states, and the difference between the last two is worth keeping.
   * MISSING means nothing is there — the worker is gone long enough for the
   * TTL to have collected it, or it never ran. STALE means a heartbeat exists
   * but has stopped advancing, which is the shape of a worker that is running
   * and wedged rather than dead. They call for different first questions.
   */
  async read(now: Date = new Date()): Promise<WorkerHealth> {
    let beat: WorkerHeartbeat | null = null;

    try {
      beat = await this.redis.getJson<WorkerHeartbeat>(HEARTBEAT_KEY);
    } catch {
      // Unreachable Redis is reported as unknown rather than as a dead worker.
      // /readiness already fails on Redis itself, and saying "the worker died"
      // when the truth is "we cannot see" sends somebody to the wrong process.
      return { status: 'UNKNOWN', workerId: null, beatAt: null, lastSweepAt: null, ageSeconds: null };
    }

    if (!beat) {
      return { status: 'MISSING', workerId: null, beatAt: null, lastSweepAt: null, ageSeconds: null };
    }

    const ageSeconds = Math.max(0, Math.round((now.getTime() - Date.parse(beat.beatAt)) / 1000));

    return {
      status: ageSeconds > HEARTBEAT_STALE_AFTER_SECONDS ? 'STALE' : 'HEALTHY',
      workerId: beat.workerId,
      beatAt: beat.beatAt,
      lastSweepAt: beat.lastSweepAt,
      ageSeconds,
    };
  }
}

/** What the worker writes. */
export interface WorkerHeartbeat {
  workerId: string;
  startedAt: string;
  beatAt: string;
  /** Null until the first sweep completes — a worker that is up but has not swept yet. */
  lastSweepAt: string | null;
}

/** What the API reports. */
export interface WorkerHealth {
  status: 'HEALTHY' | 'STALE' | 'MISSING' | 'UNKNOWN';
  workerId: string | null;
  beatAt: string | null;
  lastSweepAt: string | null;
  ageSeconds: number | null;
}

/**
 * One key, because there is exactly one worker replica by design.
 *
 * If that ever changes, the last writer wins and the heartbeat answers "a
 * worker is alive" rather than "all of them are" — which is still the right
 * answer to the question being asked here. Per-replica keys would be a
 * different feature, and would need a different question to justify it.
 */
export const HEARTBEAT_KEY = 'leadflow:worker:heartbeat';

/** How often the worker writes. */
export const HEARTBEAT_INTERVAL_SECONDS = 30;

/**
 * How long a beat survives without being refreshed.
 *
 * Three intervals. One would make a single slow write look like a death, and
 * an alert that cries wolf is an alert that gets muted — which costs more than
 * the ninety seconds it saves.
 */
export const HEARTBEAT_TTL_SECONDS = HEARTBEAT_INTERVAL_SECONDS * 3;

/**
 * When a present heartbeat counts as stale.
 *
 * Two intervals — tighter than the TTL on purpose, so a wedged worker is
 * reported as STALE for a while before the key expires and it becomes MISSING.
 * That window is what lets an operator tell "stopped beating" from "gone".
 */
export const HEARTBEAT_STALE_AFTER_SECONDS = HEARTBEAT_INTERVAL_SECONDS * 2;
