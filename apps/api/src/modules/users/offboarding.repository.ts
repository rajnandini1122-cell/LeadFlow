import { Injectable } from '@nestjs/common';
import type { RoleKey } from '@leadflow/api-types';
import { PrismaService, type PrismaTransaction } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
import { ADMIN_ROLE_KEYS } from './administrators';

/**
 * Raised when a membership change would leave nobody able to administer the
 * organization. Thrown INSIDE the transaction so it rolls the change back.
 */
export class LastAdministratorError extends Error {
  constructor() {
    super('This change would leave the organization with no active administrator.');
    this.name = 'LastAdministratorError';
  }
}

/** Follow-up states that still represent work somebody owes. */
const OPEN_FOLLOW_UPS = ['UPCOMING', 'DUE', 'OVERDUE'] as const;

export interface Workload {
  activeLeads: number;
  openFollowUps: number;
  wonLeads: number;
  lostLeads: number;
  archivedLeads: number;
  pipelineValue: string;
}

/**
 * Data access for employee exit and lead handover.
 *
 * Every query here goes through a tenant-scoped model — `Lead`, `FollowUp` and
 * `OrganizationUser` are all in TENANT_SCOPED_MODELS — so a foreign userId
 * simply matches nothing rather than reaching across organizations. That is the
 * property the cross-tenant tests exercise.
 */
