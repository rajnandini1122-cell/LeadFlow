import { Injectable, Logger } from '@nestjs/common';
import {
  ERROR_CODES,
  type AssignmentPreviewResult,
  type AssignmentRuleStatus,
  type AssignmentRuleView,
  type TerritoryStatus,
} from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import { AuditRepository } from '../../common/audit/audit.repository';
import type { PrismaTransaction } from '../../common/prisma/transaction';
import { auditAttribution, type MutationActor } from '../../common/audit/mutation-actor';
import { TeamsService } from '../teams/teams.service';
import { TerritoriesService } from '../territories/territories.service';
import { AssignmentRulesRepository, type RuleConflict } from './assignment-rules.repository';
import {
  criteriaKey,
  criteriaMatch,
  hasNoCriteria,
  normalizeSourceKey,
  type AssignmentContext,
} from './rule-criteria';
import type {
  CreateAssignmentRuleDto,
  PreviewAssignmentDto,
  UpdateAssignmentRuleDto,
} from './dto/assignment-rules.dto';

export const RULE_AUDIT = {
  CREATED: 'assignment_rule.created',
  UPDATED: 'assignment_rule.updated',
  PAUSED: 'assignment_rule.paused',
  ACTIVATED: 'assignment_rule.activated',
  ARCHIVED: 'assignment_rule.archived',
  TARGET_CHANGED: 'assignment_rule.target_changed',
} as const;

/**
 * Which TEAM handles which work.
 *
 * The routing table, and only the table. This phase does not create a lead
 * from an intake, does not assign or reassign anything, does not advance a
 * round-robin cursor and does not choose a person. It answers one question —
 * "which team, and who there could take it right now" — and stops, because
 * territories may still narrow that pool and the final choice has to happen in
 * the same transaction as the write that records it.
 *
 * Evaluation is deterministic, and documented where it happens: active
 * specific rules in precedence order, first match wins, then the single active
 * fallback, then nothing. No result depends on row order, creation time, or
 * which replica asked.
 */
@Injectable()
export class AssignmentRulesService {
  private readonly logger = new Logger(AssignmentRulesService.name);

  constructor(
    private readonly repository: AssignmentRulesRepository,
    private readonly teams: TeamsService,
    private readonly territories: TerritoriesService,
    private readonly audit: AuditRepository,
  ) {}

  async list(tx?: PrismaTransaction): Promise<AssignmentRuleView[]> {
    const rules = await this.repository.list(undefined, tx);
    return rules.map(toView);
  }

  async findOne(id: string, tx?: PrismaTransaction): Promise<AssignmentRuleView> {
    return toView(await this.requireRule(id, tx));
  }

  async create(
    dto: CreateAssignmentRuleDto,
    actor: MutationActor,
    tx?: PrismaTransaction,
  ): Promise<AssignmentRuleView> {
    const isFallback = dto.isFallback === true;
    const sourceKey = normalizeSourceKey(dto.source);

    /*
     * A fallback carries no criteria.
     *
     * "Everything from the website, as a last resort" is two different rules
     * pretending to be one: if it is specific it belongs in precedence order
     * where an administrator can see it, and if it is the catch-all it must
     * not quietly decline to catch things.
     */
    const criteria = { sourceKey, productId: dto.productId, territoryId: dto.territoryId };

    if (isFallback && !hasNoCriteria(criteria)) {
      throw AppException.validation('A fallback rule cannot have criteria.', {
        isFallback: ['remove the source, product and territory, or make this a specific rule'],
      });
    }

    if (!isFallback && hasNoCriteria(criteria)) {
      // Otherwise it silently becomes a second catch-all that outranks the
      // real one, which is how a routing table starts sending everything to
      // one team for reasons nobody can find.
      throw AppException.validation('A rule needs at least one criterion.', {
        source: ['set a source, a product or a territory, or mark this rule as the fallback'],
      });
    }

    const team = await this.requireActiveTeam(dto.targetTeamId, tx);
    if (dto.productId) await this.requireProduct(dto.productId, tx);
    if (dto.territoryId) await this.requireActiveTerritory(dto.territoryId, tx);

    const priority = dto.priority ?? (await this.repository.nextPriority(tx));

    const created = await this.repository.create({
      name: dto.name,
      nameKey: nameKeyOf(dto.name),
      description: dto.description,
      priority,
      source: dto.source,
      sourceKey,
      productId: dto.productId,
      territoryId: dto.territoryId,
      isFallback,
      criteriaKey: criteriaKey(criteria),
      targetTeamId: team.id,
    }, tx);

    if ('conflict' in created) throw conflictError(created);

    await this.audit.record({
      action: RULE_AUDIT.CREATED,
      entityType: 'AssignmentRule',
      entityId: created.id,
      ...auditAttribution(actor),
      after: {
        name: dto.name,
        priority,
        isFallback,
        source: sourceKey ?? null,
        productId: dto.productId ?? null,
        territoryId: dto.territoryId ?? null,
        targetTeamId: team.id,
      },
      tx,
    });

    return this.findOne(created.id, tx);
  }

