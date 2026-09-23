import { Module } from '@nestjs/common';
import { AppConfig } from '../../common/config/config.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationsRepository } from './notifications.repository';
import { DevicesController } from './push/devices.controller';
import { DevicesRepository } from './push/devices.repository';
import { PushDispatchService } from './push/push-dispatch.service';
import { PUSH_PROVIDER } from './push/push-provider';
import { FcmPushProvider, UnconfiguredPushProvider } from './push/fcm-push.provider';

/**
 * Notifications and their delivery.
 *
 * The provider is chosen ONCE, here, from configuration. Nothing downstream
 * knows which one it got — the worker, the retention engine and the dispatch
 * service all depend on the interface, so changing provider is a change to this
 * factory and nowhere else.
 *
 * `NotificationsRepository` and `PushDispatchService` are exported so background
 * jobs create and deliver notifications through the same tenant-scoped path an
 * HTTP request would use. A worker must not get its own way to write these.
 */
@Module({
  controllers: [NotificationsController, DevicesController],
  providers: [
    NotificationsService,
    NotificationsRepository,
    DevicesRepository,
    PushDispatchService,
    {
      provide: PUSH_PROVIDER,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => {
        const provider = new FcmPushProvider({
          projectId: config.get('FIREBASE_PROJECT_ID'),
          clientEmail: config.get('FIREBASE_CLIENT_EMAIL'),
          privateKey: config.get('FIREBASE_PRIVATE_KEY'),
        });

        /*
         * Falls back to a provider that REPORTS failure rather than one that
         * silently succeeds. An unconfigured deployment must not look healthy
         * while no salesperson receives anything — the metrics would agree with
         * it and nobody would find out until someone asked why their phone
         * never buzzes.
         */
        return provider.isConfigured() ? provider : new UnconfiguredPushProvider();
      },
    },
  ],
  exports: [NotificationsRepository, PushDispatchService, DevicesRepository],
})
export class NotificationsModule {}
