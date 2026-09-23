import { Injectable } from '@nestjs/common';
import type { Permission, RoleKey } from '@leadflow/api-types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { uuidv7 } from '../../common/utils/uuid';
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
  membershipStatus: 'ACTIVE' | 'INVITED' | 'SUSPENDED' | 'REMOVED';
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
        // Which Google account created this one, if any. Decides whether
        // Google is a valid way back in — see AuthService.loginWithGoogle.
        googleSubject: true,
      },
    });
  }

  /**
   * Adopts an account that has never been used.
   *
   * Only ever called for a row with no password and no existing Google link:
   * an invitation nobody accepted. Anything else would be attaching a Google
   * identity to an account somebody already owns.
   */
  async linkGoogleAccount(userId: string, googleSubject: string): Promise<void> {
    await this.prisma.client.user.update({
      where: { id: userId },
      data: { googleSubject },
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

  /**
   * Whether a rotated session was consumed recently enough to treat a late
   * arrival as a lost race rather than a replay.
   *
   * Both halves of the comparison come from PostgreSQL: `revoked_at` was
   * written by the database when the rotation committed, and `clock_timestamp()`
   * is read now. No application clock takes part, so two API replicas whose
   * clocks disagree still reach the same verdict.
   *
   * A session whose revocation is somehow in the future answers `true` — the
   * difference is negative, which is inside any interval. That is the safe
   * direction: it withholds family revocation rather than inventing it.
   */
  async isWithinRotationReuseInterval(input: {
    sessionId: string;
    organizationId: string;
    intervalMs: number;
  }): Promise<boolean> {
    return this.tenantContext.runAsSystem(
      'refresh: ask the database whether a rotated token is still inside the reuse interval',
      async () => {
        /*
         * Raw SQL, deliberately and narrowly: Prisma cannot express
         * `clock_timestamp()`, and reading the database's own clock is the
         * entire point. Every value is bound as a parameter, and the row is
         * pinned to its organization as the lint rule requires.
         */
        // eslint-disable-next-line no-restricted-syntax
        const rows = await this.prisma.client.$queryRaw<{ within: boolean }[]>`
          SELECT clock_timestamp() - "revoked_at"
                 <= (${input.intervalMs}::double precision / 1000) * interval '1 second'
                 AS within
            FROM "sessions"
           WHERE "id" = ${input.sessionId}::uuid
             AND "organization_id" = ${input.organizationId}::uuid
             AND "revoked_at" IS NOT NULL
        `;

        return rows[0]?.within ?? false;
      },
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
    // The replacement's id is generated here rather than by the database, so
    // the parent can be pointed at it in the SAME statement that consumes it.
    // Without that the consume would have to happen after the create, which is
    // what allowed several children to descend from one token.
    const replacementId = uuidv7();

    return this.tenantContext.runAsSystem('refresh: rotate a refresh token atomically', () =>
      this.prisma.client.$transaction(async (tx) => {
        /*
         * Consume FIRST, and conditionally.
         *
         * `revoked_at IS NULL` in the WHERE clause is what guarantees one
         * child per token. An earlier version read the session as live in the
         * service, then created the child and unconditionally revoked the
         * parent — so several concurrent requests each passed that earlier
         * read and each minted a session, turning one refresh token into
         * several valid ones.
         *
         * Postgres evaluates this predicate against the committed row at write
         * time, so exactly one caller can match. Everyone else updates zero
         * rows and is told so.
         *
         * Raw SQL for one reason: `revoked_at` must be the DATABASE's clock.
         * It is the instant the reuse interval is measured from, and two API
         * replicas can disagree about the time while the database cannot
         * disagree with itself. Prisma cannot express `clock_timestamp()`.
         * Every value below is a bound parameter, and the row is pinned to its
         * organization as the lint rule requires.
         */
        // eslint-disable-next-line no-restricted-syntax
        const consumed = await tx.$queryRaw<{ id: string }[]>`
          UPDATE "sessions"
             SET "revoked_at" = clock_timestamp(),
                 "revoked_reason" = 'ROTATED',
                 "replaced_by_id" = ${replacementId}::uuid
           WHERE "id" = ${input.currentSessionId}::uuid
             AND "organization_id" = ${input.organizationId}::uuid
             AND "revoked_at" IS NULL
          RETURNING "id"
        `;

        // Lost the race. Returning null rather than throwing keeps the
        // decision about HOW to answer with the service, which is the only
        // place that can tell a concurrent loser from a replayed leak.
        if (consumed.length === 0) return null;

        return tx.session.create({
          data: {
            id: replacementId,
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