  async update(
    id: string,
    dto: UpdateAssignmentRuleDto,
    actor: MutationActor,
    tx?: PrismaTransaction,
  ): Promise<AssignmentRuleView> {
    const rule = await this.requireRule(id, tx);

    if (rule.status === 'ARCHIVED' && dto.status !== undefined) {
      /*
       * Archive is terminal here, unlike a team.
       *
       * A team is a group of people who may legitimately come back; a rule is
       * a decision about where work went. Reviving one silently changes the
       * routing table to something an administrator retired, and the audit
       * trail would show a rule that was archived still answering. Creating a
       * fresh rule is the honest way back.
       */
      throw AppException.validation('An archived rule cannot be reactivated.', {
        status: ['create a new rule instead — archived rules are historical'],
      });
    }

    const changes: Parameters<AssignmentRulesRepository['update']>[1] = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    if (dto.name !== undefined && dto.name !== rule.name) {
      changes.name = dto.name;
      changes.nameKey = nameKeyOf(dto.name);
      before['name'] = rule.name;
      after['name'] = dto.name;
    }

    if (dto.description !== undefined) changes.description = dto.description ?? null;

    if (dto.priority !== undefined && dto.priority !== rule.priority) {
      changes.priority = dto.priority;
      before['priority'] = rule.priority;
      after['priority'] = dto.priority;
    }

    // Criteria move together: either is enough to change what the rule
    // matches, so the key is recomputed from both whenever one is touched.
    const criteriaTouched =
      dto.source !== undefined || dto.productId !== undefined || dto.territoryId !== undefined;

    /*
     * Whichever territory this rule will route to once the change lands.
     *
     * Read outside the criteria block as well, because ACTIVATING a rule
     * nobody edited still needs its territory to be usable — the rule has
     * not changed, but the world may have.
     */
    const nextTerritoryId =
      dto.territoryId === undefined ? rule.territoryId : dto.territoryId ?? null;

    if (criteriaTouched) {
      const sourceKey =
        dto.source === undefined ? rule.sourceKey : normalizeSourceKey(dto.source) ?? null;
      const productId = dto.productId === undefined ? rule.productId : dto.productId;
      const criteria = { sourceKey, productId, territoryId: nextTerritoryId };

      if (rule.isFallback && !hasNoCriteria(criteria)) {
        throw AppException.validation('A fallback rule cannot have criteria.', {
          isFallback: ['remove the source, product and territory, or create a specific rule'],
        });
      }
      if (!rule.isFallback && hasNoCriteria(criteria)) {
        throw AppException.validation('A rule needs at least one criterion.', {
          source: ['set a source, a product or a territory'],
        });
      }

      if (productId && productId !== rule.productId) await this.requireProduct(productId, tx);
      if (nextTerritoryId && nextTerritoryId !== rule.territoryId) {
        await this.requireActiveTerritory(nextTerritoryId, tx);
      }

      if (dto.source !== undefined) {
        changes.source = dto.source ?? null;
        changes.sourceKey = sourceKey;
        before['source'] = rule.sourceKey;
        after['source'] = sourceKey;
      }
      if (dto.productId !== undefined) {
        changes.productId = productId;
        before['productId'] = rule.productId;
        after['productId'] = productId;
      }
      if (dto.territoryId !== undefined) {
        changes.territoryId = nextTerritoryId;
        before['territoryId'] = rule.territoryId;
        after['territoryId'] = nextTerritoryId;
      }

      changes.criteriaKey = criteriaKey(criteria);
    }

    let targetChanged = false;
    if (dto.targetTeamId !== undefined && dto.targetTeamId !== rule.targetTeamId) {
      const team = await this.requireActiveTeam(dto.targetTeamId, tx);
      changes.targetTeamId = team.id;
      targetChanged = true;
      before['targetTeamId'] = rule.targetTeamId;
      after['targetTeamId'] = team.id;
    }

    let statusAction: keyof typeof RULE_AUDIT | undefined;
    if (dto.status !== undefined && dto.status !== rule.status) {
      // Activating points live routing at this team, so the team must be able
      // to receive work now — not merely when the rule was written.
      if (dto.status === 'ACTIVE') {
        await this.requireActiveTeam(changes.targetTeamId ?? rule.targetTeamId, tx);
        // And the territory, for the same reason: a rule brought back to
        // life pointing at a retired scope would match nothing and read as
        // broken rather than as retired.
        if (nextTerritoryId) await this.requireActiveTerritory(nextTerritoryId, tx);
      }

      changes.status = dto.status;
      statusAction =
        dto.status === 'ACTIVE' ? 'ACTIVATED' : dto.status === 'PAUSED' ? 'PAUSED' : 'ARCHIVED';
      before['status'] = rule.status;
      after['status'] = dto.status;
    }

    if (Object.keys(changes).length > 0) {
      /*
       * Asked before writing, so the ordinary collision is a message rather
       * than a raised constraint — an update cannot use ON CONFLICT the way
       * an insert can. The indexes still decide under concurrency; this only
       * decides what an administrator is told.
       *
       * Only when the rule will be ACTIVE afterwards: the three invariants
       * cover active rules, so a paused rule may hold any priority it likes.
       */
      const willBeActive = (changes.status ?? rule.status) === 'ACTIVE';

      if (willBeActive) {
        const clash = await this.repository.conflictingRule(
          {
            excludeId: id,
            criteriaKey: changes.criteriaKey ?? (changes.status ? rule.criteriaKey : undefined),
            priority: changes.priority ?? (changes.status ? rule.priority : undefined),
            isFallback: rule.isFallback,
          },
          tx,
        );

        if (clash) throw conflictError(clash);
      }

      const result = await this.repository.update(
        id,
        changes,
        rule.isFallback,
        // Locked only when the rule will actually be routing afterwards. A
        // paused rule may keep pointing at an archived territory: that is a
        // record of where work used to go, not a live decision.
        willBeActive && nextTerritoryId ? nextTerritoryId : undefined,
        tx,
      );
      if (result !== 'UPDATED') throw conflictError(result);

      await this.audit.record({
        action: statusAction ? RULE_AUDIT[statusAction] : RULE_AUDIT.UPDATED,
        entityType: 'AssignmentRule',
        entityId: id,
        ...auditAttribution(actor),
        before,
        after,
        tx,
      });

      if (targetChanged) {
        await this.audit.record({
          action: RULE_AUDIT.TARGET_CHANGED,
          entityType: 'AssignmentRule',
          entityId: id,
          ...auditAttribution(actor),
          before: { targetTeamId: rule.targetTeamId },
          after: { targetTeamId: changes.targetTeamId },
          tx,
        });
      }
    }

    return this.findOne(id, tx);
  }

