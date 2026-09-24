import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';

/**
 * Is an organization CRAVION's own, or a customer's?
 *
 * One tiny repository rather than a field on the principal, because the answer
 * decides a privilege and privileges should be read from the database at the
 * moment they are used. A copy on the token or the session would be correct for
 * up to fifteen minutes after it stopped being true.
 *
 * `Organization` IS in TENANT_SCOPED_MODELS, so the read below names the
 * organization id explicitly AND runs under a system scope: the caller is asking
 * about a specific tenant, including — on the platform surface — one that is not
 * their own. Every use is therefore an audited system read of a single non-
 * business column, never a way to see another tenant's data.
 */
@Injectable()
export class OrganizationTypeRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Whether this organization is the platform operator.
   *
   * Absent or soft-deleted reads as false. "I could not find it" must never
   * answer "yes, that is CRAVION" — the safe default for a privilege question
   * is no.
   */
  async isInternal(organizationId: string): Promise<boolean> {
    const organization = await this.tenantContext.runAsSystem(
      'entitlement: read one organization type',
      () =>
        this.prisma.client.organization.findFirst({
          where: { id: organizationId, deletedAt: null },
          select: { organizationType: true },
        }),
    );

    return organization?.organizationType === 'INTERNAL';
  }

  /**
   * The platform organization, if one has been bootstrapped.
   *
   * At most one row can be INTERNAL — a partial unique index says so — which is
   * why this returns a single value rather than a list.
   */
  async findPlatformOrganization(): Promise<{ id: string; name: string; slug: string } | null> {
    return this.tenantContext.runAsSystem('platform: locate the internal organization', () =>
      this.prisma.client.organization.findFirst({
        where: { organizationType: 'INTERNAL', deletedAt: null },
        select: { id: true, name: true, slug: true },
      }),
    );
  }
}
