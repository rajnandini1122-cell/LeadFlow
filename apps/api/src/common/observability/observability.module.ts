import { Global, Module } from '@nestjs/common';
import { AppConfig } from '../config/config.module';
import { ErrorReporter } from './error-reporter';
import { MetricsService } from './metrics.service';
import { WorkerHeartbeatService } from './worker-heartbeat.service';

/**
 * Production observability.
 *
 * Global, because the exception filter and the queue both need it and neither
 * is a normal feature module. Small on purpose — the autopsy's finding was that
 * observability scored 3/10, not that it needed a platform.
 */
@Global()
@Module({
  providers: [
    MetricsService,
    /*
     * Registered in BOTH processes, doing opposite jobs from one class: the
     * worker writes the heartbeat, the API reads it. Which role a process
     * plays is decided by WORKER_ENABLED inside the service, not by wiring it
     * into two different modules — one class means the writer and the reader
     * cannot disagree about the key, the shape, or the staleness threshold.
     */
    WorkerHeartbeatService,
    {
      provide: ErrorReporter,
      inject: [AppConfig],
      useFactory: (config: AppConfig) =>
        new ErrorReporter(
          config.get('NODE_ENV'),
          /*
           * The release, for grouping errors by deploy.
           *
           * Read from the environment rather than package.json: what matters is
           * which BUILD is running, and two deploys of the same version number
           * are different builds. Falls back to 'unknown', which is honest —
           * better than a version string that is the same for every deploy.
           */
          // Now a validated config key rather than a raw env read, and
          // REQUIRED in production — errors that cannot be grouped by deploy
          // make a regression indistinguishable from three-month-old noise.
          config.get('RELEASE_SHA') ?? 'unknown',
        ),
    },
  ],
  exports: [MetricsService, ErrorReporter, WorkerHeartbeatService],
})
export class ObservabilityModule {}
