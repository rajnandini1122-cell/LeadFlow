import { Module, type OnApplicationBootstrap, type OnModuleDestroy, Logger } from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import { Injectable } from '@nestjs/common';
import { AppConfig } from '../common/config/config.module';
import { RedisService } from '../common/redis/redis.service';
import { NotificationsModule } from '../modules/notifications/notifications.module';
import { FollowUpSweepService } from './follow-up-sweep.service';
import { FollowUpSweepRepository } from './follow-up-sweep.repository';
import { deterministicJobId } from './job-context';

export const FOLLOW_UP_QUEUE = 'follow-ups';

/**
 * The follow-up queue.
 *
 * BullMQ was already a pinned dependency with a purpose-built connection
 * factory on RedisService — the queue foundation was scaffolded and never
 * wired. This wires it rather than introducing a second mechanism.
 *
 * The queue carries ONE repeatable job. That is deliberate: this is not a
 * workflow engine, and it must not become one by accretion. Three hard-coded
 * behaviours (remind, mark overdue, escalate) are what an SME sales team
 * actually wants, and they ship. A generic trigger/condition/action engine is
 * months of work against no evidence about which workflows matter.
 */
@Injectable()
export class FollowUpQueue implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(FollowUpQueue.name);

  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly redis: RedisService,
    private readonly sweep: FollowUpSweepService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    /*
     * Only the worker process runs processors.
     *
     * The API and the worker are built from the same image, so without this
     * every API replica would also sweep — three replicas meaning three
     * concurrent sweeps. The idempotency markers would hold, but the wasted
     * queries would not, and the whole point of a separate process is that
     * background work does not compete with request latency.
     */
    if (!this.config.get('WORKER_ENABLED')) {
      this.logger.log('Queue processors disabled in this process (API mode)');
      return;
    }

    try {
      const connection = this.redis.createQueueConnection();

      this.queue = new Queue(FOLLOW_UP_QUEUE, { connection });

      /*
       * A job SCHEDULER with a deterministic id.
       *
       * BullMQ 6 replaced repeatable jobs on add() with upsertJobScheduler, and
       * the semantics are better for this: upsert means every worker replica
       * that boots converges on ONE schedule rather than each adding its own.
       * Two replicas starting simultaneously produce one sweep, not two.
       *
       * This is the first of two independent idempotency layers; the unique
       * index on the notification dedupe key is the second.
       */
      await this.queue.upsertJobScheduler(
        deterministicJobId(['followups', 'sweep']),
        { every: this.config.get('FOLLOW_UP_SWEEP_INTERVAL_SECONDS') * 1000 },
        {
          name: 'sweep',
          opts: {
            removeOnComplete: 50,
            // Kept, so a failure is visible rather than silently discarded.
            removeOnFail: 200,
          },
        },
      );

      this.worker = new Worker(
        FOLLOW_UP_QUEUE,
        async (job: Job) => {
          const started = Date.now();
          const result = await this.sweep.sweep();

          this.logger.debug(
            { jobId: job.id, durationMs: Date.now() - started, ...result },
            'Follow-up sweep job finished',
          );

          return result;
        },
        {
          connection: this.redis.createQueueConnection(),
          // One at a time. Concurrent sweeps are safe by construction, but
          // they are also pure waste — every one after the first finds the
          // markers already claimed.
          concurrency: 1,
        },
      );

      this.worker.on('failed', (job, error) => {
        this.logger.error(
          { jobId: job?.id, attempts: job?.attemptsMade, err: error },
          'Follow-up sweep job FAILED — reminders may be delayed',
        );
      });

      this.worker.on('error', (error) => {
        this.logger.error({ err: error }, 'Follow-up queue connection error');
      });

      this.logger.log(
        `Follow-up sweep registered — every ${this.config.get('FOLLOW_UP_SWEEP_INTERVAL_SECONDS')}s`,
      );
    } catch (error) {
      /*
       * A worker that cannot reach Redis must not take the process down: the
       * API half of the same image still serves traffic. Logged at error level
       * so monitoring sees it, because a silently dead sweep is the failure
       * this whole feature exists to prevent.
       */
      this.logger.error({ err: error }, 'Could not start the follow-up queue');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}

@Module({
  imports: [NotificationsModule],
  providers: [FollowUpQueue, FollowUpSweepService, FollowUpSweepRepository],
  exports: [FollowUpSweepService],
})
export class QueuesModule {}
