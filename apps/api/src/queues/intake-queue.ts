import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import { AppConfig } from '../common/config/config.module';
import { RedisService } from '../common/redis/redis.service';
import { IntakeSweepService } from '../modules/integrations/intake-processing/intake-sweep.service';
import { deterministicJobId } from './job-context';

export const INTAKE_PROCESSING_QUEUE = 'intake-processing';

/**
 * The intake conversion schedule.
 *
 * ONE repeatable sweep, following the follow-up queue exactly — same
 * connection factory, same `upsertJobScheduler` with a deterministic id so
 * several worker replicas converge on one schedule rather than each adding
 * their own, same close-on-shutdown.
 *
 * What the queue is NOT is the source of truth. It decides when a sweep runs;
 * the intake table decides what is waiting. A job per enquiry would make Redis
 * the authority over whether a customer ever gets called, and a Redis restart
 * would lose enquiries that PostgreSQL still holds perfectly well.
 *
 * TWO gates, and both must be open:
 *
 *   WORKER_ENABLED — this process is the worker, not an API replica. Without
 *   it every replica would sweep, and the whole point of a separate process is
 *   that background work does not compete with request latency.
 *
 *   INTAKE_AUTO_PROCESSING_ENABLED — this deployment has deliberately turned
 *   automatic conversion on. Shipping the code and switching it on are
 *   separate acts, because the first is reversible and the second converts a
 *   backlog of real enquiries into assigned work.
 */
@Injectable()
export class IntakeQueue implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(IntakeQueue.name);

  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly redis: RedisService,
    private readonly sweep: IntakeSweepService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.get('WORKER_ENABLED')) {
      this.logger.log('Intake processing disabled in this process (API mode)');
      return;
    }

    if (!this.config.get('INTAKE_AUTO_PROCESSING_ENABLED')) {
      // Logged rather than silent: an operator who expected conversion to be
      // happening should be able to find out why it is not, and the answer is
      // one flag rather than a debugging session.
      this.logger.log(
        'Automatic intake processing is OFF (INTAKE_AUTO_PROCESSING_ENABLED=false) — ' +
          'enquiries are stored and left for manual conversion',
      );
      return;
    }

    try {
      const connection = this.redis.createQueueConnection();
      this.queue = new Queue(INTAKE_PROCESSING_QUEUE, { connection });

      await this.queue.upsertJobScheduler(
        deterministicJobId(['intake', 'sweep']),
        { every: this.config.get('INTAKE_SWEEP_INTERVAL_SECONDS') * 1000 },
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
        INTAKE_PROCESSING_QUEUE,
        async (job: Job) => {
          const started = Date.now();
          const result = await this.sweep.sweep();

          this.logger.debug(
            { jobId: job.id, durationMs: Date.now() - started, ...result },
            'Intake sweep job finished',
          );

          return result;
        },
        {
          connection: this.redis.createQueueConnection(),
          // One at a time. Concurrent sweeps are safe — every intake is claimed
          // with SKIP LOCKED — but they are also pure waste, because the second
          // finds the first's rows already held.
          concurrency: 1,
        },
      );

      this.worker.on('failed', (job, error) => {
        this.logger.error(
          { jobId: job?.id, attempts: job?.attemptsMade, err: error },
          'Intake sweep job FAILED — website enquiries may be waiting',
        );
      });

      this.worker.on('error', (error) => {
        this.logger.error({ err: error }, 'Intake queue connection error');
      });

      this.logger.log(
        `Intake sweep registered — every ${this.config.get('INTAKE_SWEEP_INTERVAL_SECONDS')}s`,
      );
    } catch (error) {
      /*
       * A worker that cannot reach Redis must not take the process down, and
       * must not lose anything: the enquiries are in PostgreSQL, and the next
       * sweep that does start will find them exactly as they were.
       */
      this.logger.error({ err: error }, 'Could not start the intake queue');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