  /**
   * Which team would take this, and who there could pick it up.
   *
   * READ-ONLY. It creates no lead, touches no intake, moves no follow-up and
   * advances no cursor — an administrator must be able to ask "where would
   * this go" without the asking changing the answer.
   *
   * The order:
   *   1. active specific rules, lowest priority number first;
   *   2. the first whose every stated criterion matches wins;
   *   3. otherwise the single active fallback, if there is one;
   *   4. otherwise NO_MATCH — never an arbitrary team.
   */
  async evaluate(
    context: AssignmentContext,
    /** What the geography resolved to, for the answer. Never re-derived here. */
    territory?: { id: string; name: string } | null,
    /**
     * Supplied when the caller will ACT on the answer in the same transaction.
     *
     * The preview leaves this undefined — it only reports. The automated
     * pipeline passes its transaction, so the rules it reads and the team it
     * assigns from cannot change between the decision and the write.
     */
    tx?: PrismaTransaction,
  ): Promise<AssignmentPreviewResult> {
    const rules = await this.repository.activeRules(tx);
    const matched = rules.find((rule) =>
      criteriaMatch(
        { sourceKey: rule.sourceKey, productId: rule.productId, territoryId: rule.territoryId },
        context,
      ),
    );

    const fallback = matched ? undefined : await this.repository.activeFallback(tx);
    const chosen = matched ?? fallback;

    if (!chosen) {
      // Deliberately not "pick a team". A routing table with no answer is a
      // configuration an administrator should see, not one the software
      // papers over by choosing somebody.
      return { ...empty('NO_MATCH'), territory: territory ?? null };
    }

    const agents = await this.teams.eligibleAgents(chosen.targetTeamId, tx);

    const result: AssignmentPreviewResult = {
      decision: agents.length === 0 ? 'NO_ELIGIBLE_AGENTS' : matched ? 'MATCHED' : 'FALLBACK_MATCHED',
      rule: {
        id: chosen.id,
        name: chosen.name,
        priority: chosen.priority,
        isFallback: chosen.isFallback,
      },
      team: { id: chosen.targetTeam.id, name: chosen.targetTeam.name },
      /*
       * A POOL, never a choice.
       *
       * Picking one is the job of the phase that writes the lead, so the
       * selection and the write happen together — and because territories may
       * still narrow this list first. Choosing here would also mean advancing
       * whatever state the choice depends on during a PREVIEW, which would
       * make asking a question change the answer to the next one.
       */
      eligibleAgents: agents.map((agent) => ({
        membershipId: agent.membershipId,
        userId: agent.userId,
        fullName: agent.fullName,
      })),
      eligibleAgentCount: agents.length,
      /*
       * Reported even when no rule mentioned a territory.
       *
       * "No rule matched" and "that pincode belongs to no territory" are
       * different problems — one is a missing rule, the other a gap in the map
       * — and an administrator who cannot tell them apart fixes the wrong one.
       */
      territory: territory ?? null,
    };

    if (agents.length === 0) {
      this.logger.debug(
        { ruleId: chosen.id, teamId: chosen.targetTeamId },
        'Assignment rule matched a team with no eligible agents',
      );
    }

    return result;
  }

