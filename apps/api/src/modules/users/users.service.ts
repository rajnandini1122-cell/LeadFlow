import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  type InviteUserResponse,
  type RoleKey,
  type UserListItem,
  type UserStatus,
} from '@leadflow/api-types';
import { AppConfig } from '../../common/config/config.module';
import { AppException } from '../../common/errors/app.exception';
import { AUDIT_ACTIONS, AuditRepository } from '../../common/audit/audit.repository';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { MembershipCacheService } from '../auth/membership-cache.service';
import { InvitationsService } from '../invitations/invitations.service';
import { UsersRepository } from './users.repository';
import { OffboardingService } from './offboarding.service';
import { isAdministrativeRole, losesAdminStanding } from './administrators';
import { EmailService } from '../../common/email/email.service';
import type { InviteUserDto, UpdateUserDto } from './dto/users.dto';

@Injectable()
export class UsersService {
  constructor(
    private readonly repository: UsersRepository,
    private readonly audit: AuditRepository,
    private readonly membershipCache: MembershipCacheService,
    private readonly config: AppConfig,
    private readonly invitations: InvitationsService,
    private readonly email: EmailService,
    private readonly offboarding: OffboardingService,
  ) {}

  async list(): Promise<UserListItem[]> {
    const members = await this.repository.listMembers();
    return members.map(toUserListItem);
  }

  async findOne(userId: string): Promise<UserListItem> {
    const member = await this.repository.findMember(userId);
    // A user in another organization is indistinguishable from one that does
    // not exist — see AppException.notFound.
    if (!member) throw AppException.userNotFound();
    return toUserListItem(member);
  }

  async invite(dto: InviteUserDto, principal: TenantPrincipal): Promise<InviteUserResponse> {
    const role = await this.repository.findRoleByKey(dto.role);
    if (!role) throw AppException.validation(`Unknown role: ${dto.role}`);

    const existing = await this.repository.findUserByEmail(dto.email);
    if (existing) {
      const current = await this.repository.findMember(existing.id);
      // findMember excludes REMOVED, so a previously removed person can be
      // re-invited; only a live membership blocks it.
      if (current) {
        throw AppException.conflict(
          'USER_ALREADY_EXISTS',
          'That user is already in this organization.',
        );
      }
    }

    // Single source of token semantics — hashing, length and TTL all live in
    // InvitationsService so invite and resend cannot drift apart.
    const minted = InvitationsService.mintToken();

    const { user, membership } = await this.repository.inviteMember({
      email: dto.email,
      fullName: dto.fullName,
      mobile: dto.mobile,
      roleId: role.id,
      invitedById: principal.userId,
      inviteTokenHash: minted.hash,
      inviteExpiresAt: minted.expiresAt,
    });

    // Delivery outcome is not surfaced to the caller: the invitation exists
    // either way, and an admin can resend from the pending list if it did not
    // arrive. Failing the request would leave a pending invitation the UI
    // reported as failed.
    const [inviter, organizationName] = await Promise.all([
      this.repository.findMember(principal.userId),
      this.repository.organizationName(),
    ]);

    await this.email.sendInvitation({
      to: dto.email,
      inviterName: inviter?.user.fullName ?? 'A colleague',
      organizationName,
      role: dto.role,
      token: minted.token,
      expiresInDays: 7,
    });

    await this.audit.record({
      action: AUDIT_ACTIONS.USER_INVITED,
      entityType: 'user',
      entityId: user.id,
      after: { email: dto.email, role: dto.role },
    });

    return {
      userId: user.id,
      // The membership row IS the invitation; its id is what resend and revoke
      // address.
      invitationId: membership.id,
      email: user.email,
      role: membership.role.key as RoleKey,
      status: membership.status as UserStatus,
      // Returned outside production so the invite flow is testable without an
      // email provider. In production this would leak a credential into logs
      // and proxies, so it is withheld and the link is emailed instead.
      ...(this.config.isProduction ? {} : { inviteToken: minted.token }),
    };
  }

