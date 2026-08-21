import { Global, Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { PrismaService } from './prisma/prisma.service';
import { RedisService } from './redis/redis.service';
import { TenantContextService } from './tenancy/tenant-context.service';
import { AuditRepository } from './audit/audit.repository';
import { PlatformService } from './platform/platform.service';

/**
 * Cross-cutting infrastructure: configuration, database, cache, tenant context,
 * audit trail.
 *
 * Global so that modules do not each re-import it, and because tenant context in
 * particular must be a single instance — two would mean two AsyncLocalStorage
 * stores and a request could see the wrong tenant.
 */
@Global()
@Module({
  imports: [AppConfigModule],
  providers: [PrismaService, RedisService, TenantContextService, AuditRepository, PlatformService],
  exports: [
    AppConfigModule,
    PrismaService,
    RedisService,
    TenantContextService,
    AuditRepository,
    PlatformService,
  ],
})
export class CommonModule {}
