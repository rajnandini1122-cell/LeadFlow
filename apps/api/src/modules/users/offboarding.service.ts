import { Injectable } from '@nestjs/common';
import { ERROR_CODES, type Paginated, type RoleKey } from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import { AuditRepository } from '../../common/audit/audit.repository';
import { PlatformService } from '../../common/platform/platform.service';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { MembershipCacheService } from '../auth/membership-cache.service';
import { isAdministrativeRole } from './administrators';
import { OffboardingRepository, type Workload } from './offboarding.repository';
import { UsersRepository } from './users.repository';

export interface WorkloadReport extends Workload {
  userId: string;
  fullName: string;
  role: RoleKey;
  status: string;
  /** True when an exit would orphan work unless a successor is named. */
  requiresReassignment: boolean;
  /** Colleagues eligible to take the work over. */
  eligibleSuccessors: { id: string; fullName: string; role: RoleKey }[];
}

export interface OffboardResult {
  action: 'DEACTIVATE' | 'REMOVE';
  userId: string;
  reassignToId: string | null;
  leadsReassigned: number;
  historicalLeadsReassigned: number;
  followUpsReassigned: number;
}

export interface AuditEntryView {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  actor: { id: string; fullName: string } | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

/**
 * Employee exit, lead handover and administrator protection.
 *
 * Split from UsersService because the rules are different in kind: that class
 * is about who someone IS, this one is about what happens to their WORK. They
 * share the same repository and the same RBAC — there is deliberately no second
 * authorization model here.
 */
@Injectable()
export class OffboardingService {
  constructor(
    private readonly repository: OffboardingRepository,
    private readonly users: UsersRepository,
    private readonly audit: AuditRepository,
    private readonly membershipCache: MembershipCacheService,
    private readonly platform: PlatformService,
  ) {}

  // ---------------------------------------------------------------------------
  // Administrator protection
  // ---------------------------------------------------------------------------

  /**
   * Refuses an action that would leave the organization unadministrable.
   *
   * The single gate for removal, deactivation, demotion and leaving alike. Four
   * copies of this rule would be four chances for one to be wrong, and the
   * failure mode is a customer locked out of their own organization with no
   * in-product way back.
   */
  async assertRetainsAdministrator(member: {
    userId: string;
    role: RoleKey;
    status: string;
  }): Promise<void> {
    if (!isAdministrativeRole(member.role) || member.status !== 'ACTIVE') return;

    const remaining = await this.repository.countActiveAdministratorsExcluding(member.userId);
    if (remaining === 0) {
      throw new AppException(
        ERROR_CODES.LAST_ADMINISTRATOR,
        'This is the last active administrator. Promote someone else first, or ' +
          'transfer admin responsibility.',
        403,
      );
    }
  }

  /**
   * Last line of defence, called after a change has landed.
   *
   * If an organization ever DOES reach zero administrators, the guards above
   * have a hole and a customer is locked out right now. That is an operator
   * problem, not a tenant one, so it is raised as a platform alert rather than
   * failing the request that discovered it.
   */
  async verifyAdministratorRemains(context: Record<string, unknown>): Promise<void> {
    const remaining = await this.repository.countActiveAdministrators();
    if (remaining === 0) {
      this.platform.criticalAlert('organization.no_active_administrator', context);
    }
  }

  // ---------------------------------------------------------------------------
  // Workload
  // ---------------------------------------------------------------------------

  async workload(userId: string): Promise<WorkloadReport> {
    const member = await this.users.findMember(userId);
    // A member of another organization is indistinguishable from one that does
    // not exist — the same rule the rest of the API follows.
    if (!member) throw AppException.userNotFound();

    const [workload, colleagues] = await Promise.all([
      this.repository.workloadOf(userId),
      this.users.listMembers(),
    ]);

    return {
      ...workload,
      userId,
      fullName: member.user.fullName,
      role: member.role.key as RoleKey,
      status: member.status,
      requiresReassignment: workload.activeLeads > 0 || workload.openFollowUps > 0,
      eligibleSuccessors: colleagues
        .filter((row) => row.status === 'ACTIVE' && row.userId !== userId)
        .map((row) => ({
          id: row.userId,
          fullName: row.user.fullName,
          role: row.role.key as RoleKey,
        })),
    };
  }

