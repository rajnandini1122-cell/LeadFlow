import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';

/**
 * Password reset data access.
 *
 * Entirely un-tenanted, and correctly so: a person resets their password as
 * themselves, before any organization is selected, and often while holding no
 * session at all. `PasswordResetToken` and `User` are both global models, so
 * the tenant extension does not apply — every call runs under `runAsSystem`
 * with a stated reason.
 */
@Injectable()
export class PasswordResetRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async findUserByEmail(email: string) {
    return this.tenantContext.runAsSystem(
      'password reset: locate an account before any tenant is known',
      async () =>
        this.prisma.client.user.findUnique({
          where: { email },
          select: { id: true, email: true, fullName: true, status: true, passwordHash: true },
        }),
    );
  }

  /** Used by the change-password flow, which knows the id but not the email. */
  async findUserById(userId: string) {
    return this.tenantContext.runAsSystem(
      "password change: load the caller's own credentials",
      async () =>
        this.prisma.client.user.findUnique({
          where: { id: userId },
          select: { id: true, email: true, status: true, passwordHash: true },
        }),
    );
  }

  /**
   * Issues a token, invalidating any that are still outstanding.
   *
   * Without the invalidation step every request would leave another live key to
   * the account, so a user who clicks "forgot password" five times would have
   * five working links in their inbox.
   */
  async issue(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    ipAddress?: string | undefined;
    userAgent?: string | undefined;
  }) {
    return this.tenantContext.runAsSystem('password reset: issue a token', async () =>
      this.prisma.client.$transaction(async (tx) => {
        await tx.passwordResetToken.updateMany({
          where: { userId: input.userId, usedAt: null },
          data: { usedAt: new Date() },
        });

        return tx.passwordResetToken.create({
          data: {
            userId: input.userId,
            tokenHash: input.tokenHash,
            expiresAt: input.expiresAt,
            ipAddress: input.ipAddress ?? null,
            userAgent: input.userAgent ?? null,
          },
        });
      }),
    );
  }

  async findByTokenHash(tokenHash: string) {
    return this.tenantContext.runAsSystem(
      'password reset: redeem a token held by an unauthenticated caller',
      async () =>
        this.prisma.client.passwordResetToken.findUnique({
          where: { tokenHash },
          include: { user: { select: { id: true, email: true, status: true } } },
        }),
    );
  }

  /**
   * Consumes the token, sets the password, and revokes every session.
   *
   * The conditional `updateMany` on `usedAt: null` is what makes the token
   * single-use: two concurrent redemptions mean exactly one updates a row.
   * Checking first and then writing would let both through.
   *
   * All sessions die because a reset is usually a RESPONSE to compromise —
   * leaving the attacker's session alive would defeat the point.
   */
  async consumeAndSetPassword(input: {
    tokenId: string;
    userId: string;
    passwordHash: string;
  }): Promise<boolean> {
    return this.tenantContext.runAsSystem(
      'password reset: consume a token and rotate credentials',
      async () =>
        this.prisma.client.$transaction(async (tx) => {
          const claimed = await tx.passwordResetToken.updateMany({
            where: { id: input.tokenId, usedAt: null },
            data: { usedAt: new Date() },
          });

          if (claimed.count === 0) return false;

          await tx.user.update({
            where: { id: input.userId },
            data: { passwordHash: input.passwordHash },
          });

          await tx.session.updateMany({
            where: { userId: input.userId, revokedAt: null },
            data: { revokedAt: new Date(), revokedReason: 'PASSWORD_RESET' },
          });

          return true;
        }),
    );
  }

  /**
   * Changes the password for a signed-in user and revokes their OTHER sessions.
   *
   * `exceptSessionId` keeps the current device signed in. Signing someone out
   * of the device they are actively using, for routine hygiene they initiated,
   * is a hostile experience — and it teaches people not to change passwords.
   */
  async changePassword(input: {
    userId: string;
    passwordHash: string;
    exceptSessionId: string;
  }): Promise<void> {
    await this.tenantContext.runAsSystem('password change: rotate credentials', async () =>
      this.prisma.client.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: input.userId },
          data: { passwordHash: input.passwordHash },
        });

        await tx.session.updateMany({
          where: { userId: input.userId, revokedAt: null, id: { not: input.exceptSessionId } },
          data: { revokedAt: new Date(), revokedReason: 'PASSWORD_CHANGED' },
        });
      }),
    );
  }

  // --- session management ----------------------------------------------------

  /**
   * The caller's own live sessions, across every organization.
   *
   * Filtered by `userId` rather than by tenant on purpose: "where am I signed
   * in?" is a question about a person, not about one of their organizations.
   * The refresh token hash is never selected.
   */
  async listSessions(userId: string) {
    return this.tenantContext.runAsSystem(
      'session management: list a user’s sessions across all their organizations',
      async () =>
        this.prisma.client.session.findMany({
          where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
          select: {
            id: true,
            platform: true,
            deviceName: true,
            ipAddress: true,
            userAgent: true,
            createdAt: true,
            expiresAt: true,
            organization: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: 'desc' },
        }),
    );
  }

  /**
   * Revokes one session, scoped to its owner.
   *
   * `userId` is part of the WHERE clause rather than checked beforehand, so
   * another person's session id simply updates zero rows — the caller cannot
   * tell whether it existed.
   */
  async revokeSession(userId: string, sessionId: string): Promise<number> {
    const result = await this.tenantContext.runAsSystem(
      'session management: revoke one of the caller’s own sessions',
      async () =>
        this.prisma.client.session.updateMany({
          where: { id: sessionId, userId, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: 'USER_REVOKED' },
        }),
    );
    return result.count;
  }
}
