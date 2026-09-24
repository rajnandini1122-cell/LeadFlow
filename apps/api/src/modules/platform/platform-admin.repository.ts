import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';

/**
 * The ONLY sanctioned cross-tenant read path, and deliberately a narrow one.
 *
 * Holding a `platform.*` permission does not widen the Prisma tenant scope. A
 * PLATFORM_OWNER's ordinary requests go through the same extension as everybody
 * else's and see only the organization their token is scoped to — CRAVION's own.
 * That is the point: if platform privilege loosened the scoper, then every
 * repository in the application would silently become cross-tenant for one
 * caller, and a bug in any of them would leak a customer's leads.
 *
 * So crossing the boundary is explicit, lives here, and is visible in the code
 * that does it. Each method states its system scope with a reason, which the
 * tenancy layer requires.
 *
 * WHAT THIS MAY READ. Organization identity and lifecycle: name, slug, status,
 * type, created date, counts. NOT leads, contacts, accounts, activities,
 * messages or any other customer business record. A platform operator needs to
 * know that a tenant exists, whether it is active and how large it is, in order
 * to run the platform. Reading their pipeline is a different act with a
 * different justification, and nothing here provides it.
 */
@Injectable()
export class PlatformAdminRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Every organization, as the platform operator sees them.
   *
   * Counts rather than contents. `_count` gives the operator the size of a
   * tenant — for support, for capacity, for spotting an account that has
   * stopped being used — without a single business row crossing the boundary.
   */
  async listOrganizations(): Promise<PlatformOrganizationRow[]> {
    return this.tenantContext.runAsSystem(
      'platform admin: list organizations for the platform console',
      () =>
        this.prisma.client.organization.findMany({
          where: { deletedAt: null },
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
            organizationType: true,
            country: true,
            createdAt: true,
            _count: { select: { memberships: true, leads: true } },
            subscription: {
              select: { status: true, trialEndsAt: true, plan: { select: { code: true } } },
            },
          },
          // Internal first, then newest. An operator opening this list is
          // usually looking at the most recent signups.
          orderBy: [{ organizationType: 'desc' }, { createdAt: 'desc' }],
        }),
    );
  }

  /** One organization's identity and lifecycle. Never its business data. */
  async findOrganization(organizationId: string): Promise<PlatformOrganizationRow | null> {
    return this.tenantContext.runAsSystem('platform admin: read one organization', () =>
      this.prisma.client.organization.findFirst({
        where: { id: organizationId, deletedAt: null },
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          organizationType: true,
          country: true,
          createdAt: true,
          _count: { select: { memberships: true, leads: true } },
          subscription: {
            select: { status: true, trialEndsAt: true, plan: { select: { code: true } } },
          },
        },
      }),
    );
  }

  /**
   * Suspends or reactivates a customer organization.
   *
   * `organizationType: 'CUSTOMER'` is in the WHERE clause, not checked
   * beforehand. The platform operator must not be able to suspend the platform
   * organization — including its own — and expressing that as part of the
   * update means a zero-row result rather than a check somebody can reorder.
   * Locking CRAVION out of its own console is not a mistake worth leaving
   * available.
   *
   * Returns the number of rows changed, so the caller can tell "already in that
   * state" from "not a customer organization" by asking afterwards.
   */
  async setCustomerStatus(
    organizationId: string,
    status: 'ACTIVE' | 'SUSPENDED',
  ): Promise<number> {
    const result = await this.tenantContext.runAsSystem(
      `platform admin: set organization status to ${status}`,
      () =>
        this.prisma.client.organization.updateMany({
          where: { id: organizationId, organizationType: 'CUSTOMER', deletedAt: null },
          data: { status },
        }),
    );

    return result.count;
  }
}

/** What the platform console is allowed to know about an organization. */
export interface PlatformOrganizationRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  organizationType: string;
  country: string;
  createdAt: Date;
  _count: { memberships: number; leads: number };
  subscription: {
    status: string;
    trialEndsAt: Date | null;
    plan: { code: string };
  } | null;
}