  /**
   * Refuses an exit that would orphan active work.
   *
   * Called by remove, deactivate and leave. The counts travel in the error
   * details so the client can say "42 active leads and 12 open follow-ups"
   * rather than a bare refusal the admin cannot act on.
   */
  async assertNoOrphanedWork(userId: string): Promise<Workload> {
    const workload = await this.repository.workloadOf(userId);

    if (workload.activeLeads > 0 || workload.openFollowUps > 0) {
      throw new AppException(
        ERROR_CODES.REASSIGNMENT_REQUIRED,
        `This member owns ${workload.activeLeads} active ` +
          `${workload.activeLeads === 1 ? 'lead' : 'leads'} and has ` +
          `${workload.openFollowUps} open ` +
          `${workload.openFollowUps === 1 ? 'follow-up' : 'follow-ups'}. ` +
          'Choose a colleague to take the work over first.',
        409,
        {
          activeLeads: [String(workload.activeLeads)],
          openFollowUps: [String(workload.openFollowUps)],
        },
      );
    }

    return workload;
  }

  // ---------------------------------------------------------------------------
  // Offboarding
  // ---------------------------------------------------------------------------

  /**
   * Hands a member's work over and then deactivates or removes them.
   *
   * Strictly in that order. Deactivating first and reassigning afterwards would
   * leave a window — however short — in which fifty customers had an owner who
   * could no longer sign in, and if the second step failed the window would
   * never close.
   */
  async offboard(
    userId: string,
    input: {
      action: 'DEACTIVATE' | 'REMOVE';
      reassignToId?: string | undefined;
      includeHistorical?: boolean | undefined;
      reason?: string | undefined;
    },
    principal: TenantPrincipal,
  ): Promise<OffboardResult> {
    const member = await this.users.findMember(userId);
    if (!member) throw AppException.userNotFound();

    if (userId === principal.userId) {
      throw AppException.forbidden(
        'Use "leave organization" to offboard yourself, so the confirmation is explicit.',
      );
    }
    if (member.role.key === 'OWNER' && principal.role !== 'OWNER') {
      throw AppException.forbidden('Only an owner can offboard another owner.');
    }

    await this.assertRetainsAdministrator({
      userId,
      role: member.role.key as RoleKey,
      status: member.status,
    });

    const moved = await this.handOver(userId, input, principal);

    if (input.action === 'REMOVE') {
      const removed = await this.users.removeMember(userId);
      if (removed === 0) throw AppException.userNotFound();
      await this.users.revokeSessions(userId, 'MEMBER_REMOVED');
    } else {
      const updated = await this.users.updateMember(userId, { status: 'SUSPENDED' });
      if (!updated) throw AppException.userNotFound();
      await this.users.revokeSessions(userId, 'MEMBER_SUSPENDED');
    }

    // Both are needed: revoking sessions stops refresh, invalidating the cache
    // stops a still-valid access token being honoured by a guard reading a
    // stale membership.
    await this.membershipCache.invalidate(userId, principal.organizationId);

    await this.audit.record({
      action: 'user.offboarded',
      entityType: 'user',
      entityId: userId,
      before: { role: member.role.key, status: member.status },
      after: {
        action: input.action,
        reassignToId: input.reassignToId ?? null,
        includeHistorical: input.includeHistorical === true,
        ...moved,
      },
    });

    await this.verifyAdministratorRemains({
      organizationId: principal.organizationId,
      trigger: 'offboard',
      userId,
    });

    return {
      action: input.action,
      userId,
      reassignToId: input.reassignToId ?? null,
      ...moved,
    };
  }

