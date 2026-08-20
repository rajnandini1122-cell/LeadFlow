import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import { AppConfig } from '../config/config.module';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { createTenantScopeExtension } from './tenant-scope.extension';

/**
 * The single Prisma entrypoint.
 *
 * Only *.repository.ts files may inject this — enforced by an ESLint
 * no-restricted-imports rule, so business logic cannot reach around the
 * repository layer and escape tenant scoping.
 *
 * Prisma 7 removed the Rust query engine: a driver adapter is now mandatory and
 * the connection string is supplied here rather than in schema.prisma.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  /** Tenant-scoped client. Use this for all tenant-owned data. */
  readonly client: ReturnType<PrismaService['buildClient']>;

  private readonly base: PrismaClient;

  constructor(
    private readonly config: AppConfig,
    private readonly tenantContext: TenantContextService,
  ) {
    const adapter = new PrismaPg({
      connectionString: this.config.get('DATABASE_URL'),
      max: this.config.get('DATABASE_POOL_MAX'),
    });

    this.base = new PrismaClient({
      adapter,
      log: this.config.isDevelopment ? ['warn', 'error'] : ['error'],
    });

    this.client = this.buildClient();
  }

  private buildClient() {
    return this.base.$extends(
      createTenantScopeExtension({
        getOrganizationId: () => this.tenantContext.organizationId,
        isSystem: () => this.tenantContext.isSystem,
      }),
    );
  }

  async onModuleInit(): Promise<void> {
    await this.base.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.base.$disconnect();
  }

  /**
   * Readiness probe. Counts a small, non-tenant table on the UNEXTENDED client
   * so the check needs no tenant context and cannot trip the scoping guard.
   */
  async ping(): Promise<boolean> {
    try {
      await this.base.permission.count();
      return true;
    } catch (error) {
      this.logger.error('Database readiness check failed', error as Error);
      return false;
    }
  }
}