@Injectable()
export class OffboardingRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Active administrators in this organization, excluding one member. */
  async countActiveAdministratorsExcluding(userId: string): Promise<number> {
    return this.prisma.client.organizationUser.count({
      where: {
        status: 'ACTIVE',
        userId: { not: userId },
        role: { key: { in: ADMIN_ROLE_KEYS } },
      },
    });
  }

  async countActiveAdministrators(): Promise<number> {
    return this.prisma.client.organizationUser.count({
      where: { status: 'ACTIVE', role: { key: { in: ADMIN_ROLE_KEYS } } },
    });
  }

  /**
   * What a member is currently carrying.
   *
   * The active counts are what block an exit; the historical ones are shown
   * alongside so an admin can see the whole picture before deciding whether to
   * move them too.
   */
  async workloadOf(userId: string): Promise<Workload> {
    const [active, followUps, won, lost, archived] = await Promise.all([
      this.prisma.client.lead.aggregate({
        where: { assignedToId: userId, deletedAt: null, status: { notIn: ['WON', 'LOST'] } },
        _count: { _all: true },
        _sum: { estimatedValue: true },
      }),
      this.prisma.client.followUp.count({
        where: { assignedUserId: userId, status: { in: [...OPEN_FOLLOW_UPS] } },
      }),
      this.prisma.client.lead.count({
        where: { assignedToId: userId, deletedAt: null, status: 'WON' },
      }),
      this.prisma.client.lead.count({
        where: { assignedToId: userId, deletedAt: null, status: 'LOST' },
      }),
      this.prisma.client.lead.count({
        where: { assignedToId: userId, deletedAt: { not: null } },
      }),
    ]);

    return {
      activeLeads: active._count._all,
      openFollowUps: followUps,
      wonLeads: won,
      lostLeads: lost,
      archivedLeads: archived,
      pipelineValue: active._sum.estimatedValue?.toString() ?? '0',
    };
  }

  /** An ACTIVE member of this organization, or null. Tenant-scoped. */
  async findActiveMember(userId: string) {
    return this.prisma.client.organizationUser.findFirst({
      where: { userId, status: 'ACTIVE' },
      select: {
        id: true,
        status: true,
        userId: true,
        role: { select: { key: true } },
        user: { select: { id: true, fullName: true } },
      },
    });
  }

  /**
   * Moves a member's work to a colleague, in one transaction.
   *
   * All-or-nothing on purpose: a handover that moved the leads but not the
   * follow-ups would leave the successor holding customers with no next action,
   * which is the exact failure the product exists to prevent.
   *
   * `LeadActivity` rows are NEVER touched. `performed_by` is a record of who
   * did something, and rewriting it to the successor would be a false statement
   * about the past — it would also destroy the only evidence of the leaver's
   * contribution.
   */
  async reassignWork(input: {
    fromUserId: string;
    toUserId: string;
    actorId: string;
    includeHistorical: boolean;
    reason: string;
  }): Promise<{
    leadsReassigned: number;
    historicalLeadsReassigned: number;
    followUpsReassigned: number;
  }> {
    const organizationId = this.tenantContext.requireOrganizationId();

    return this.prisma.client.$transaction(async (tx) => {
      const activeLeads = await tx.lead.findMany({
        where: {
          assignedToId: input.fromUserId,
          deletedAt: null,
          status: { notIn: ['WON', 'LOST'] },
        },
        select: { id: true },
      });

      const historicalLeads = input.includeHistorical
        ? await tx.lead.findMany({
            where: {
              assignedToId: input.fromUserId,
              OR: [{ status: { in: ['WON', 'LOST'] } }, { deletedAt: { not: null } }],
            },
            select: { id: true },
          })
        : [];

      const leadIds = [...activeLeads, ...historicalLeads].map((lead) => lead.id);

      if (leadIds.length > 0) {
        await tx.lead.updateMany({
          where: { id: { in: leadIds } },
          data: {
            assignedToId: input.toUserId,
            assignedById: input.actorId,
            updatedBy: input.actorId,
          },
        });

        // One timeline entry per lead, attributed to the ADMIN who performed
        // the handover — they are the one who did this, not the leaver and not
        // the successor.
        await tx.leadActivity.createMany({
          data: leadIds.map((leadId) => ({
            organizationId,
            leadId,
            activityType: 'LEAD_REASSIGNED' as const,
            description: input.reason,
            performedById: input.actorId,
          })),
        });
      }

      // Only OPEN follow-ups move. A completed one is a record of work already
      // done by the leaver; a cancelled one is owed to nobody.
      const followUps = await tx.followUp.updateMany({
        where: {
          assignedUserId: input.fromUserId,
          status: { in: [...OPEN_FOLLOW_UPS] },
        },
        data: { assignedUserId: input.toUserId },
      });

      return {
        leadsReassigned: activeLeads.length,
        historicalLeadsReassigned: historicalLeads.length,
        followUpsReassigned: followUps.count,
      };
    });
  }

  /** Promotes a member to an administrative role. Tenant-scoped. */
  async setRole(userId: string, roleKey: RoleKey, tx?: PrismaTransaction): Promise<boolean> {
    const client = tx ?? this.prisma.client;

    const role = await client.role.findFirst({
      where: { key: roleKey, organizationId: null, isSystem: true },
      select: { id: true },
    });
    if (!role) return false;

    const result = await client.organizationUser.updateMany({
      where: { userId, status: { not: 'REMOVED' } },
      data: { roleId: role.id },
    });

    return result.count > 0;
  }

  /**
   * Runs a membership change and refuses to commit it if the organization
   * would be left with nobody able to administer it.
   *
   * Checking BEFORE the write cannot work, however carefully it is written.
   * Two administrators removing each other at the same instant each observe
   * the other still present, each conclude they are safe, and both proceed —
   * leaving zero. The check has to see the result of the write, and the write
   * has to be undone if the answer is wrong.
   *
   * So the order is inverted: mutate, then count, then throw to roll back.
   * SERIALIZABLE is what makes the count trustworthy — under the default READ
   * COMMITTED each transaction would count without seeing the other's
   * uncommitted removal and both would still commit. Postgres instead aborts
   * one of them with a serialization failure, which is translated below into
   * the same refusal a sequential caller would have received.
   */
  async mutateGuardingAdministrators<T>(fn: (tx: PrismaTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.client.$transaction(
        async (tx) => {
          const result = await fn(tx);

          const remaining = await tx.organizationUser.count({
            where: { status: 'ACTIVE', role: { key: { in: ADMIN_ROLE_KEYS } } },
          });

          if (remaining === 0) throw new LastAdministratorError();

          return result;
        },
        { isolationLevel: 'Serializable' },
      );
    } catch (error) {
      // 40001 serialization_failure, 40P01 deadlock_detected. Both mean a
      // competing membership change won; the honest answer is the same one the
      // loser would have received had they arrived second.
      const code = (error as { code?: string }).code;
      if (code === '40001' || code === '40P01' || code === 'P2034') {
        throw new LastAdministratorError();
      }
      throw error;
    }
  }

  /** Recent audit entries for this organization, newest first. */
  async auditTrail(limit: number, cursor?: string) {
    const organizationId = this.tenantContext.requireOrganizationId();

    // AuditLog is deliberately NOT in TENANT_SCOPED_MODELS — some entries have
    // no resolvable tenant — so this is the one place the filter is explicit.
    return this.prisma.client.auditLog.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        before: true,
        after: true,
        createdAt: true,
        actor: { select: { id: true, fullName: true } },
      },
    });
  }
}

export { OPEN_FOLLOW_UPS };
