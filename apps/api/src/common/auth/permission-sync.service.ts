import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { PermissionSyncRepository } from './permission-sync.repository';

/**
 * Reconciles the permission catalogue at boot.
 *
 * A release that adds a permission previously granted it to nobody: the seed
 * populates `permissions` and `role_permissions` once, so every existing
 * organization got a 403 on the new feature while the whole test suite stayed
 * green — tests seed fresh from the current matrix, production does not.
 *
 * Running on every boot rather than as a migration keeps ONE source of truth.
 * The matrix lives in TypeScript; a SQL migration would be a second copy of it,
 * and the two would drift the first time somebody edited only one.
 */
@Injectable()
export class PermissionSyncService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PermissionSyncService.name);

  constructor(private readonly repository: PermissionSyncRepository) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const result = await this.repository.sync();

      if (result.permissionsAdded || result.grantsAdded || result.grantsRemoved) {
        this.logger.log(result, 'Permission catalogue reconciled');
      }
    } catch (error) {
      /*
       * Never fatal.
       *
       * A database that is briefly unreachable at boot must not stop the
       * process from starting and serving the requests it can — and the next
       * restart reconciles anyway. Logged at error level so a persistently
       * failing sync is visible, because the symptom otherwise is a 403 nobody
       * can explain.
       */
      this.logger.error({ err: error }, 'Could not reconcile the permission catalogue');
    }
  }
}