  /**
   * The full path an enquiry takes, run forwards and changing nothing.
   *
   *   raw geography -> TerritoriesService -> territory id
   *                 -> the rules -> a team -> that team's available people
   *
   * Geography is resolved FIRST and separately, which is the whole shape of
   * this phase: rules match a territory id, never a city or a pincode, so the
   * coverage table stays the single description of where a place is and a rule
   * cannot become a private geography database of its own.
   *
   * Still read-only end to end. Resolving a location writes nothing, and
   * neither does evaluating the rules.
   */
  async preview(dto: PreviewAssignmentDto): Promise<AssignmentPreviewResult> {
    const resolution = await this.territories.resolve({
      country: dto.country,
      state: dto.state,
      city: dto.city,
      postalCode: dto.postalCode,
    });

    return this.evaluate(
      {
        source: dto.source,
        productId: dto.productId,
        // Null when the location matched nothing, which is a fact rather than
        // a wildcard: a rule that states a territory does not match work whose
        // territory is unknown.
        territoryId: resolution.territory?.id ?? null,
      },
      resolution.territory,
    );
  }

  /** A rule in another organization is indistinguishable from one that is gone. */
  private async requireRule(id: string, tx?: PrismaTransaction) {
    const rule = await this.repository.findById(id, tx);
    if (!rule) throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Assignment rule not found.');

    return rule;
  }

