import { Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  type RoleKey,
  type TeamAgentCandidate,
  type TeamDetail,
  type TeamListItem,
  type TeamMemberView,
  type UserStatus,
} from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import type { PrismaTransaction } from '../../common/prisma/transaction';
import { AuditRepository } from '../../common/audit/audit.repository';
import { auditAttribution, type MutationActor } from '../../common/audit/mutation-actor';
import { TeamsRepository } from './teams.repository';
import { isAssignableRole, isEligibleForAssignment } from './agent-eligibility';
import { teamNameKey } from './team-name';
import type {
  AddTeamMemberDto,
  CreateTeamDto,
  UpdateTeamDto,
  UpdateTeamMemberDto,
} from './dto/teams.dto';

/** Audit actions this module writes. Names follow the existing `noun.verb` style. */
export const TEAM_AUDIT = {
  CREATED: 'team.created',
  UPDATED: 'team.updated',
  ARCHIVED: 'team.archived',
  REACTIVATED: 'team.reactivated',
  MANAGER_CHANGED: 'team.manager_changed',
  MEMBER_ADDED: 'team.member_added',
  MEMBER_REMOVED: 'team.member_removed',
  MEMBER_ASSIGNMENT_CHANGED: 'team.member_assignment_changed',
} as const;

/**
 * Sales teams: the structure, and nothing that routes work.
 *
 * There is no assignment algorithm here — no round robin, no least-loaded, no
 * territory, no product matching — and no website intake is converted into a
 * lead. Those need a policy this phase is not the place to invent, and writing
 * half of one now would mean rewriting it when the real requirements arrive.
 * What this provides is the input those algorithms will read: who is in which
 * team, who is available, and who is a candidate at all.
 *
 * Two rules run through everything below:
 *
 *   organization membership is authoritative. A team never overrides it: a
 *   suspended colleague is not an assignment candidate however their team row
 *   is configured, and their team history is not rewritten to say so.
 *
 *   a team is not an authorization boundary. Being named manager carries
 *   responsibility and grants nothing — what somebody may do is Role and
 *   RolePermission, exactly as before.
 */
@Injectable()
export class TeamsService {
  constructor(
    private readonly repository: TeamsRepository,
    private readonly audit: AuditRepository,
  ) {}

  async list(includeArchived: boolean, tx?: PrismaTransaction): Promise<TeamListItem[]> {
    const teams = await this.repository.list(includeArchived, tx);
    return teams.map((team) => toListItem(team));
  }

  async findOne(id: string, tx?: PrismaTransaction): Promise<TeamDetail> {
    const team = await this.requireTeam(id, tx);

    return {
      ...toListItem(team),
      members: team.members.map((member) => toMemberView(member, team.status)),
    };
  }

  async create(
    dto: CreateTeamDto,
    actor: MutationActor,
    tx?: PrismaTransaction,
  ): Promise<TeamDetail> {
    const manager = dto.managerUserId
      ? await this.requireManager(dto.managerUserId, tx)
      : undefined;

    const created = await this.repository.create(
      {
        name: dto.name,
        nameKey: teamNameKey(dto.name),
        description: dto.description,
        ...(manager ? { managerMembershipId: manager.id } : {}),
      },
      tx,
    );

    if (!created) {
      // The partial unique index refused it. Archived teams are excluded from
      // that index, so this really is a live team with the same name.
      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        'A team with this name already exists. Use a different name, or reactivate the existing team.',
      );
    }

    await this.audit.record({
      action: TEAM_AUDIT.CREATED,
      entityType: 'Team',
      entityId: created.id,
      ...auditAttribution(actor),
      after: { name: dto.name, managerMembershipId: manager?.id ?? null },
      tx,
    });

    /*
     * The manager joins the team they manage.
     *
     * Without this a team can name a manager who is not in it, which reads as
     * a bug to everyone who sees it and makes "who is in this team" two
     * different answers depending on which column you read.
     */
    if (manager) {
      await this.repository.addMember({ teamId: created.id, membershipId: manager.id }, tx);
    }

