import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
import { stripUndefined } from '../../common/utils/strip-undefined';

/**
 * The `Organization` model is scoped by its own primary key (see
 * TENANT_SCOPED_MODELS), so `findFirst()` with no filter returns the caller's
 * own organization and nothing else. Passing another organization's id yields
 * nothing rather than that organization's row.
 */
@Injectable()
export class OrganizationsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async findCurrent() {
    return this.prisma.client.organization.findFirst({ include: { settings: true } });
  }

  async updateCurrent(changes: {
    name?: string | undefined;
    timezone?: string | undefined;
    currency?: string | undefined;
    locale?: string | undefined;
    country?: string | undefined;
    settings?:
      | {
          followupReminderMinutes?: number | undefined;
          followupOverdueMinutes?: number | undefined;
          escalateToManager?: boolean | undefined;
          workingHoursStart?: string | undefined;
          workingHoursEnd?: string | undefined;
          leadSources?: string[] | undefined;
        }
      | undefined;
  }) {
    const organizationId = this.tenantContext.requireOrganizationId();

    return this.prisma.client.$transaction(async (tx) => {
      const organizationChanges: Record<string, unknown> = {};
      // Listed explicitly rather than spread, so a future field on the DTO is
      // never persisted by accident just because it was added to the type.
      for (const field of ['name', 'timezone', 'currency', 'locale', 'country'] as const) {
        if (changes[field] !== undefined) organizationChanges[field] = changes[field];
      }

      if (Object.keys(organizationChanges).length > 0) {
        await tx.organization.update({ where: { id: organizationId }, data: organizationChanges });
      }

      if (changes.settings && Object.keys(changes.settings).length > 0) {
        const settings = stripUndefined(changes.settings);
        await tx.organizationSettings.upsert({
          where: { organizationId },
          create: { organizationId, ...settings },
          update: settings,
        });
      }

      return tx.organization.findFirst({ include: { settings: true } });
    });
  }
}
