import { Injectable } from '@nestjs/common';
import { PrismaService, type PrismaTransaction } from '../../common/prisma/prisma.service';
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

  /**
   * The client to write through.
   *
   * A caller's transaction when there is one, the pooled client otherwise. Two
   * reasons a caller supplies one, and the second is not a preference: a
   * control-plane mutation must commit together with the ledger row proving it
   * happened, and a query that reached the pool for its own connection while
   * the caller's transaction held one would deadlock as soon as the pool ran
   * out — which on a single-connection database is immediately.
   */
  private db(tx?: PrismaTransaction) {
    return tx ?? this.prisma.client;
  }

  async list(includeArchived: boolean, tx?: PrismaTransaction) {
    return this.db(tx).team.findMany({
      where: includeArchived ? {} : { status: 'ACTIVE' },
      include: TEAM_INCLUDE,
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });
  }

  /**
   * One team with its live members.
   *
   * Takes an optional transaction so the assignment pipeline can read the
   * candidate list INSIDE the transaction that assigns from it. Reading it
   * outside would mean choosing from a snapshot: somebody suspended a
   * millisecond later would still get the lead, and the check would have been
   * decoration.
   *
   * The eligibility RULE itself is not duplicated anywhere — this returns the
   * rows, and `isEligibleForAssignment` decides, exactly as it does for the
   * HTTP path.
   */
  async findById(id: string, tx?: PrismaTransaction) {
    return this.db(tx).team.findFirst({ where: { id }, include: TEAM_INCLUDE });
  }

  /** Null when the unique index refused it — another ACTIVE team has the name. */
  async create(
    input: {
      name: string;
      nameKey: string;
      description?: string | undefined;
      managerMembershipId?: string | undefined;
    },
    tx?: PrismaTransaction,
  ) {
    const created = await this.db(tx).team.createManyAndReturn({
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
    tx?: PrismaTransaction,
  ): Promise<'UPDATED' | 'NAME_TAKEN'> {
    try {
      await this.db(tx).team.updateMany({ where: { id }, data: changes });
      return 'UPDATED';
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') return 'NAME_TAKEN';
      throw error;
    }
  }

  /**
   * Applies a change that ARCHIVES a team, unless live routing points at it.
   *
   * The ORDER inside the transaction is the whole point, and it is the reverse
   * of the obvious one. The team row is written FIRST, which takes its row
   * lock, and only THEN are the rules targeting it read. A rule being created
   * or activated concurrently must take the same lock before it may write (see
   * `lockActiveTeam`), so it is either already committed and visible to the
   * read below, or still waiting — and when its turn comes it finds the team
   * archived and is refused. There is no ordering in which both succeed.
   *
   * Asking first and writing afterwards is the natural way round and is wrong.
   * Under READ COMMITTED each request reads the world as it was before either
   * wrote: the archive sees no rules, the rule sees an active team, and both
   * commit. What is left is production sending enquiries to a team nobody is
   * watching — a silent failure, found by a customer who was never called.
   *
   * That is not hypothetical. It is what a real PostgreSQL did on CI, and what
   * the single-connection development database cannot show, because it
   * serialises the two requests before they can race at all.
   *
   * PostgreSQL decides this, not a mutex in one process — there are several
   * processes.
   *
   * Returning the blocking rules rather than a bare refusal: an administrator
   * needs to know what to pause, and a message that only says no is a message
   * that sends them looking.
   */
  async archiveIfUnused(
    id: string,
    changes: {
      name?: string;
      nameKey?: string;
      description?: string | null;
      managerMembershipId?: string | null;
      status?: TeamStatus;
    },
    outer?: PrismaTransaction,
  ): Promise<'UPDATED' | 'NAME_TAKEN' | { blockedBy: { id: string; name: string }[] }> {
    const run = async (tx: PrismaTransaction) => {
      await tx.team.updateMany({ where: { id }, data: changes });

      const routing = await tx.assignmentRule.findMany({
        where: { targetTeamId: id, status: 'ACTIVE' },
        select: { id: true, name: true },
        orderBy: { priority: 'asc' },
      });

      // Rolls the archive back. A thrown sentinel rather than a returned
      // value, because returning would COMMIT the archive we just decided
      // against.
      if (routing.length > 0) throw new TeamInUse(routing);

      return 'UPDATED' as const;
    };

    try {
      /*
       * A caller's transaction is used as-is rather than nested inside a
       * second one. The lock ordering that makes this safe is unchanged either
       * way: the team row is written before the rules are read.
       *
       * Note that the rollback which normally undoes a refused archive becomes
       * the CALLER's rollback when they supply a transaction — so a caller
       * must treat the blocked result as fatal to their own unit of work.
       */
      return await (outer ? run(outer) : this.prisma.client.$transaction(run));
    } catch (error) {
      if (error instanceof TeamInUse) return { blockedBy: error.rules };
      if ((error as { code?: string }).code === 'P2002') return 'NAME_TAKEN';
      throw error;
    }
  }

  /** The membership behind a user id, in THIS organization. */
  async findMembership(userId: string, tx?: PrismaTransaction) {
    return this.db(tx).organizationUser.findFirst({
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
  async listMembershipsWithTeams(tx?: PrismaTransaction) {
    return this.db(tx).organizationUser.findMany({
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
  async activeRulesTargeting(
    teamId: string,
    tx?: PrismaTransaction,
  ): Promise<{ id: string; name: string }[]> {
    return this.db(tx).assignmentRule.findMany({
      where: { targetTeamId: teamId, status: 'ACTIVE' },
      select: { id: true, name: true },
      orderBy: { priority: 'asc' },
    });
  }

  async findActiveMember(teamId: string, membershipId: string, tx?: PrismaTransaction) {
    return this.db(tx).teamMember.findFirst({
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
  async addMember(input: { teamId: string; membershipId: string }, tx?: PrismaTransaction) {
    const created = await this.db(tx).teamMember.createManyAndReturn({
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
  async removeMember(
    teamId: string,
    teamMemberId: string,
    tx?: PrismaTransaction,
  ): Promise<number> {
    const result = await this.db(tx).teamMember.updateMany({
      where: { id: teamMemberId, teamId, removedAt: null },
      data: { removedAt: new Date() },
    });

    return result.count;
  }

  async setAssignmentEnabled(
    teamId: string,
    teamMemberId: string,
    assignmentEnabled: boolean,
    tx?: PrismaTransaction,
  ): Promise<number> {
    const result = await this.db(tx).teamMember.updateMany({
      where: { id: teamMemberId, teamId, removedAt: null },
      data: { assignmentEnabled },
    });

    return result.count;
  }

  async findMemberRow(teamId: string, teamMemberId: string, tx?: PrismaTransaction) {
    return this.db(tx).teamMember.findFirst({
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
  async removeMemberAndClearManager(
    input: {
      teamId: string;
      teamMemberId: string;
      membershipId: string;
    },
    outer?: PrismaTransaction,
  ): Promise<number> {
    const run = async (tx: PrismaTransaction) => {
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
    };

    // A caller's transaction is used as-is rather than nested inside a second
    // one: the atomicity this method needs is already theirs to provide.
    return outer ? run(outer) : this.prisma.client.$transaction(run);
  }
}

/** Carries the blocking rules out of a rolled-back archive. */
class TeamInUse extends Error {
  constructor(readonly rules: { id: string; name: string }[]) {
    super('Team is referenced by active assignment rules');
    this.name = 'TeamInUse';
  }
}

/**
 * Takes the team row's write lock, and reports whether it may be routed to.
 *
 * Called by the assignment-rules repository INSIDE the transaction that writes
 * the rule, so that an ACTIVE rule and an archived team cannot both come into
 * existence. The archive path (`archiveIfUnused`) writes the same row first and
 * then looks for rules, so the two serialise on this row: whichever gets the
 * lock first, the other sees its committed result.
 *
 * The write is a lock, not a change. `status` is set to the value it already
 * has and `updatedAt` to the value it already has, so the row version changes —
 * which is what acquires the lock — while nothing an administrator can see
 * does. An UPDATE is used rather than SELECT ... FOR UPDATE because raw SQL
 * bypasses tenant scoping and is banned; this takes the same row-level
 * exclusive lock through the scoped client.
 *
 * Returns null when the team is archived, absent, or another tenant's — three
 * cases the caller is right to treat alike, since distinguishing them would say
 * whether an id exists somewhere else.
 */
export async function lockActiveTeam(
  tx: PrismaTransaction,
  teamId: string,
): Promise<{ id: string; name: string } | null> {
  const team = await tx.team.findFirst({
    where: { id: teamId },
    select: { id: true, name: true, status: true, updatedAt: true },
  });

  if (!team || team.status !== 'ACTIVE') return null;

  const locked = await tx.team.updateMany({
    where: { id: teamId, status: 'ACTIVE' },
    data: { status: 'ACTIVE', updatedAt: team.updatedAt },
  });

  // Zero rows means a concurrent archive committed while this transaction
  // waited for the lock. The team is gone as far as new routing goes.
  if (locked.count === 0) return null;

  return { id: team.id, name: team.name };
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
