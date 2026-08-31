import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationsRepository } from './notifications.repository';

/**
 * Notifications.
 *
 * The repository is exported so background jobs can create notifications
 * through the same tenant-scoped path an HTTP request would use — a worker
 * must not get its own way to write these.
 */
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsRepository],
  exports: [NotificationsRepository],
})
export class NotificationsModule {}
