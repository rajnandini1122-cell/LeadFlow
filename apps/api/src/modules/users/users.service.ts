import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type {
  InviteUserResponse,
  RoleKey,
  UserListItem,
  UserStatus,
} from '@leadflow/api-types';
import { AppConfig } from '../../common/config/config.module';
import { AppException } from '../../common/errors/app.exception';
import { AUDIT_ACTIONS, AuditRepository } from '../../common/audit/audit.repository';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { MembershipCacheService } from '../auth/membership-cache.service';
import { UsersRepository } from './users.repository';
import type { InviteUserDto, UpdateUserDto } from './dto/users.dto';

const INVITE_TTL_DAYS = 7;

@Injectable()
export class UsersService {
  constructor(
    private readonly repository: UsersRepository,
    private readonly audit: AuditRepository,
    private readonly membershipCache: MembershipCacheService,
    private readonly config: AppConfig,
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
    if (existing && (await this.repository.membershipExists(existing.id))) {
      throw AppException.conflict('USER_ALREADY_EXISTS', 'That user is already in this organization.');
    }

    // Only the hash is stored, so a database disclosure yields no usable
    // invite links — the same reasoning as refresh tokens.
    const inviteToken = randomBytes(32).toString('base64url');
    const inviteTokenHash = createHash('sha256').update(inviteToken).digest('hex');

    const { user, membership } = await this.repository.inviteMember({
      email: dto.email,
      fullName: dto.fullName,
      mobile: dto.mobile,
      roleId: role.id,
      invitedById: principal.userId,
      inviteTokenHash,
      inviteExpiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
    });

    await this.audit.record({
      action: AUDIT_ACTIONS.USER_INVITED,
      entityType: 'user',
      entityId: user.id,
      after: { email: dto.email, role: dto.role },
    });

    return {
      userId: user.id,
      email: user.email,
      role: membership.role.key as RoleKey,
      status: membership.status as UserStatus,
      // Returned outside production so the invite flow is testable without an
      // email provider. In production this would leak a credential into logs
      // and proxies, so it is withheld and the link is emailed instead.
      ...(this.config.isProduction ? {} : { inviteToken }),
    };
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

    // An organization with no active owner is unrecoverable without support
    // intervention, so the last one cannot be demoted or suspended — by anyone,
    // including themselves.
    const losingOwner =
      before.role.key === 'OWNER' &&
      before.status === 'ACTIVE' &&
      ((dto.role !== undefined && dto.role !== 'OWNER') || dto.status === 'SUSPENDED');

    if (losingOwner) {
      const owners = await this.repository.countActiveOwners();
      if (owners <= 1) {
        throw AppException.forbidden(
          'This is the last active owner. Promote another owner first.',
        );
      }
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

    await this.audit.record({
      action: dto.role ? AUDIT_ACTIONS.ROLE_CHANGED : AUDIT_ACTIONS.USER_UPDATED,
      entityType: 'user',
      entityId: userId,
      before: { role: before.role.key, status: before.status },
      after: { role: updated.role.key, status: updated.status },
    });

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
