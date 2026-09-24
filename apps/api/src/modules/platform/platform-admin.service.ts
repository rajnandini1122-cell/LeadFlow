import { Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES, type PlatformOrganizationView } from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import { AUDIT_ACTIONS, AuditRepository } from '../../common/audit/audit.repository';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
import { PlatformAdminRepository, type PlatformOrganizationRow } from './platform-admin.repository';

/**
 * CRAVION operating the platform.
 *
 * Every method here is a cross-tenant act, and each one is audited against the
 * TARGET organization as well as the actor — so a customer reading their own
 * audit history can see that the platform operator suspended them, and who.
 * An administrative action nobody can see afterwards is the kind that gets
 * disputed.
 */
@Injectable()
export class PlatformAdminService {
  private readonly logger = new Logger(PlatformAdminService.name);

  constructor(
    private readonly repository: PlatformAdminRepository,
    private readonly audit: AuditRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  async listOrganizations(): Promise<PlatformOrganizationView[]> {
    const rows = await this.repository.listOrganizations();
    return rows.map(toView);
  }

  /**
   * One organization.
   *
   * Reading a specific tenant is audited, unlike listing them. Opening the
   * console is routine; looking up one named customer is the thing somebody
   * might later ask about, and the record of it costs one row.
   */
  async findOrganization(organizationId: string): Promise<PlatformOrganizationView> {
    const row = await this.requireOrganization(organizationId);

    await this.audit.record({
      action: AUDIT_ACTIONS.PLATFORM_ORGANIZATION_VIEWED,
      // The TARGET tenant, not the actor's. This row belongs in the history of
      // the organization that was looked at.
      organizationId,
      entityType: 'Organization',
      entityId: organizationId,
      after: { platformRole: 'PLATFORM_OWNER' },
    });

    return toView(row);
  }

  async suspendOrganization(organizationId: string): Promise<PlatformOrganizationView> {
    return this.setStatus(organizationId, 'SUSPENDED');
  }

  async reactivateOrganization(organizationId: string): Promise<PlatformOrganizationView> {
    return this.setStatus(organizationId, 'ACTIVE');
  }

  private async setStatus(
    organizationId: string,
    status: 'ACTIVE' | 'SUSPENDED',
  ): Promise<PlatformOrganizationView> {
    const before = await this.requireOrganization(organizationId);

    if (before.organizationType === 'INTERNAL') {
      /*
       * Refused in words as well as in the WHERE clause.
       *
       * The repository would change zero rows anyway, but an operator who tried
       * deserves to be told why rather than shown a silent no-op — and the
       * reason is worth stating: suspending the platform organization locks
       * CRAVION out of the console it would need in order to undo it.
       */
      throw AppException.validation('The platform organization cannot be suspended.', {
        organizationId: ['this is CRAVION’s own organization'],
      });
    }

    const changed = await this.repository.setCustomerStatus(organizationId, status);

    if (changed === 0) {
      // Already in that state. Reported rather than treated as success: a
      // no-op that answers 200 hides a double-click and a stale console.
      throw AppException.validation(`This organization is already ${status.toLowerCase()}.`, {
        status: [`no change — it is already ${status.toLowerCase()}`],
      });
    }

    await this.audit.record({
      action:
        status === 'SUSPENDED'
          ? AUDIT_ACTIONS.PLATFORM_ORGANIZATION_SUSPENDED
          : AUDIT_ACTIONS.PLATFORM_ORGANIZATION_REACTIVATED,
      organizationId,
      entityType: 'Organization',
      entityId: organizationId,
      before: { status: before.status },
      after: { status, platformRole: 'PLATFORM_OWNER' },
    });

    this.logger.log(
      { organizationId, status, actorUserId: this.tenantContext.userId },
      'Platform operator changed an organization status',
    );

    return toView(await this.requireOrganization(organizationId));
  }

  private async requireOrganization(organizationId: string): Promise<PlatformOrganizationRow> {
    const row = await this.repository.findOrganization(organizationId);
    if (!row) {
      throw AppException.notFound(ERROR_CODES.ORGANIZATION_NOT_FOUND, 'Organization not found.');
    }

    return row;
  }
}

function toView(row: PlatformOrganizationRow): PlatformOrganizationView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    organizationType: row.organizationType as PlatformOrganizationView['organizationType'],
    country: row.country,
    createdAt: row.createdAt.toISOString(),
    memberCount: row._count.memberships,
    leadCount: row._count.leads,
    /*
     * Entitlement as one word, derived here rather than re-derived by a client.
     *
     * The internal organization reports PLATFORM_INTERNAL and no subscription,
     * which is the honest answer: there is no plan and no payment. A customer
     * reports its subscription status and plan code.
     */
    entitlement:
      row.organizationType === 'INTERNAL'
        ? { source: 'PLATFORM_INTERNAL', subscriptionStatus: null, planCode: null }
        : {
            source: 'CUSTOMER_SUBSCRIPTION',
            subscriptionStatus: row.subscription?.status ?? null,
            planCode: row.subscription?.plan.code ?? null,
          },
  };
}