  /**
   * Reassigns work, when there is any and a successor was named.
   *
   * Also used by the voluntary-leave path, so the validation of a successor
   * lives in exactly one place.
   */
  async handOver(
    fromUserId: string,
    input: {
      reassignToId?: string | undefined;
      includeHistorical?: boolean | undefined;
      reason?: string | undefined;
    },
    principal: TenantPrincipal,
  ): Promise<{
    leadsReassigned: number;
    historicalLeadsReassigned: number;
    followUpsReassigned: number;
  }> {
    const empty = {
      leadsReassigned: 0,
      historicalLeadsReassigned: 0,
      followUpsReassigned: 0,
    };

    if (!input.reassignToId) {
      // No successor named: allowed only if there is nothing to orphan. This
      // throws with the counts when there is.
      await this.assertNoOrphanedWork(fromUserId);
      return empty;
    }

    if (input.reassignToId === fromUserId) {
      throw AppException.validation('Cannot hand work back to the person leaving.', {
        reassignToId: ['must be a different member'],
      });
    }

    // The successor must be an ACTIVE member of THIS organization. The lookup
    // is tenant-scoped, so a valid id from another organization simply does not
    // resolve — which is what makes cross-tenant reassignment impossible rather
    // than merely discouraged.
    const successor = await this.repository.findActiveMember(input.reassignToId);
    if (!successor) {
      throw AppException.validation('Cannot hand the work over to that user.', {
        reassignToId: ['must be an active member of your organization'],
      });
    }

    const moved = await this.repository.reassignWork({
      fromUserId,
      toUserId: input.reassignToId,
      actorId: principal.userId,
      includeHistorical: input.includeHistorical === true,
      reason: input.reason ?? 'Reassigned when the previous owner left the team',
    });

    if (
      moved.leadsReassigned > 0 ||
      moved.followUpsReassigned > 0 ||
      moved.historicalLeadsReassigned > 0
    ) {
      await this.audit.record({
        action: 'lead.bulk_reassigned',
        entityType: 'user',
        entityId: fromUserId,
        before: { fromUserId },
        after: { toUserId: input.reassignToId, ...moved },
      });
    }

    return moved;
  }

  // ---------------------------------------------------------------------------
  // Admin transfer
  // ---------------------------------------------------------------------------

  /**
   * Hands administrative responsibility to another active member.
   *
   * The reason this exists as its own operation rather than two role edits: an
   * owner cannot change their own role (a deliberate rule that stops an
   * accidental self-demotion), so without this there is no way for a departing
   * owner to name a successor.
   */
  async transferAdmin(
    input: { toUserId: string; stepDown: boolean },
    principal: TenantPrincipal,
  ): Promise<{ newAdminId: string; steppedDown: boolean }> {
    if (input.toUserId === principal.userId) {
      throw AppException.validation('You already hold admin responsibility.', {
        toUserId: ['must be a different member'],
      });
    }

    const successor = await this.users.findMember(input.toUserId);
    if (!successor) throw AppException.userNotFound();

    if (successor.status !== 'ACTIVE') {
      // Handing the organization to someone who cannot sign in is the same as
      // handing it to nobody.
      throw AppException.validation('That member is not active.', {
        toUserId: ['must be an active member of your organization'],
      });
    }

    const promoted = await this.repository.setRole(input.toUserId, 'OWNER');
    if (!promoted) throw AppException.userNotFound();

    if (input.stepDown) {
      // ADMIN, not SALES_REP: the outgoing owner keeps day-to-day
      // administrative access and only gives up ownership. Dropping them
      // straight to a rep is a bigger change than they asked for.
      await this.repository.setRole(principal.userId, 'ADMIN');
      await this.membershipCache.invalidate(principal.userId, principal.organizationId);
    }

    await this.membershipCache.invalidate(input.toUserId, principal.organizationId);

    await this.audit.record({
      action: 'user.admin_transferred',
      entityType: 'user',
      entityId: input.toUserId,
      before: { fromUserId: principal.userId, previousRole: successor.role.key },
      after: { newRole: 'OWNER', steppedDown: input.stepDown },
    });

    await this.verifyAdministratorRemains({
      organizationId: principal.organizationId,
      trigger: 'transfer_admin',
    });

    return { newAdminId: input.toUserId, steppedDown: input.stepDown };
  }

  // ---------------------------------------------------------------------------
  // Audit trail
  // ---------------------------------------------------------------------------

  async auditTrail(options: {
    limit?: number | undefined;
    cursor?: string | undefined;
  }): Promise<Paginated<AuditEntryView>> {
    const limit = options.limit ?? 50;
    const rows = await this.repository.auditTrail(limit, options.cursor);

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((row) => ({
      id: row.id,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      actor: row.actor,
      before: row.before,
      after: row.after,
      createdAt: row.createdAt.toISOString(),
    }));

    return {
      items,
      hasMore,
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  }
}
