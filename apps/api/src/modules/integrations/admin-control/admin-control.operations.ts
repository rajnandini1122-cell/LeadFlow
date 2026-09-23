import { Injectable } from '@nestjs/common';
import type {
  AssignmentPreviewResult,
  AssignmentRuleView,
  IntakeRetryResponse,
  IntakeRetryResult,
  IntakeStatus,
  IntegrationIntakeDetail,
  IntegrationIntakePage,
  TeamAgentCandidate,
  TeamDetail,
  TeamListItem,
  TerritoryDetail,
  TerritoryListItem,
  TerritoryResolution,
} from '@leadflow/api-types';
import { AppConfig } from '../../../common/config/config.module';
import type { MutationActor } from '../../../common/audit/mutation-actor';
import type { PrismaTransaction } from '../../../common/prisma/transaction';
import { TeamsService } from '../../teams/teams.service';
import { AssignmentRulesService } from '../../assignment-rules/assignment-rules.service';
import { TerritoriesService } from '../../territories/territories.service';
import { IntakeOperationsService } from '../intake-processing/intake-operations.service';
import { AdminControlRepository } from './admin-control.repository';
import type {
  AddTeamMemberDto,
  CreateTeamDto,
  UpdateTeamDto,
  UpdateTeamMemberDto,
} from '../../teams/dto/teams.dto';
import type {
  CreateAssignmentRuleDto,
  PreviewAssignmentDto,
  UpdateAssignmentRuleDto,
} from '../../assignment-rules/dto/assignment-rules.dto';
import type {
  AddTerritoryCoverageDto,
  CreateTerritoryDto,
  ResolveTerritoryDto,
  UpdateTerritoryDto,
} from '../../territories/dto/territories.dto';
import type { IntakeQueryDto } from '../intake-processing/dto/intake-operations.dto';

/** The operational picture, in counts. */
export interface AdminControlSummary {
  activeTeams: number;
  eligibleAgents: number;
  activeAssignmentRules: number;
  activeTerritories: number;
  intakes: {
    received: number;
    blocked: number;
    duplicate: number;
    failed: number;
    processed: number;
  };
  /** When conversion last ran, if it ever has. */
  lastIntakeProcessingAt: string | null;
  /**
   * Whether the worker converts enquiries automatically.
   *
   * READ-ONLY, and it stays that way. It is a deployment safety flag rather
   * than a tenant setting, and turning production automation on from an
   * ordinary admin screen is precisely the thing controlled activation exists
   * to prevent. No endpoint here writes it.
   */
  intakeAutoProcessingEnabled: boolean;
}

/**
 * The adapter, and only an adapter.
 *
 * Every method here forwards to the service the human-facing controller calls.
 * That is the whole design: there is no AdminTeamsService, no parallel rule
 * evaluator, no second territory resolver and no admin intake processor —
 * because a second implementation of a business rule is a second answer waiting
 * to disagree with the first, and the one an administrator got would be the one
 * nobody tested against production behaviour.
 *
 * So a team archived while active rules point at it is refused here exactly as
 * it is refused on the web: same method, same invariant, same message. "Admin"
 * is not a reason to bypass a business rule — if anything it is a reason not to,
 * since nobody is watching the screen.
 *
 * What this class DOES add is the two things an adapter legitimately owns: a
 * summary shaped for an operations dial, and threading the caller's transaction
 * and actor through to the domain.
 */
@Injectable()
export class AdminControlOperations {
  constructor(
    private readonly config: AppConfig,
    private readonly repository: AdminControlRepository,
    private readonly teamsService: TeamsService,
    private readonly rulesService: AssignmentRulesService,
    private readonly territoriesService: TerritoriesService,
    private readonly intakesService: IntakeOperationsService,
  ) {}

  // --- summary ---------------------------------------------------------------

  async summary(): Promise<AdminControlSummary> {
    const counts = await this.repository.summaryCounts();

    /*
     * Eligible agents are counted by asking J3, team by team, rather than with
     * a clever query. Eligibility is a rule — active membership, assignable
     * role, active team, assignment enabled — and a SQL expression here would
     * be a second copy of it, drifting the first time the rule changed.
     *
     * A person may be eligible in two teams and is counted once: the number an
     * operator wants is "how many people can receive work", not "how many
     * slots exist".
     */
    const teams = await this.teamsService.list(false);
    const eligible = new Set<string>();

    for (const team of teams) {
      for (const agent of await this.teamsService.eligibleAgents(team.id)) {
        eligible.add(agent.userId);
      }
    }

    return {
      activeTeams: counts.activeTeams,
      eligibleAgents: eligible.size,
      activeAssignmentRules: counts.activeRules,
      activeTerritories: counts.activeTerritories,
      intakes: {
        received: counts.intakes['RECEIVED'] ?? 0,
        blocked: counts.intakes['BLOCKED'] ?? 0,
        duplicate: counts.intakes['DUPLICATE'] ?? 0,
        failed: counts.intakes['FAILED'] ?? 0,
        processed: counts.intakes['PROCESSED'] ?? 0,
      },
      lastIntakeProcessingAt: counts.lastProcessingAt?.toISOString() ?? null,
      // A boolean, never a credential. See the field's own comment.
      intakeAutoProcessingEnabled: this.config.get('INTAKE_AUTO_PROCESSING_ENABLED'),
    };
  }

  // --- teams -----------------------------------------------------------------

  async teams(): Promise<TeamListItem[]> {
    return this.teamsService.list(false);
  }

  async team(id: string, tx?: PrismaTransaction): Promise<TeamDetail> {
    return this.teamsService.findOne(id, tx);
  }

  async agents(): Promise<TeamAgentCandidate[]> {
    return this.teamsService.agents();
  }

