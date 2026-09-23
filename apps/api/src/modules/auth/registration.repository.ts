import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';

/**
 * Registration data access.
 *
 * Every method here runs under `runAsSystem`: registration creates a brand new
 * tenant, so there is no tenant context yet and nothing to scope to. This is
 * the legitimate, audited case the escape hatch exists for.
 */
@Injectable()
export class RegistrationRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async isSlugTaken(slug: string): Promise<boolean> {
    return this.tenantContext.runAsSystem(
      'registration: check slug availability before a tenant exists',
      async () => {
        const existing = await this.prisma.client.organization.findUnique({
          where: { slug },
          select: { id: true },
        });
        return existing !== null;
      },
    );
  }

  async emailExists(email: string): Promise<boolean> {
    return this.tenantContext.runAsSystem(
      'registration: check global email uniqueness',
      async () => {
        const existing = await this.prisma.client.user.findUnique({
          where: { email },
          select: { id: true },
        });
        return existing !== null;
      },
    );
  }

  async ownerRoleId(): Promise<string | null> {
    return this.tenantContext.runAsSystem('registration: resolve the system OWNER role', async () => {
      const role = await this.prisma.client.role.findFirst({
        where: { key: 'OWNER', organizationId: null, isSystem: true },
        select: { id: true },
      });
      return role?.id ?? null;
    });
  }

  /**
   * Creates organization, settings, user and OWNER membership in ONE
   * transaction.
   *
   * Partial state here is the worst possible failure: an organization with no
   * owner cannot be logged into, cannot be repaired by the customer, and is
   * invisible to them — they would simply try to register again and hit a
   * "slug taken" error for an organization they cannot reach.
   */
  async createOrganizationWithOwner(input: {
    organizationName: string;
    slug: string;
    timezone: string;
    currency: string;
    locale: string;
    country: string;
    email: string;
    passwordHash: string;
    fullName: string;
    ownerRoleId: string;
    leadSources: string[];
    /** Set when the account is created through Google; null for a password signup. */
    googleSubject?: string | null | undefined;
  }) {
    return this.tenantContext.runAsSystem(
      'registration: create a new tenant and its first owner atomically',
      async () =>
        this.prisma.client.$transaction(async (tx) => {
          const organization = await tx.organization.create({
            data: {
              name: input.organizationName,
              slug: input.slug,
              timezone: input.timezone,
              currency: input.currency,
              locale: input.locale,
              country: input.country,
              status: 'ACTIVE',
            },
          });

          await tx.organizationSettings.create({
            data: { organizationId: organization.id, leadSources: input.leadSources },
          });

          const user = await tx.user.create({
            data: {
              email: input.email,
              passwordHash: input.passwordHash,
              fullName: input.fullName,
              status: 'ACTIVE',
              // Records WHICH Google account this was created from, which is
              // what later makes Google a valid way back in.
              googleSubject: input.googleSubject ?? null,
            },
          });

          const membership = await tx.organizationUser.create({
            data: {
              organizationId: organization.id,
              userId: user.id,
              roleId: input.ownerRoleId,
              status: 'ACTIVE',
              joinedAt: new Date(),
            },
          });

          return { organization, user, membership };
        }),
    );
  }
}