  /**
   * Refuses an action that would leave the organization unadministrable.
   *
   * Two invariants, both enforced:
   *
   *   1. At least one ACTIVE administrator must remain — a role holding
   *      user.update, user.invite and org.update. Delegated to
   *      OffboardingService so removal, deactivation, demotion and leaving all
   *      go through one implementation.
   *   2. At least one ACTIVE OWNER must remain. Stricter than (1) on purpose:
   *      only an owner can grant or revoke ownership, so an organization of
   *      admins alone could never appoint one again.
   */
  private async assertRetainsAdministration(member: {
    userId: string;
    role: RoleKey;
    status: string;
  }): Promise<void> {
    await this.offboarding.assertRetainsAdministrator(member);

    if (member.role === 'OWNER' && member.status === 'ACTIVE') {
      const owners = await this.repository.countActiveOwners();
      if (owners <= 1) {
        // Same error code as the administrator rule above: from a client's
        // point of view these are one refusal — the organization would lose
        // the ability to administer itself — and two codes would mean every
        // caller had to handle both.
        throw new AppException(
          ERROR_CODES.LAST_ADMINISTRATOR,
          'This is the last active owner. Transfer admin responsibility first.',
          HttpStatus.FORBIDDEN,
        );
      }
    }
  }

  /**
   * Soft-removes a member and revokes their access immediately.
   */
  async remove(userId: string, principal: TenantPrincipal): Promise<void> {
    const member = await this.repository.findMember(userId);
    if (!member) throw AppException.userNotFound();

    if (userId === principal.userId) {
      // Removing yourself is "leave", which has its own endpoint and its own
      // confirmation. Conflating them makes an accidental self-removal easy.
      throw AppException.forbidden('Use "leave organization" to remove yourself.');
    }
    if (member.role.key === 'OWNER' && principal.role !== 'OWNER') {
      throw AppException.forbidden('Only an owner can remove another owner.');
    }

    await this.assertRetainsAdministration({
      userId,
      role: member.role.key as RoleKey,
      status: member.status,
    });

    // Refuses with the counts when this member still owns active leads or open
    // follow-ups. Removing them anyway would leave those customers pointing at
    // a membership that no longer works — no query fails, the work simply stops
    // being anybody's job.
    await this.offboarding.assertNoOrphanedWork(userId);

    const removed = await this.repository.removeMember(userId);
    if (removed === 0) throw AppException.userNotFound();

    // Both are required. Revoking sessions stops refresh; invalidating the
    // cache stops the still-valid access token being accepted for up to a
    // minute by a guard reading a stale membership.
    await this.repository.revokeSessions(userId, 'MEMBER_REMOVED');
    await this.membershipCache.invalidate(userId, principal.organizationId);

    await this.audit.record({
      action: 'user.removed',
      entityType: 'user',
      entityId: userId,
      before: { role: member.role.key, status: member.status },
    });
  }

  /**
   * The caller leaves the current organization.
   *
   * Memberships in other organizations are untouched — they are separate rows
   * and separate sessions.
   */
  async leave(
    principal: TenantPrincipal,
    handover: { reassignToId?: string | undefined; includeHistorical?: boolean | undefined } = {},
  ): Promise<void> {
    const member = await this.repository.findMember(principal.userId);
    if (!member) throw AppException.userNotFound();

    await this.assertRetainsAdministration({
      userId: principal.userId,
      role: member.role.key as RoleKey,
      status: member.status,
    });

    // Hands the work over when a successor was named, and refuses with the
    // counts when one is needed and none was given.
    const moved = await this.offboarding.handOver(
      principal.userId,
      { ...handover, reason: 'Reassigned when the previous owner left the organization' },
      principal,
    );

    const removed = await this.repository.removeMember(principal.userId);
    if (removed === 0) throw AppException.userNotFound();

    await this.repository.revokeSessions(principal.userId, 'LEFT_ORGANIZATION');
    await this.membershipCache.invalidate(principal.userId, principal.organizationId);

    await this.audit.record({
      action: 'user.left_organization',
      entityType: 'user',
      entityId: principal.userId,
      before: { role: member.role.key },
      after: { reassignToId: handover.reassignToId ?? null, ...moved },
    });

    await this.offboarding.verifyAdministratorRemains({
      organizationId: principal.organizationId,
      trigger: 'leave',
      userId: principal.userId,
    });
  }