    return this.findOne(created.id, tx);
  }

  async update(
    id: string,
    dto: UpdateTeamDto,
    actor: MutationActor,
    tx?: PrismaTransaction,
  ): Promise<TeamDetail> {
    const team = await this.requireTeam(id, tx);

    const changes: Parameters<TeamsRepository['update']>[1] = {};
    const auditBefore: Record<string, unknown> = {};
    const auditAfter: Record<string, unknown> = {};

    if (dto.name !== undefined && dto.name !== team.name) {
      changes.name = dto.name;
      changes.nameKey = teamNameKey(dto.name);
      auditBefore['name'] = team.name;
      auditAfter['name'] = dto.name;
    }

    if (dto.description !== undefined) {
      changes.description = dto.description ?? null;
    }

    let managerChanged = false;
    if (dto.managerUserId !== undefined) {
      const manager = dto.managerUserId ? await this.requireManager(dto.managerUserId, tx) : null;
      const nextManagerId = manager?.id ?? null;

      if (nextManagerId !== team.managerMembershipId) {
        changes.managerMembershipId = nextManagerId;
        managerChanged = true;
        auditBefore['managerMembershipId'] = team.managerMembershipId;
        auditAfter['managerMembershipId'] = nextManagerId;
      }

      // Same reasoning as create: the manager belongs in the team.
      if (manager) await this.repository.addMember({ teamId: id, membershipId: manager.id }, tx);
    }

    let statusChanged: 'ARCHIVED' | 'REACTIVATED' | undefined;
    if (dto.status !== undefined && dto.status !== team.status) {
      /*
       * Archiving a team that live routing points at is REFUSED.
       *
       * The alternatives are both worse. Letting it through leaves production
       * sending enquiries to a team nobody is watching — the failure is
       * silent, and it is discovered by a customer who was never called.
       * Automatically deleting or retargeting the rules would make a routing
       * decision on an administrator's behalf, which is precisely the thing
       * this whole phase exists to keep explicit.
       *
       * So the refusal names the rules, and the administrator pauses,
       * archives or retargets them first.
       *
       * This read is the FRIENDLY check, not the authority. It turns the
       * ordinary case — rules that were already there — into a message naming
       * them, without writing anything. The authority is the row lock taken by
       * `archiveIfUnused` below, because between this read and that write
       * another administrator may be creating a rule that points here.
       */
      if (dto.status === 'ARCHIVED') {
        const routing = await this.repository.activeRulesTargeting(id, tx);

        if (routing.length > 0) throw stillRouting(routing);
      }

      changes.status = dto.status;
      statusChanged = dto.status === 'ARCHIVED' ? 'ARCHIVED' : 'REACTIVATED';
      auditBefore['status'] = team.status;
      auditAfter['status'] = dto.status;
    }

    if (Object.keys(changes).length > 0) {
      /*
       * Archiving goes through the path that writes the team row BEFORE
       * reading the rules that target it, so an archive and a concurrent rule
       * creation cannot both succeed. Every other change is an ordinary
       * update: none of them can leave routing pointing somewhere dead.
       */
      const result =
        statusChanged === 'ARCHIVED'
          ? await this.repository.archiveIfUnused(id, changes, tx)
          : await this.repository.update(id, changes, tx);

      // Reached when a rule was created or activated while this archive was in
      // flight. The archive has been rolled back; the message is the same one
      // the pre-check gives, because to an administrator it is the same fact.
      if (typeof result === 'object') throw stillRouting(result.blockedBy);

      if (result === 'NAME_TAKEN') {
        throw AppException.conflict(
          ERROR_CODES.CONFLICT,
          'A team with this name already exists. Use a different name.',
        );
      }

      await this.audit.record({
        action: statusChanged
          ? statusChanged === 'ARCHIVED'
            ? TEAM_AUDIT.ARCHIVED
            : TEAM_AUDIT.REACTIVATED
          : TEAM_AUDIT.UPDATED,
        entityType: 'Team',
        entityId: id,
        ...auditAttribution(actor),
        before: auditBefore,
        after: auditAfter,
        tx,
      });

      if (managerChanged) {
        await this.audit.record({
          action: TEAM_AUDIT.MANAGER_CHANGED,
          entityType: 'Team',
          entityId: id,
          ...auditAttribution(actor),
          // Membership ids, not names or addresses: an audit row answers "who
          // changed what" and does not need to carry a colleague's details.
          before: { managerMembershipId: team.managerMembershipId },
          after: { managerMembershipId: changes.managerMembershipId ?? null },
          tx,
        });
      }
    }

    return this.findOne(id, tx);
  }

  async addMember(
    teamId: string,
    dto: AddTeamMemberDto,
    actor: MutationActor,
    tx?: PrismaTransaction,
  ): Promise<TeamDetail> {
    const team = await this.requireTeam(teamId, tx);

    if (team.status !== 'ACTIVE') {
      // An archived team is history. Adding to it would create a membership
      // that no future assignment can ever use and that nobody is watching.
      throw AppException.validation('This team is archived.', {
        teamId: ['reactivate the team before adding members'],
      });
    }

    const membership = await this.requireActiveMembership(dto.userId, 'userId', tx);
    const added = await this.repository.addMember({ teamId, membershipId: membership.id }, tx);

    /*
     * Null means the unique index refused the row: they are already in this
     * team. Answered as success rather than as an error — the caller asked for
     * a state that already holds, and a 409 here would make a double-click
     * look like a failure.
     */
    if (added) {
      await this.audit.record({
        action: TEAM_AUDIT.MEMBER_ADDED,
        entityType: 'Team',
        entityId: teamId,
        ...auditAttribution(actor),
        after: { membershipId: membership.id, teamMemberId: added.id },
        tx,
      });
    }

    return this.findOne(teamId, tx);
  }

  async removeMember(
    teamId: string,
    teamMemberId: string,
    actor: MutationActor,
    tx?: PrismaTransaction,
  ): Promise<TeamDetail> {
    const team = await this.requireTeam(teamId, tx);
    const row = await this.repository.findMemberRow(teamId, teamMemberId, tx);

    // A row from another tenant, another team, or nothing at all: one answer.
    if (!row) throw this.memberNotFound();

    if (!row.removedAt) {
      const isManager = team.managerMembershipId === row.organizationMembershipId;

      /*
       * Removing the manager clears the manager reference IN THE SAME
       * TRANSACTION.
       *
       * The alternative — refusing until somebody names a replacement — is
       * defensible, but it leaves an administrator stuck when the manager has
       * already left, and the repository's transaction conventions make the
       * atomic version the simpler correct one.
       */
      const removed = isManager
        ? await this.repository.removeMemberAndClearManager(
            {
              teamId,
              teamMemberId,
              membershipId: row.organizationMembershipId,
            },
            tx,
          )
        : await this.repository.removeMember(teamId, teamMemberId, tx);

      if (removed > 0) {
        await this.audit.record({
          action: TEAM_AUDIT.MEMBER_REMOVED,
          entityType: 'Team',
          entityId: teamId,
          ...auditAttribution(actor),
          before: { membershipId: row.organizationMembershipId, wasManager: isManager },
          tx,
        });
      }
    }

    return this.findOne(teamId, tx);
  }

  async setMemberAssignment(
    teamId: string,
    teamMemberId: string,
    dto: UpdateTeamMemberDto,
    actor: MutationActor,
    tx?: PrismaTransaction,
  ): Promise<TeamDetail> {
    await this.requireTeam(teamId, tx);

    const updated = await this.repository.setAssignmentEnabled(
      teamId,
      teamMemberId,
      dto.assignmentEnabled,
      tx,
    );

    if (updated === 0) throw this.memberNotFound();

    await this.audit.record({
      action: TEAM_AUDIT.MEMBER_ASSIGNMENT_CHANGED,
      entityType: 'Team',
      entityId: teamId,
      ...auditAttribution(actor),
      after: { teamMemberId, assignmentEnabled: dto.assignmentEnabled },
      tx,
    });

    return this.findOne(teamId, tx);
  }

  /**
   * The organization's members, with the teams they are in.
   *
   * What a screen needs to manage a team, and what the assignment phase will
   * read: nothing here is a password hash, a session, a token or an
   * integration credential.
   */
  async agents(tx?: PrismaTransaction): Promise<TeamAgentCandidate[]> {
    const memberships = await this.repository.listMembershipsWithTeams(tx);

    return memberships.map((membership) => ({
      membershipId: membership.id,
      userId: membership.user.id,
      fullName: membership.user.fullName,
      email: membership.user.email,
      avatarUrl: membership.user.avatarUrl,
      role: membership.role.key as RoleKey,
      status: membership.status as UserStatus,
      assignableRole: isAssignableRole(membership.role.key as RoleKey),
      teams: membership.teamMembers
        .filter((row) => row.team.status === 'ACTIVE')
        .map((row) => ({
          teamId: row.team.id,
          teamName: row.team.name,
          assignmentEnabled: row.assignmentEnabled,
        })),
    }));
  }

  /**
   * The people in one team who may receive automatically assigned work RIGHT
   * NOW.
   *
   * The canonical answer, exported so nothing else has to reconstruct it.
   * Assignment rules decide WHICH team; they never decide who in it is
   * available, and a rule can no more make an ineligible person eligible than
   * a rota can make somebody unsuspend themselves.
   *
   * Returns an empty array for an archived team, a team that does not exist,
   * and a team in another organization alike — an empty pool is the honest
   * answer to all three, and distinguishing them here would leak whether a
   * team id exists somewhere else.
   */
  async eligibleAgents(teamId: string, tx?: PrismaTransaction): Promise<TeamMemberView[]> {
    const team = await this.repository.findById(teamId, tx);
    if (!team) return [];

    return team.members
      .map((member) => toMemberView(member, team.status))
      .filter((member) => member.eligibleForAssignment);
  }

  /**
   * The same answer, ordered for a rotation.
   *
   * Canonical order is `joinedAt` then `id`: both immutable once written, so
   * the sequence a team goes round in does not change when somebody is renamed
   * or their row is updated. Database natural order would be none of those
   * things — it changes as rows are updated and vacuumed, which would make the
   * rotation quietly non-deterministic.
   *
   * `id` breaks the tie because two people can be added in the same
   * millisecond, and uuidv7 is itself time-ordered, so the tie-break follows
   * insertion order rather than being arbitrary.
   */
  async eligibleAgentsInRotationOrder(
    teamId: string,
    tx?: PrismaTransaction,
  ): Promise<TeamMemberView[]> {
    const agents = await this.eligibleAgents(teamId, tx);

    return [...agents].sort((a, b) => {
      const byJoined = a.joinedAt.localeCompare(b.joinedAt);
      return byJoined !== 0 ? byJoined : a.id.localeCompare(b.id);
    });
  }

  /** A team in another organization is indistinguishable from one that is gone. */
  private async requireTeam(id: string, tx?: PrismaTransaction) {
    const team = await this.repository.findById(id, tx);
    if (!team) throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Team not found.');

    return team;
  }

  /**
   * The membership behind a user id, refusing anything that cannot manage.
   *
   * Cross-tenant safety is structural rather than checked here — the query is
   * tenant-scoped, so another organization's user simply is not found — but
   * the status check is a real rule: naming somebody suspended or removed as
   * manager would create a team nobody is responsible for.
   */
  private async requireManager(userId: string, tx?: PrismaTransaction) {
    return this.requireActiveMembership(userId, 'managerUserId', tx);
  }

  private async requireActiveMembership(
    userId: string,
    field = 'userId',
    tx?: PrismaTransaction,
  ) {
    const membership = await this.repository.findMembership(userId, tx);

    if (!membership || membership.status === 'REMOVED') {
      // 400, not 404: the caller supplied a value that is not usable. It says
      // nothing about whether that id exists in some other organization.
      throw AppException.validation('That person is not a member of this organization.', {
        [field]: ['must be an active member of your organization'],
      });
    }

    if (membership.status !== 'ACTIVE') {
      throw AppException.validation('That membership is not active.', {
        [field]: ['must be an active member of your organization'],
      });
    }

    return membership;
  }

  private memberNotFound(): AppException {
    return AppException.notFound(ERROR_CODES.NOT_FOUND, 'Team member not found.');
  }
}

