import { Injectable } from '@nestjs/common';
import type { RoleKey, UserStatus } from '@leadflow/api-types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';

/**
 * User data access, always reached through OrganizationUser.
 *
 * This is the important detail: `User` is a GLOBAL model and is deliberately
 * not auto-scoped by the Prisma extension. Querying `user` directly would
 * return every user on the platform. Every read here therefore starts from
 * `organizationUser`, which IS auto-scoped, and pulls the user through the
 * relation — so tenant scoping applies transitively and cannot be forgotten.
 */
@Injectable()
export class UsersRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Members of the current organization. Scoped automatically. */
  async listMembers() {
    return this.prisma.client.organizationUser.findMany({
      // Removed members are retained for referential integrity but are no
      // longer part of the team.
      where: { status: { not: 'REMOVED' } },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            fullName: true,
            mobile: true,
            avatarUrl: true,
            lastLoginAt: true,
          },
        },
        role: { select: { key: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * One member of the current organization.
   *
   * Returns null — not a foreign user — when the id belongs to another tenant,
   * because the membership row simply will not match the injected scope.
   */
  async findMember(userId: string) {
    return this.prisma.client.organizationUser.findFirst({
      where: { userId, status: { not: 'REMOVED' } },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            fullName: true,
            mobile: true,
            avatarUrl: true,
            lastLoginAt: true,
            status: true,
          },
        },
        role: { select: { key: true } },
      },
    });
  }

  /** Global lookup, used to decide whether an invite creates or links a user. */
  async findUserByEmail(email: string) {
    return this.prisma.client.user.findUnique({
      where: { email },
      select: { id: true, email: true, fullName: true, status: true },
    });
  }

  async findRoleByKey(key: RoleKey) {
    return this.prisma.client.role.findFirst({
      where: { key, organizationId: null, isSystem: true },
      select: { id: true, key: true },
    });
  }

  /**
   * Creates the user if new, then attaches a membership — atomically, so a
   * failure cannot leave a user row with no organization.
   */
  async inviteMember(input: {
    email: string;
    fullName: string;
    mobile?: string | undefined;
    roleId: string;
    invitedById: string;
    inviteTokenHash: string;
    inviteExpiresAt: Date;
  }) {
    const organizationId = this.tenantContext.requireOrganizationId();

    return this.prisma.client.$transaction(async (tx) => {
      const user = await tx.user.upsert({
        where: { email: input.email },
        create: {
          email: input.email,
          fullName: input.fullName,
          mobile: input.mobile ?? null,
          status: 'INVITED',
        },
        update: {},
        select: { id: true, email: true, fullName: true, status: true },
      });

      const membership = await tx.organizationUser.create({
        data: {
          organizationId,
          userId: user.id,
          roleId: input.roleId,
          status: 'INVITED',
          invitedById: input.invitedById,
          inviteTokenHash: input.inviteTokenHash,
          inviteExpiresAt: input.inviteExpiresAt,
        },
        include: { role: { select: { key: true } } },
      });

      return { user, membership };
    });
  }

  /** Active OWNER memberships in this organization. Tenant-scoped. */
  async countActiveOwners(): Promise<number> {
    return this.prisma.client.organizationUser.count({
      where: { status: 'ACTIVE', role: { key: 'OWNER' } },
    });
  }

  /**
   * Soft-removes a member.
   *
   * Tenant-scoped updateMany, so a foreign userId affects zero rows. The row
   * is RETAINED: leads.assigned_to and lead_activities.performed_by point at
   * this user, and hard-deleting would either break those references or erase
   * who did what. Access is refused by the guard on status, not by absence.
   */
  async removeMember(userId: string): Promise<number> {
    const result = await this.prisma.client.organizationUser.updateMany({
      where: { userId, status: { in: ['ACTIVE', 'INVITED', 'SUSPENDED'] } },
      data: {
        status: 'REMOVED',
        removedAt: new Date(),
        // A pending invitation for a removed member must not remain redeemable.
        inviteTokenHash: null,
        inviteExpiresAt: null,
      },
    });
    return result.count;
  }

  /** Revokes every session this user holds in the CURRENT organization. */
  async revokeSessions(userId: string, reason: string): Promise<number> {
    const result = await this.prisma.client.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return result.count;
  }

  async membershipExists(userId: string): Promise<boolean> {
    const count = await this.prisma.client.organizationUser.count({ where: { userId } });
    return count > 0;
  }

  async updateMember(
    userId: string,
    changes: {
      fullName?: string | undefined;
      mobile?: string | null | undefined;
      roleId?: string | undefined;
      status?: UserStatus | undefined;
    },
  ) {
    return this.prisma.client.$transaction(async (tx) => {
      // Establish tenancy FIRST, unconditionally.
      //
      // `User` is a global model, so `tx.user.update({ where: { id } })` is NOT
      // tenant-scoped by the extension and would happily rename a user in
      // another organization. The membership lookup below IS scoped, so it acts
      // as the authorisation check for every branch that follows. Do not move
      // it inside a conditional.
      const membership = await tx.organizationUser.findFirst({
        where: { userId },
        select: { id: true },
      });
      if (!membership) return null;

      const membershipChanges: Record<string, unknown> = {};
      if (changes.roleId) membershipChanges['roleId'] = changes.roleId;
      if (changes.status) membershipChanges['status'] = changes.status;

      if (Object.keys(membershipChanges).length > 0) {
        await tx.organizationUser.update({
          where: { id: membership.id },
          data: membershipChanges,
        });
      }

      const userChanges: Record<string, unknown> = {};
      if (changes.fullName !== undefined) userChanges['fullName'] = changes.fullName;
      if (changes.mobile !== undefined) userChanges['mobile'] = changes.mobile;

      if (Object.keys(userChanges).length > 0) {
        await tx.user.update({ where: { id: userId }, data: userChanges });
      }

      return tx.organizationUser.findFirst({
        where: { userId },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              fullName: true,
              mobile: true,
              avatarUrl: true,
              lastLoginAt: true,
              status: true,
            },
          },
          role: { select: { key: true } },
        },
      });
    });
  }
}
