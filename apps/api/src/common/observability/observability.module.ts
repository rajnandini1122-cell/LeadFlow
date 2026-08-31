import { Global, Module } from '@nestjs/common';
import { AppConfig } from '../config/config.module';
import { ErrorReporter } from './error-reporter';
import { MetricsService } from './metrics.service';

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
          process.env['RELEASE_SHA'] ?? 'unknown',
        ),
    },
  ],
  exports: [MetricsService, ErrorReporter],
})
export class ObservabilityModule {}