type TeamRow = Awaited<ReturnType<TeamsRepository['findById']>>;
type LoadedTeam = NonNullable<TeamRow>;

function toListItem(team: LoadedTeam): TeamListItem {
  return {
    id: team.id,
    name: team.name,
    description: team.description,
    status: team.status,
    manager: team.manager
      ? {
          membershipId: team.manager.id,
          userId: team.manager.user.id,
          fullName: team.manager.user.fullName,
          role: team.manager.role.key as RoleKey,
        }
      : null,
    // Counted from LIVE organization status: somebody suspended still has
    // history in the team and is not part of its working strength.
    activeMemberCount: team.members.filter((member) => member.membership.status === 'ACTIVE')
      .length,
    createdAt: team.createdAt.toISOString(),
    updatedAt: team.updatedAt.toISOString(),
  };
}

/**
 * One refusal, stated once.
 *
 * Reached from two places — the read before the write, and the row lock that
 * decides the race — and they must say the same thing. An administrator who
 * saw a different message depending on whether their colleague's rule landed a
 * millisecond earlier would reasonably conclude the two were different
 * problems.
 */
function stillRouting(rules: { name: string }[]): AppException {
  return AppException.validation('Assignment rules still send work to this team.', {
    status: [
      `pause, archive or retarget these rules first: ${rules.map((rule) => rule.name).join(', ')}`,
    ],
  });
}

function toMemberView(member: LoadedTeam['members'][number], teamStatus: string): TeamMemberView {
  const role = member.membership.role.key as RoleKey;

  return {
    id: member.id,
    membershipId: member.membership.id,
    userId: member.membership.user.id,
    fullName: member.membership.user.fullName,
    email: member.membership.user.email,
    avatarUrl: member.membership.user.avatarUrl,
    role,
    status: member.membership.status as UserStatus,
    assignmentEnabled: member.assignmentEnabled,
    joinedAt: member.joinedAt.toISOString(),
    eligibleForAssignment: isEligibleForAssignment({
      membershipStatus: member.membership.status,
      role,
      assignmentEnabled: member.assignmentEnabled,
      teamStatus: teamStatus === 'ACTIVE' ? 'ACTIVE' : 'ARCHIVED',
    }),
  };
}
