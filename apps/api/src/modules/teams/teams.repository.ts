import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
import type { TeamStatus } from '../../generated/prisma/enums';

/**
 * Team data access.
 *
 * `Team` and `TeamMember` are in TENANT_SCOPED_MODELS, so nothing here names
 * organizationId on a read — the extension narrows every query and fails
 * closed without a context. Writes state it explicitly because Prisma's
 * generated types cannot see the runtime extension.
 *
 * Two invariants are the database's rather than this file's, and that is the
 * point: one active team per name per organization, and one active membership
 * per person per team. Both are partial unique indexes, so two concurrent
 * requests that each find nothing still produce exactly one row.
 */
@Injectable()
export class TeamsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private get organizationId(): string {
    return this.tenantContext.requireOrganizationId();
  }

  async list(includeArchived: boolean) {
    return this.prisma.client.team.findMany({
      where: includeArchived ? {} : { status: 'ACTIVE' },
      include: TEAM_INCLUDE,
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });
  }

  async findById(id: string) {
    return this.prisma.client.team.findFirst({ where: { id }, include: TEAM_INCLUDE });
  }

  /** Null when the unique index refused it — another ACTIVE team has the name. */
  async create(input: {
    name: string;
    nameKey: string;
    description?: string | undefined;
    managerMembershipId?: string | undefined;
  }) {
    const created = await this.prisma.client.team.createManyAndReturn({
      skipDuplicates: true,
      data: [
        {
          organizationId: this.organizationId,
          name: input.name,
          nameKey: input.nameKey,
          description: input.description ?? null,
          managerMembershipId: input.managerMembershipId ?? null,
        },
      ],
      select: { id: true },
    });

    return created[0] ?? null;
  }

  /**
   * Applies changes, or reports a name collision.
   *
   * `updateMany` rather than `update`, so the tenant scope is part of the
   * WHERE rather than something checked beforehand: a team belonging to
   * another organization matches nothing and reports not-found without a
   * second query confirming it exists.
   */
  async update(
    id: string,
    changes: {
      name?: string;
      nameKey?: string;
      description?: string | null;
      managerMembershipId?: string | null;
      status?: TeamStatus;
    },
  ): Promise<'UPDATED' | 'NAME_TAKEN'> {
    try {
      await this.prisma.client.team.updateMany({ where: { id }, data: changes });
      return 'UPDATED';
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') return 'NAME_TAKEN';
      throw error;
    }
  }

  /** The membership behind a user id, in THIS organization. */
  async findMembership(userId: string) {
    return this.prisma.client.organizationUser.findFirst({
      where: { userId },
      select: {
        id: true,
        status: true,
        role: { select: { key: true } },
        user: { select: { id: true, fullName: true, email: true, avatarUrl: true } },
      },
    });
  }

  /** Every member of this organization, with the teams they belong to. */
  async listMembershipsWithTeams() {
    return this.prisma.client.organizationUser.findMany({
      where: { status: { not: 'REMOVED' } },
      select: {
        id: true,
        status: true,
        role: { select: { key: true } },
        user: { select: { id: true, fullName: true, email: true, avatarUrl: true } },
        teamMembers: {
          where: { removedAt: null },
          select: {
            assignmentEnabled: true,
            team: { select: { id: true, name: true, status: true } },
          },
        },
      },
      orderBy: { user: { fullName: 'asc' } },
    });
  }

  /**
   * Active routing rules pointing at this team.
   *
   * Read from the teams module rather than through the assignment-rules
   * service, because the reverse would make the two modules import each other
   * — and this is one scoped count, not a second opinion about what a rule
   * means.
   */
  async activeRulesTargeting(teamId: string): Promise<{ id: string; name: string }[]> {
    return this.prisma.client.assignmentRule.findMany({
      where: { targetTeamId: teamId, status: 'ACTIVE' },
      select: { id: true, name: true },
      orderBy: { priority: 'asc' },
    });
  }

  async findActiveMember(teamId: string, membershipId: string) {
    return this.prisma.client.teamMember.findFirst({
      where: { teamId, organizationMembershipId: membershipId, removedAt: null },
      select: { id: true },
    });
  }

  /**
   * Adds somebody to a team, or reports that they are already in it.
   *
   * ON CONFLICT DO NOTHING through `skipDuplicates`, against the partial
   * unique index. A read followed by an insert cannot hold here: two
   * administrators clicking "add" at the same moment both find nothing and
   * both write, and the second row would be a person counted twice in every
   * future assignment calculation.
   */
  async addMember(input: { teamId: string; membershipId: string }) {
    const created = await this.prisma.client.teamMember.createManyAndReturn({
      skipDuplicates: true,
      data: [
        {
          organizationId: this.organizationId,
          teamId: input.teamId,
          organizationMembershipId: input.membershipId,
        },
      ],
      select: { id: true, assignmentEnabled: true },
    });

    return created[0] ?? null;
  }

  /** Soft removal: history is kept, and re-adding later is a new row. */
  async removeMember(teamId: string, teamMemberId: string): Promise<number> {
    const result = await this.prisma.client.teamMember.updateMany({
      where: { id: teamMemberId, teamId, removedAt: null },
      data: { removedAt: new Date() },
    });

    return result.count;
  }

  async setAssignmentEnabled(
    teamId: string,
    teamMemberId: string,
    assignmentEnabled: boolean,
  ): Promise<number> {
    const result = await this.prisma.client.teamMember.updateMany({
      where: { id: teamMemberId, teamId, removedAt: null },
      data: { assignmentEnabled },
    });

    return result.count;
  }

  async findMemberRow(teamId: string, teamMemberId: string) {
    return this.prisma.client.teamMember.findFirst({
      where: { id: teamMemberId, teamId },
      select: { id: true, organizationMembershipId: true, removedAt: true },
    });
  }

  /**
   * Removes a member and clears the manager reference in ONE transaction when
   * that member is the manager.
   *
   * Atomic because the alternative is a team that names a manager who is not
   * in it — a contradiction that reads as data corruption to whoever finds it,
   * and one that a failed second statement would leave behind permanently.
   */
  async removeMemberAndClearManager(input: {
    teamId: string;
    teamMemberId: string;
    membershipId: string;
  }): Promise<number> {
    return this.prisma.client.$transaction(async (tx) => {
      const removed = await tx.teamMember.updateMany({
        where: { id: input.teamMemberId, teamId: input.teamId, removedAt: null },
        data: { removedAt: new Date() },
      });

      if (removed.count > 0) {
        await tx.team.updateMany({
          where: { id: input.teamId, managerMembershipId: input.membershipId },
          data: { managerMembershipId: null },
        });
      }

      return removed.count;
    });
  }
}

/** Everything a team view needs, in one query rather than one per team. */
const TEAM_INCLUDE = {
  manager: {
    select: {
      id: true,
      role: { select: { key: true } },
      user: { select: { id: true, fullName: true } },
    },
  },
  members: {
    where: { removedAt: null },
    select: {
      id: true,
      assignmentEnabled: true,
      joinedAt: true,
      membership: {
        select: {
          id: true,
          status: true,
          role: { select: { key: true } },
          user: { select: { id: true, fullName: true, email: true, avatarUrl: true } },
        },
      },
    },
    orderBy: { joinedAt: 'asc' },
  },
} as const;
