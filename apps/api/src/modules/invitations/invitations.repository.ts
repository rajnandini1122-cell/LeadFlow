import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';

/**
 * Invitation data access.
 *
 * Two distinct access patterns live here and they have opposite security
 * properties:
 *
 *   * Management (list, resend, revoke) is TENANT-SCOPED. The Prisma extension
 *     applies the caller's organization automatically, so one tenant can never
 *     see or revoke another's invitations.
 *
 *   * Redemption (lookup by token, accept) is UNAUTHENTICATED and therefore
 *     necessarily cross-tenant — the recipient has no session and no tenant
 *     yet. Those calls run under `runAsSystem` and are guarded by the secrecy
 *     and single-use nature of the token itself, never by tenant scope.
 */
@Injectable()
export class InvitationsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  // --- tenant-scoped management ---------------------------------------------

  /** Pending invitations for the CURRENT organization. */
  async listPending() {
    return this.prisma.client.organizationUser.findMany({
      where: { status: 'INVITED', inviteRevokedAt: null, inviteAcceptedAt: null },
      include: {
        user: { select: { id: true, email: true, fullName: true } },
        role: { select: { key: true } },
        invitedBy: { select: { id: true, fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * One pending invitation belonging to the current organization.
   *
   * Tenant-scoped, so another organization's invitation id simply returns null
   * and the caller turns that into a 404 — never a 403, which would confirm the
   * id exists.
   */
  async findPendingById(id: string) {
    return this.prisma.client.organizationUser.findFirst({
      where: { id, status: 'INVITED', inviteRevokedAt: null, inviteAcceptedAt: null },
      include: {
        user: { select: { id: true, email: true, fullName: true } },
        role: { select: { key: true } },
      },
    });
  }

  async rotateToken(id: string, inviteTokenHash: string, inviteExpiresAt: Date): Promise<number> {
    // updateMany, not update: it carries the tenant scope, so a foreign id
    // updates zero rows instead of raising a distinguishable error.
    const result = await this.prisma.client.organizationUser.updateMany({
      where: { id, status: 'INVITED', inviteRevokedAt: null, inviteAcceptedAt: null },
      data: { inviteTokenHash, inviteExpiresAt },
    });
    return result.count;
  }

  async revoke(id: string): Promise<number> {
    const result = await this.prisma.client.organizationUser.updateMany({
      where: { id, status: 'INVITED', inviteRevokedAt: null, inviteAcceptedAt: null },
      data: {
        inviteRevokedAt: new Date(),
        // Clearing the hash makes the superseded link unusable even if the
        // status check were ever relaxed. Defence in depth for a credential.
        inviteTokenHash: null,
      },
    });
    return result.count;
  }

  // --- unauthenticated redemption -------------------------------------------

  /**
   * Looks up an invitation by token hash across all tenants.
   *
   * Cross-tenant by necessity: the recipient is not signed in. Possession of
   * the token is the authorisation.
   */
  async findByTokenHash(inviteTokenHash: string) {
    return this.tenantContext.runAsSystem(
      'invitation redemption: the recipient has no session or tenant context yet',
      async () =>
        this.prisma.client.organizationUser.findUnique({
          where: { inviteTokenHash },
          include: {
            organization: { select: { id: true, name: true, slug: true, status: true } },
            user: { select: { id: true, email: true, fullName: true, passwordHash: true } },
            role: { select: { key: true } },
          },
        }),
    );
  }

  /**
   * Consumes the invitation and activates the membership, atomically.
   *
   * The conditional `updateMany` is what makes the token single-use: the WHERE
   * clause requires the invitation to still be pending, so of two concurrent
   * acceptances exactly one updates a row and the other sees count 0. Checking
   * first and then updating would let both through.
   */
  async acceptAtomically(input: {
    membershipId: string;
    userId: string;
    fullName?: string | undefined;
    passwordHash?: string | undefined;
  }): Promise<boolean> {
    return this.tenantContext.runAsSystem(
      'invitation acceptance: activate a membership for a user with no session',
      async () =>
        this.prisma.client.$transaction(async (tx) => {
          const claimed = await tx.organizationUser.updateMany({
            where: {
              id: input.membershipId,
              status: 'INVITED',
              inviteAcceptedAt: null,
              inviteRevokedAt: null,
            },
            data: {
              status: 'ACTIVE',
              inviteAcceptedAt: new Date(),
              joinedAt: new Date(),
              // Spent. The link cannot be replayed.
              inviteTokenHash: null,
              inviteExpiresAt: null,
            },
          });

          if (claimed.count === 0) return false;

          const userChanges: Record<string, unknown> = { status: 'ACTIVE' };
          if (input.fullName) userChanges['fullName'] = input.fullName;
          // Only ever SET a password, never overwrite an existing one: an
          // invitation must not be a way to reset a stranger's credentials.
          if (input.passwordHash) userChanges['passwordHash'] = input.passwordHash;

          await tx.user.update({ where: { id: input.userId }, data: userChanges });

          return true;
        }),
    );
  }
}