  async update(
    userId: string,
    dto: UpdateUserDto,
    principal: TenantPrincipal,
  ): Promise<UserListItem> {
    const before = await this.repository.findMember(userId);
    if (!before) throw AppException.userNotFound();

    if (userId === principal.userId && dto.role && dto.role !== principal.role) {
      throw AppException.forbidden('You cannot change your own role.');
    }
    if (userId === principal.userId && dto.status === 'SUSPENDED') {
      throw AppException.forbidden('You cannot suspend your own account.');
    }

    // Only an owner may create or remove another owner. Without this an admin
    // could promote themselves and take over the organization.
    const grantingOwner = dto.role === 'OWNER';
    const removingOwner = before.role.key === 'OWNER' && dto.role && dto.role !== 'OWNER';

    if ((grantingOwner || removingOwner) && principal.role !== 'OWNER') {
      throw AppException.forbidden('Only an owner can change owner access.');
    }

    // Demotion or suspension of the last administrator is refused by the same
    // rule that guards removal and leaving.
    if (
      losesAdminStanding(
        { role: before.role.key as RoleKey, status: before.status },
        { role: dto.role, status: dto.status },
      )
    ) {
      await this.assertRetainsAdministration({
        userId,
        role: before.role.key as RoleKey,
        status: before.status,
      });
    }

    // Suspension is an exit in everything but name: the member can no longer
    // sign in, so their active leads and open follow-ups would be orphaned
    // exactly as they would be by removal.
    if (dto.status === 'SUSPENDED' && before.status === 'ACTIVE') {
      await this.offboarding.assertNoOrphanedWork(userId);
    }

    const roleId = dto.role ? (await this.repository.findRoleByKey(dto.role))?.id : undefined;
    if (dto.role && !roleId) throw AppException.validation(`Unknown role: ${dto.role}`);

    const updated = await this.repository.updateMember(userId, {
      fullName: dto.fullName,
      mobile: dto.mobile,
      roleId,
      status: dto.status,
    });
    if (!updated) throw AppException.userNotFound();

    // Without this the old role survives in cache for up to a minute.
    await this.membershipCache.invalidate(userId, principal.organizationId);

    // Suspension has to bite NOW. Leaving live sessions alone would let a
    // suspended user keep working until their refresh token expired.
    if (dto.status === 'SUSPENDED') {
      await this.repository.revokeSessions(userId, 'MEMBER_SUSPENDED');
    }

    await this.audit.record({
      action: dto.role ? AUDIT_ACTIONS.ROLE_CHANGED : AUDIT_ACTIONS.USER_UPDATED,
      entityType: 'user',
      entityId: userId,
      before: { role: before.role.key, status: before.status },
      after: { role: updated.role.key, status: updated.status },
    });

    if (isAdministrativeRole(before.role.key as RoleKey)) {
      await this.offboarding.verifyAdministratorRemains({
        organizationId: principal.organizationId,
        trigger: 'update_member',
        userId,
      });
    }

    return toUserListItem(updated);
  }
}

type MemberRow = {
  status: string;
  joinedAt: Date | null;
  role: { key: string };
  user: {
    id: string;
    email: string;
    fullName: string;
    mobile: string | null;
    avatarUrl: string | null;
    lastLoginAt: Date | null;
  };
};

function toUserListItem(member: MemberRow): UserListItem {
  return {
    id: member.user.id,
    email: member.user.email,
    fullName: member.user.fullName,
    mobile: member.user.mobile,
    avatarUrl: member.user.avatarUrl,
    role: member.role.key as RoleKey,
    status: member.status as UserStatus,
    joinedAt: member.joinedAt?.toISOString() ?? null,
    lastLoginAt: member.user.lastLoginAt?.toISOString() ?? null,
  };
}
