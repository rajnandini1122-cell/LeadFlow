import { Injectable } from '@nestjs/common';
import type { Permission, RoleKey } from '@leadflow/api-types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
import type { DevicePlatform } from '../../generated/prisma/enums';

export interface MembershipRecord {
  membershipId: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  organizationTimezone: string;
  organizationCurrency: string;
  organizationLocale: string;
  organizationCountry: string;
  organizationStatus: 'TRIAL' | 'ACTIVE' | 'SUSPENDED';
  userId: string;
  role: RoleKey;
  permissions: Permission[];
  membershipStatus: 'ACTIVE' | 'INVITED' | 'SUSPENDED';
  userStatus: 'ACTIVE' | 'INVITED' | 'SUSPENDED';
}

/**
 * Data access for authentication.
 *
 * Several queries here legitimately run before any tenant is known — you cannot
 * scope a login by organization when discovering which organizations the user
 * belongs to IS the query. Those calls use `runAsSystem()` with a stated
 * reason, which is the audited, greppable way to bypass tenant scoping.
 */
@Injectable()
export class AuthRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** `User` is a global model, so this needs no tenant scope. */
  async findUserByEmail(email: string) {
    return this.prisma.client.user.findUnique({
      where: { email: normaliseEmail(email) },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        fullName: true,
        mobile: true,
        avatarUrl: true,
        status: true,
      },
    });
  }

  async findUserById(userId: string) {
    return this.prisma.client.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        fullName: true,
        mobile: true,
        avatarUrl: true,
        status: true,
      },
    });
  }

  /** All organizations this user can sign in to. */
  async findMembershipsForUser(userId: string): Promise<MembershipRecord[]> {
    const rows = await this.tenantContext.runAsSystem(
      'login: resolve which organizations a user belongs to, before a tenant is known',
      () =>
        this.prisma.client.organizationUser.findMany({
          where: { userId, status: 'ACTIVE' },
          include: {
            organization: true,
            user: { select: { status: true } },
            role: { include: { permissions: { include: { permission: true } } } },
          },
          orderBy: { createdAt: 'asc' },
        }),
    );

    return rows.map(toMembershipRecord);
  }

  /**
   * One membership, used on every authenticated request to confirm the token's
   * `org` claim still corresponds to live, active access.
   */
  async findMembership(userId: string, organizationId: string): Promise<MembershipRecord | null> {
    const row = await this.tenantContext.runAsSystem(
      'auth guard: validate a token claim against live membership before tenant context exists',
      () =>
        this.prisma.client.organizationUser.findUnique({
          where: { organizationId_userId: { organizationId, userId } },
          include: {
            organization: true,
            user: { select: { status: true } },
            role: { include: { permissions: { include: { permission: true } } } },
          },
        }),
    );

    return row ? toMembershipRecord(row) : null;
  }

  // --- sessions -------------------------------------------------------------

  async createSession(input: {
    organizationId: string;
    userId: string;
    refreshTokenHash: string;
    familyId: string;
    expiresAt: Date;
    platform: DevicePlatform;
    deviceId?: string | undefined;
    deviceName?: string | undefined;
    ipAddress?: string | undefined;
    userAgent?: string | undefined;
  }) {
    return this.tenantContext.runAsSystem(
      'login/refresh: create a session row for a tenant the caller is not yet scoped to',
      () =>
        this.prisma.client.session.create({
          data: {
            organizationId: input.organizationId,
            userId: input.userId,
            refreshTokenHash: input.refreshTokenHash,
            familyId: input.familyId,
            expiresAt: input.expiresAt,
            platform: input.platform,
            deviceId: input.deviceId ?? null,
            deviceName: input.deviceName ?? null,
            ipAddress: input.ipAddress ?? null,
            userAgent: input.userAgent ?? null,
          },
        }),
    );
  }

  async findSessionByTokenHash(refreshTokenHash: string) {
    return this.tenantContext.runAsSystem(
      'refresh: locate a session by token hash before the tenant is known',
      () => this.prisma.client.session.findUnique({ where: { refreshTokenHash } }),
    );
  }

  async rotateSession(input: {
    currentSessionId: string;
    organizationId: string;
    userId: string;
    newRefreshTokenHash: string;
    familyId: string;
    expiresAt: Date;
    platform: DevicePlatform;
    ipAddress?: string | undefined;
    userAgent?: string | undefined;
  }) {
    return this.tenantContext.runAsSystem('refresh: rotate a refresh token atomically', () =>
      this.prisma.client.$transaction(async (tx) => {
        const created = await tx.session.create({
          data: {
            organizationId: input.organizationId,
            userId: input.userId,
            refreshTokenHash: input.newRefreshTokenHash,
            familyId: input.familyId,
            expiresAt: input.expiresAt,
            platform: input.platform,
            ipAddress: input.ipAddress ?? null,
            userAgent: input.userAgent ?? null,
          },
        });

        await tx.session.update({
          where: { id: input.currentSessionId },
          data: {
            revokedAt: new Date(),
            revokedReason: 'ROTATED',
            replacedById: created.id,
          },
        });

        return created;
      }),
    );
  }

  /**
   * Kills every session descended from one login.
   *
   * Called when a revoked refresh token is replayed: the token leaked, and we
   * cannot tell whether the legitimate user or the attacker holds the current
   * one, so both are invalidated and the user signs in again.
   */
  async revokeFamily(familyId: string, reason: string): Promise<number> {
    const result = await this.tenantContext.runAsSystem(
      'security: revoke an entire refresh-token family after reuse detection',
      () =>
        this.prisma.client.session.updateMany({
          where: { familyId, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: reason },
        }),
    );
    return result.count;
  }

  async revokeSession(sessionId: string, reason: string): Promise<void> {
    await this.tenantContext.runAsSystem('logout: revoke a single session', () =>
      this.prisma.client.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
      }),
    );
  }

  async touchLastLogin(userId: string): Promise<void> {
    await this.prisma.client.user.update({
      where: { id: userId },
      data: { lastLoginAt: new Date() },
    });
  }
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

type MembershipRow = {
  id: string;
  organizationId: string;
  userId: string;
  status: string;
  organization: {
    name: string;
    slug: string;
    timezone: string;
    currency: string;
    locale: string;
    country: string;
    status: string;
  };
  user: { status: string };
  role: { key: string; permissions: { permission: { key: string } }[] };
};

function toMembershipRecord(row: MembershipRow): MembershipRecord {
  return {
    membershipId: row.id,
    organizationId: row.organizationId,
    organizationName: row.organization.name,
    organizationSlug: row.organization.slug,
    organizationTimezone: row.organization.timezone,
    organizationCurrency: row.organization.currency,
    organizationLocale: row.organization.locale,
    organizationCountry: row.organization.country,
    organizationStatus: row.organization.status as MembershipRecord['organizationStatus'],
    userId: row.userId,
    role: row.role.key as RoleKey,
    permissions: row.role.permissions.map((rp) => rp.permission.key as Permission),
    membershipStatus: row.status as MembershipRecord['membershipStatus'],
    userStatus: row.user.status as MembershipRecord['userStatus'],
  };
}