  /**
   * The target team, which must be this tenant's and able to receive work.
   *
   * Cross-tenant safety is structural — the query is scoped, so another
   * organization's team is simply not found, and the composite foreign key
   * would refuse the row even if it were. The message says the id is not
   * usable and never that it belongs to somebody else.
   */
  private async requireActiveTeam(teamId: string, tx?: PrismaTransaction) {
    const team = await this.repository.findTeam(teamId, tx);

    if (!team) {
      throw AppException.validation('That team could not be found.', {
        targetTeamId: ['must be a team in your organization'],
      });
    }

    if (team.status !== 'ACTIVE') {
      throw AppException.validation('That team is archived.', {
        targetTeamId: ['route work to an active team'],
      });
    }

    return team;
  }

  private async requireProduct(productId: string, tx?: PrismaTransaction) {
    const product = await this.repository.findProduct(productId, tx);

    if (!product) {
      throw AppException.validation('That product could not be found.', {
        productId: ['must be a product in your catalogue'],
      });
    }

    return product;
  }

  /**
   * The territory a rule may route to: this tenant's, and still in use.
   *
   * Another organization's territory is simply not found by the scoped query,
   * and the composite foreign key would refuse the row even if the check were
   * missed. The message says the id is not usable and never that it belongs to
   * somebody else — a different message for a foreign id would confirm it
   * exists.
   *
   * This is the friendly check, not the authority. The authority is the row
   * lock the write takes inside its transaction, because between this read and
   * that write another administrator may archive the territory.
   */
  private async requireActiveTerritory(territoryId: string, tx?: PrismaTransaction) {
    const territory = await this.repository.findTerritory(territoryId, tx);

    if (!territory) {
      throw AppException.validation('That territory could not be found.', {
        territoryId: ['must be a territory in your organization'],
      });
    }

    if (territory.status !== 'ACTIVE') {
      throw AppException.validation('That territory is archived.', {
        territoryId: ['route work to an active territory'],
      });
    }

    return territory;
  }
}

/** Empty result for the decisions that name no rule and no team. */
function empty(decision: AssignmentPreviewResult['decision']): AssignmentPreviewResult {
  return {
    decision,
    rule: null,
    team: null,
    eligibleAgents: [],
    eligibleAgentCount: 0,
    territory: null,
  };
}

/** The refusals the database issues, in words an administrator can act on. */
function conflictError(conflict: RuleConflict): AppException {
  const message =
    conflict.conflict === 'FALLBACK_EXISTS'
      ? 'This organization already has an active fallback rule. Pause or archive it first.'
      : conflict.conflict === 'CRITERIA_TAKEN'
        ? 'Another active rule already matches exactly these criteria. Edit that rule instead.'
        : conflict.conflict === 'TERRITORY_UNAVAILABLE'
          ? // Reached only when somebody archived the territory between this
            // request's check and its write. Rare, and worth its own message:
            // "priority taken" would send an administrator looking in
            // completely the wrong place.
            'That territory was archived while this was being saved. Reload and choose another.'
          : 'Another active rule already uses this priority. Choose a different one.';

  return AppException.conflict(ERROR_CODES.CONFLICT, message);
}

function nameKeyOf(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

type RuleRow = NonNullable<Awaited<ReturnType<AssignmentRulesRepository['findById']>>>;

function toView(rule: RuleRow): AssignmentRuleView {
  return {
    id: rule.id,
    name: rule.name,
    description: rule.description,
    status: rule.status as AssignmentRuleStatus,
    priority: rule.priority,
    source: rule.source,
    product: rule.product ? { id: rule.product.id, name: rule.product.name, sku: rule.product.sku } : null,
    territory: rule.territory
      ? {
          id: rule.territory.id,
          name: rule.territory.name,
          status: rule.territory.status as TerritoryStatus,
        }
      : null,
    isFallback: rule.isFallback,
    targetTeam: {
      id: rule.targetTeam.id,
      name: rule.targetTeam.name,
      status: rule.targetTeam.status,
    },
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
}
