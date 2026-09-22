import { Injectable, Logger } from '@nestjs/common';
import {
  ERROR_CODES,
  type AssignmentPreviewResult,
  type AssignmentRuleStatus,
  type AssignmentRuleView,
} from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import { AuditRepository } from '../../common/audit/audit.repository';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { TeamsService } from '../teams/teams.service';
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
    private readonly audit: AuditRepository,
  ) {}

  async list(): Promise<AssignmentRuleView[]> {
    const rules = await this.repository.list();
    return rules.map(toView);
  }

  async findOne(id: string): Promise<AssignmentRuleView> {
    return toView(await this.requireRule(id));
  }

  async create(
    dto: CreateAssignmentRuleDto,
    principal: TenantPrincipal,
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
    if (isFallback && !hasNoCriteria({ sourceKey, productId: dto.productId })) {
      throw AppException.validation('A fallback rule cannot have criteria.', {
        isFallback: ['remove the source and product, or make this a specific rule'],
      });
    }

    if (!isFallback && hasNoCriteria({ sourceKey, productId: dto.productId })) {
      // Otherwise it silently becomes a second catch-all that outranks the
      // real one, which is how a routing table starts sending everything to
      // one team for reasons nobody can find.
      throw AppException.validation('A rule needs at least one criterion.', {
        source: ['set a source or a product, or mark this rule as the fallback'],
      });
    }

    const team = await this.requireActiveTeam(dto.targetTeamId);
    if (dto.productId) await this.requireProduct(dto.productId);

    const priority = dto.priority ?? (await this.repository.nextPriority());

    const created = await this.repository.create({
      name: dto.name,
      nameKey: nameKeyOf(dto.name),
      description: dto.description,
      priority,
      source: dto.source,
      sourceKey,
      productId: dto.productId,
      isFallback,
      criteriaKey: criteriaKey({ sourceKey, productId: dto.productId }),
      targetTeamId: team.id,
    });

    if ('conflict' in created) throw conflictError(created);

    await this.audit.record({
      action: RULE_AUDIT.CREATED,
      entityType: 'AssignmentRule',
      entityId: created.id,
      actorUserId: principal.userId,
      after: {
        name: dto.name,
        priority,
        isFallback,
        source: sourceKey ?? null,
        productId: dto.productId ?? null,
        targetTeamId: team.id,
      },
    });

    return this.findOne(created.id);
  }

  async update(
    id: string,
    dto: UpdateAssignmentRuleDto,
    principal: TenantPrincipal,
  ): Promise<AssignmentRuleView> {
    const rule = await this.requireRule(id);

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
    const criteriaTouched = dto.source !== undefined || dto.productId !== undefined;
    if (criteriaTouched) {
      const sourceKey =
        dto.source === undefined ? rule.sourceKey : normalizeSourceKey(dto.source) ?? null;
      const productId = dto.productId === undefined ? rule.productId : dto.productId;

      if (rule.isFallback && !hasNoCriteria({ sourceKey, productId })) {
        throw AppException.validation('A fallback rule cannot have criteria.', {
          isFallback: ['remove the source and product, or create a specific rule'],
        });
      }
      if (!rule.isFallback && hasNoCriteria({ sourceKey, productId })) {
        throw AppException.validation('A rule needs at least one criterion.', {
          source: ['set a source or a product'],
        });
      }

      if (productId && productId !== rule.productId) await this.requireProduct(productId);

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

      changes.criteriaKey = criteriaKey({ sourceKey, productId });
    }

    let targetChanged = false;
    if (dto.targetTeamId !== undefined && dto.targetTeamId !== rule.targetTeamId) {
      const team = await this.requireActiveTeam(dto.targetTeamId);
      changes.targetTeamId = team.id;
      targetChanged = true;
      before['targetTeamId'] = rule.targetTeamId;
      after['targetTeamId'] = team.id;
    }

    let statusAction: keyof typeof RULE_AUDIT | undefined;
    if (dto.status !== undefined && dto.status !== rule.status) {
      // Activating points live routing at this team, so the team must be able
      // to receive work now — not merely when the rule was written.
      if (dto.status === 'ACTIVE') await this.requireActiveTeam(changes.targetTeamId ?? rule.targetTeamId);

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
        const clash = await this.repository.conflictingRule({
          excludeId: id,
          criteriaKey: changes.criteriaKey ?? (changes.status ? rule.criteriaKey : undefined),
          priority: changes.priority ?? (changes.status ? rule.priority : undefined),
          isFallback: rule.isFallback,
        });

        if (clash) throw conflictError(clash);
      }

      const result = await this.repository.update(id, changes, rule.isFallback);
      if (result !== 'UPDATED') throw conflictError(result);

      await this.audit.record({
        action: statusAction ? RULE_AUDIT[statusAction] : RULE_AUDIT.UPDATED,
        entityType: 'AssignmentRule',
        entityId: id,
        actorUserId: principal.userId,
        before,
        after,
      });

      if (targetChanged) {
        await this.audit.record({
          action: RULE_AUDIT.TARGET_CHANGED,
          entityType: 'AssignmentRule',
          entityId: id,
          actorUserId: principal.userId,
          before: { targetTeamId: rule.targetTeamId },
          after: { targetTeamId: changes.targetTeamId },
        });
      }
    }

    return this.findOne(id);
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
  async evaluate(context: AssignmentContext): Promise<AssignmentPreviewResult> {
    const rules = await this.repository.activeRules();
    const matched = rules.find((rule) =>
      criteriaMatch({ sourceKey: rule.sourceKey, productId: rule.productId }, context),
    );

    const fallback = matched ? undefined : await this.repository.activeFallback();
    const chosen = matched ?? fallback;

    if (!chosen) {
      // Deliberately not "pick a team". A routing table with no answer is a
      // configuration an administrator should see, not one the software
      // papers over by choosing somebody.
      return empty('NO_MATCH');
    }

    const agents = await this.teams.eligibleAgents(chosen.targetTeamId);

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
    };

    if (agents.length === 0) {
      this.logger.debug(
        { ruleId: chosen.id, teamId: chosen.targetTeamId },
        'Assignment rule matched a team with no eligible agents',
      );
    }

    return result;
  }

  async preview(dto: PreviewAssignmentDto): Promise<AssignmentPreviewResult> {
    return this.evaluate({ source: dto.source, productId: dto.productId });
  }

  /** A rule in another organization is indistinguishable from one that is gone. */
  private async requireRule(id: string) {
    const rule = await this.repository.findById(id);
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
  private async requireActiveTeam(teamId: string) {
    const team = await this.repository.findTeam(teamId);

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

  private async requireProduct(productId: string) {
    const product = await this.repository.findProduct(productId);

    if (!product) {
      throw AppException.validation('That product could not be found.', {
        productId: ['must be a product in your catalogue'],
      });
    }

    return product;
  }
}

/** Empty result for the decisions that name no rule and no team. */
function empty(decision: AssignmentPreviewResult['decision']): AssignmentPreviewResult {
  return { decision, rule: null, team: null, eligibleAgents: [], eligibleAgentCount: 0 };
}

/** The refusals the database issues, in words an administrator can act on. */
function conflictError(conflict: RuleConflict): AppException {
  const message =
    conflict.conflict === 'FALLBACK_EXISTS'
      ? 'This organization already has an active fallback rule. Pause or archive it first.'
      : conflict.conflict === 'CRITERIA_TAKEN'
        ? 'Another active rule already matches exactly these criteria. Edit that rule instead.'
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