  async createTeam(dto: CreateTeamDto, actor: MutationActor, tx: PrismaTransaction) {
    return this.teamsService.create(dto, actor, tx);
  }

  async updateTeam(id: string, dto: UpdateTeamDto, actor: MutationActor, tx: PrismaTransaction) {
    return this.teamsService.update(id, dto, actor, tx);
  }

  /**
   * Adds somebody who is ALREADY a member of the organization.
   *
   * J3's own rule, unchanged: the DTO takes a user id and the service refuses
   * anybody who is not an active member. The control plane cannot manufacture
   * an identity — no invitation, no password, no role change — because that is
   * a different domain with a different approval, and a boundary that could
   * create users is a boundary worth attacking.
   */
  async addTeamMember(
    id: string,
    dto: AddTeamMemberDto,
    actor: MutationActor,
    tx: PrismaTransaction,
  ) {
    return this.teamsService.addMember(id, dto, actor, tx);
  }

  async removeTeamMember(
    id: string,
    memberId: string,
    actor: MutationActor,
    tx: PrismaTransaction,
  ) {
    return this.teamsService.removeMember(id, memberId, actor, tx);
  }

  async setTeamMemberAssignment(
    id: string,
    memberId: string,
    dto: UpdateTeamMemberDto,
    actor: MutationActor,
    tx: PrismaTransaction,
  ) {
    return this.teamsService.setMemberAssignment(id, memberId, dto, actor, tx);
  }

  // --- assignment rules ------------------------------------------------------

  async rules(): Promise<AssignmentRuleView[]> {
    return this.rulesService.list();
  }

  async rule(id: string, tx?: PrismaTransaction): Promise<AssignmentRuleView> {
    return this.rulesService.findOne(id, tx);
  }

  async createRule(dto: CreateAssignmentRuleDto, actor: MutationActor, tx: PrismaTransaction) {
    return this.rulesService.create(dto, actor, tx);
  }

  async updateRule(
    id: string,
    dto: UpdateAssignmentRuleDto,
    actor: MutationActor,
    tx: PrismaTransaction,
  ) {
    return this.rulesService.update(id, dto, actor, tx);
  }

  /** Read-only. Creates nothing, assigns nobody, advances no rotation. */
  async previewAssignment(dto: PreviewAssignmentDto): Promise<AssignmentPreviewResult> {
    return this.rulesService.preview(dto);
  }

  // --- territories -----------------------------------------------------------

  async territories(): Promise<TerritoryListItem[]> {
    return this.territoriesService.list(false);
  }

  async territory(id: string, tx?: PrismaTransaction): Promise<TerritoryDetail> {
    return this.territoriesService.findOne(id, tx);
  }

  async createTerritory(dto: CreateTerritoryDto, actor: MutationActor, tx: PrismaTransaction) {
    return this.territoriesService.create(dto, actor, tx);
  }

  async updateTerritory(
    id: string,
    dto: UpdateTerritoryDto,
    actor: MutationActor,
    tx: PrismaTransaction,
  ) {
    return this.territoriesService.update(id, dto, actor, tx);
  }

  async addCoverage(
    id: string,
    dto: AddTerritoryCoverageDto,
    actor: MutationActor,
    tx: PrismaTransaction,
  ) {
    return this.territoriesService.addCoverage(id, dto, actor, tx);
  }

  async removeCoverage(
    id: string,
    coverageId: string,
    actor: MutationActor,
    tx: PrismaTransaction,
  ) {
    return this.territoriesService.removeCoverage(id, coverageId, actor, tx);
  }

  /** Read-only. Asking where an address belongs changes nothing. */
  async resolveTerritory(dto: ResolveTerritoryDto): Promise<TerritoryResolution> {
    return this.territoriesService.preview(dto);
  }

  // --- website intakes -------------------------------------------------------

  async intakes(query: IntakeQueryDto): Promise<IntegrationIntakePage> {
    return this.intakesService.list(query);
  }

  async intake(id: string): Promise<IntegrationIntakeDetail> {
    return this.intakesService.findOne(id);
  }

  /**
   * Routes the same enquiry again.
   *
   * J6's own method, inside the control plane's transaction. A DUPLICATE is
   * refused there and is refused here — the machine does not overrule a review
   * because the caller is an administrator.
   */
  async retryIntake(id: string, tx: PrismaTransaction): Promise<IntakeRetryResponse> {
    return this.intakesService.retry(id, tx);
  }

  /**
   * What a retry that already ran produced, without running it again.
   *
   * Re-reads the enquiry and reports where it stands. Deliberately NOT a stored
   * copy of the first response: an enquiry blocked yesterday may have been
   * converted by a sweep since, and replaying a saved answer would tell an
   * administrator something that stopped being true.
   *
   * Nor does it re-run the retry, which is a mutation — the whole point of the
   * ledger is that the second call changes nothing.
   */
  async intakeCommandResult(id: string, tx?: PrismaTransaction): Promise<IntakeRetryResponse> {
    const intake = await this.intakesService.findOne(id, tx);

    return { result: retryResultFor(intake.status), intake };
  }
}

/**
 * The outcome a retry would report, read back from where the enquiry ended up.
 *
 * A status is the durable fact; the result string is how a caller reads it.
 * Deriving one from the other means a replayed command and a fresh one describe
 * the same row the same way.
 */
function retryResultFor(status: IntakeStatus): IntakeRetryResult {
  switch (status) {
    case 'PROCESSED':
      return 'ALREADY_PROCESSED';
    case 'BLOCKED':
      return 'BLOCKED';
    case 'DUPLICATE':
      return 'DUPLICATE';
    default:
      // RECEIVED or FAILED: it is back in the queue and nothing converted it.
      return 'SKIPPED';
  }
}
