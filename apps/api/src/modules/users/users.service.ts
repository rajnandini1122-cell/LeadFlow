import { HttpStatus, Injectable, Logger } from '@nestjs/common';
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
import { parsePhone } from '../../common/utils/phone';
import { MembershipCacheService } from '../auth/membership-cache.service';
import { InvitationsService } from '../invitations/invitations.service';
import { UsersRepository } from './users.repository';
import { OffboardingService } from './offboarding.service';
import { LastAdministratorError, OffboardingRepository } from './offboarding.repository';
import { isAdministrativeRole, losesAdminStanding } from './administrators';
import { EmailService } from '../../common/email/email.service';
import type { InviteUserDto, UpdateUserDto } from './dto/users.dto';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly repository: UsersRepository,
    private readonly audit: AuditRepository,
    private readonly membershipCache: MembershipCacheService,
    private readonly config: AppConfig,
    private readonly invitations: InvitationsService,
    private readonly email: EmailService,
    private readonly offboarding: OffboardingService,
    private readonly offboardingRepository: OffboardingRepository,
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
      mobile: await this.canonicalMobile(dto.mobile),
      roleId: role.id,
      invitedById: principal.userId,
      inviteTokenHash: minted.hash,
      inviteExpiresAt: minted.expiresAt,
    });

    /*
     * The delivery outcome IS surfaced to the caller — it did not used to be,
     * and that is how a broken mail transport stayed invisible.
     *
     * The old reasoning was sound as far as it went: the invitation exists
     * whether or not the email lands, so failing the request would report a
     * pending invitation as failed. But discarding the result entirely made
     * the opposite error, and a worse one — the screen said "invitation sent"
     * while nothing had been. An administrator had no way to tell, and the
     * person they invited simply never heard from us.
     *
     * So the request still succeeds, and the response says which of the two
     * things actually happened.
     */
    const [inviter, organizationName] = await Promise.all([
      this.repository.findMember(principal.userId),
      this.repository.organizationName(),
    ]);

    const delivery = await this.email.sendInvitation({
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

    if (!delivery.accepted) {
      /*
       * An invitation nobody was told about is an operational problem, not a
       * caller-facing failure — the same treatment the contact form gives a
       * lost notification. It goes to the operator, and the response below
       * tells the administrator so they can resend.
       */
      this.logger.error(
        { invitationId: membership.id, provider: this.email.providerName },
        'Invitation email was not accepted by the mail provider',
      );
    }

    return {
      userId: user.id,
      // The membership row IS the invitation; its id is what resend and revoke
      // address.
      invitationId: membership.id,
      email: user.email,
      role: membership.role.key as RoleKey,
      status: membership.status as UserStatus,
      emailDelivered: delivery.accepted,
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
  /**
   * A colleague's own mobile number, in E.164.
   *
   * The same canonical form the CRM stores for customers, so the one column
   * that holds a salesperson's number is not the only one in the database
   * written however somebody typed it. Read against the organization's
   * country; an invalid number is a validation error, and an omitted one stays
   * omitted.
   */
  private async canonicalMobile(input: string | undefined): Promise<string | undefined> {
    const result = parsePhone(input, { country: await this.repository.organizationCountry() });

    if (result.status === 'ABSENT') return undefined;
    if (result.status === 'INVALID') {
      throw AppException.validation('Invalid phone number.', { mobile: [result.reason] });
    }

    return result.e164;
  }

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
   * Turns the repository's rollback signal into the API's refusal.
   *
   * The invariant is enforced by aborting the transaction, which is the only
   * thing that works under concurrency. Callers still need the same 403 they
   * would have got from the pre-check, so the two paths converge here.
   */
  private async guardAdministrators<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof LastAdministratorError) {
        throw new AppException(
          ERROR_CODES.LAST_ADMINISTRATOR,
          'This is the last active administrator. Promote someone else first, or ' +
            'transfer admin responsibility.',
          HttpStatus.FORBIDDEN,
        );
      }
      throw error;
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

    // Mutate inside the guard: the pre-check above is a courtesy that gives a
    // clear message in the ordinary case, but only this can survive two
    // administrators removing each other at the same instant.
    const removed = await this.guardAdministrators(() =>
      this.offboardingRepository.mutateGuardingAdministrators((tx) =>
        this.repository.removeMember(userId, tx),
      ),
    );
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

    const removed = await this.guardAdministrators(() =>
      this.offboardingRepository.mutateGuardingAdministrators((tx) =>
        this.repository.removeMember(principal.userId, tx),
      ),
    );
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

    /*
     * A change that could cost the organization an administrator goes through
     * the guard; anything else does not need a serializable transaction and
     * should not pay for one.
     */
    const touchesAdminStanding = dto.role !== undefined || dto.status !== undefined;

    // Canonicalised on the same terms as the invite path, and before either
    // branch: a colleague's number must not depend on whether the same request
    // also changed their role.
    const mobile = await this.canonicalMobile(dto.mobile);

    const updated = touchesAdminStanding
      ? await this.guardAdministrators(() =>
          this.offboardingRepository.mutateGuardingAdministrators((tx) =>
            this.repository.updateMember(
              userId,
              { fullName: dto.fullName, mobile, roleId, status: dto.status },
              tx,
            ),
          ),
        )
      : await this.repository.updateMember(userId, {
          fullName: dto.fullName,
          mobile,
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
