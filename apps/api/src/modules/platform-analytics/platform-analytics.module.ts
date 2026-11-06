import {
  Global,
  Module,
  RequestMethod,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { ActivityTrackerService } from './activity-tracker.service';
import { AdminAnalyticsController } from './admin-analytics.controller';
import { AdminAnalyticsService } from './admin-analytics.service';
import { AnalyticsReadsRepository } from './analytics-reads.repository';
import { ApiMetricsCollector } from './api-metrics.collector';
import { ApiMetricsMiddleware } from './api-metrics.middleware';
import { PlatformAnalyticsRepository } from './platform-analytics.repository';
import { WebAnalyticsController } from './web-analytics.controller';

/**
 * Platform analytics: user activity, API metrics, public-website analytics,
 * and the signed read-only API the CRAVION Admin "LeadFlow Analytics" module
 * reads them through.
 *
 * Global so the authentication guard (registered in AppModule) can record
 * activity without a module cycle.
 */
@Global()
@Module({
  controllers: [WebAnalyticsController, AdminAnalyticsController],
  providers: [
    PlatformAnalyticsRepository,
    AnalyticsReadsRepository,
    ActivityTrackerService,
    ApiMetricsCollector,
    AdminAnalyticsService,
  ],
  exports: [ActivityTrackerService, ApiMetricsCollector],
})
export class PlatformAnalyticsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Express 5 / path-to-regexp v8 wildcard syntax: every route.
    consumer.apply(ApiMetricsMiddleware).forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
