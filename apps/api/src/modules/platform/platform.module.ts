import { Module } from '@nestjs/common';
import { PlatformAdminController } from './platform-admin.controller';
import { PlatformAdminRepository } from './platform-admin.repository';
import { PlatformAdminService } from './platform-admin.service';

/**
 * CRAVION's platform console.
 *
 * Deliberately its own module rather than endpoints bolted onto the
 * organizations module. The boundary is the feature: everything in here crosses
 * tenants, and keeping it in one place is what makes "show me every
 * cross-tenant operation in the codebase" a directory listing rather than a
 * search.
 */
@Module({
  controllers: [PlatformAdminController],
  providers: [PlatformAdminService, PlatformAdminRepository],
})
export class PlatformModule {}
