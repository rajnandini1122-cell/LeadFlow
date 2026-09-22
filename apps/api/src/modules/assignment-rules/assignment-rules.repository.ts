import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
import type { AssignmentRuleStatus } from '../../generated/prisma/enums';

/**
 * Assignment rule data access.
 *
 * `AssignmentRule` is in TENANT_SCOPED_MODELS, so nothing here names
 * organizationId on a read. Three partial unique indexes decide the things
 * that must not be ambiguous — one active fallback, one rule per set of
 * criteria, one rule per precedence — and this file reports their refusals
 * rather than trying to predict them with a prior read, which under two
 * concurrent administrators predicts nothing.
 */
@Injectable()
export class AssignmentRulesRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async list(statuses?: AssignmentRuleStatus[]) {
    return this.prisma.client.assignmentRule.findMany({
      where: statuses ? { status: { in: statuses } } : {},
      include: RULE_INCLUDE,
      // The order an administrator reads the table in, and the order it runs:
      // active first, then by precedence, with the fallback last.
      orderBy: [{ status: 'asc' }, { isFallback: 'asc' }, { priority: 'asc' }],
    });
  }

  async findById(id: string) {
    return this.prisma.client.assignmentRule.findFirst({ where: { id }, include: RULE_INCLUDE });
  }

  /** Active rules in evaluation order. Fallback excluded — it is asked last. */
  async activeRules() {
    return this.prisma.client.assignmentRule.findMany({
      where: { status: 'ACTIVE', isFallback: false },
      select: EVALUATION_SELECT,
      // priority is unique among these, so the tie-breakers can never be
      // reached. They are here so that a future change loosening the index
      // cannot silently make the outcome depend on row order.
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  async activeFallback() {
    return this.prisma.client.assignmentRule.findFirst({
      where: { status: 'ACTIVE', isFallback: true },
      select: EVALUATION_SELECT,
    });
  }

  /** The next free precedence, so a caller need not pick one. */
  async nextPriority(): Promise<number> {
    const last = await this.prisma.client.assignmentRule.findFirst({
      where: { status: 'ACTIVE', isFallback: false },
      select: { priority: true },
      orderBy: { priority: 'desc' },
    });

    return (last?.priority ?? 0) + 10;
  }

  /**
   * Creates a rule, or names the invariant that refused it.
   *
   * `skipDuplicates` compiles to INSERT ... ON CONFLICT DO NOTHING, so a
   * collision with any of the three partial unique indexes returns no rows
   * instead of raising. That matters for two reasons: the indexes stay the
   * authority under concurrency, where a prior read decides nothing; and a
   * raised unique violation would abort the statement, which on the
   * in-process PGlite the development suite runs against takes the whole
   * connection down with it.
   *
   * ON CONFLICT cannot say WHICH index objected, so the reason is worked out
   * afterwards by asking — three cheap scoped reads, on a path that only runs
   * when something was already refused.
   */
  async create(input: {
    name: string;
    nameKey: string;
    description?: string | undefined;
    priority: number;
    source?: string | undefined;
    sourceKey?: string | undefined;
    productId?: string | undefined;
    isFallback: boolean;
    criteriaKey: string;
    targetTeamId: string;
  }): Promise<{ id: string } | RuleConflict> {
    const [created] = await this.prisma.client.assignmentRule.createManyAndReturn({
      skipDuplicates: true,
      data: [
        {
          organizationId: this.tenantContext.requireOrganizationId(),
          name: input.name,
          nameKey: input.nameKey,
          description: input.description ?? null,
          priority: input.priority,
          source: input.source ?? null,
          sourceKey: input.sourceKey ?? null,
          productId: input.productId ?? null,
          isFallback: input.isFallback,
          criteriaKey: input.criteriaKey,
          targetTeamId: input.targetTeamId,
        },
      ],
      select: { id: true },
    });

    return created ?? this.explainConflict(input);
  }

  /**
   * Which invariant already held, asked rather than guessed.
   *
   * Only reached when an insert was refused. Checked in the order an
   * administrator would want to hear about them: the fallback slot, then the
   * criteria, then the precedence.
   */
  private async explainConflict(input: {
    isFallback: boolean;
    criteriaKey: string;
    priority: number;
  }): Promise<RuleConflict> {
    if (input.isFallback) {
      const existing = await this.activeFallback();
      if (existing) return { conflict: 'FALLBACK_EXISTS' };
    }

    const sameCriteria = await this.prisma.client.assignmentRule.findFirst({
      where: { status: 'ACTIVE', isFallback: false, criteriaKey: input.criteriaKey },
      select: { id: true },
    });
    if (sameCriteria) return { conflict: 'CRITERIA_TAKEN' };

    return { conflict: 'PRIORITY_TAKEN' };
  }

  async update(
    id: string,
    changes: {
      name?: string;
      nameKey?: string;
      description?: string | null;
      priority?: number;
      source?: string | null;
      sourceKey?: string | null;
      productId?: string | null;
      criteriaKey?: string;
      targetTeamId?: string;
      status?: AssignmentRuleStatus;
    },
    /** Which fallback constraint a collision on (organization_id) would mean. */
    isFallback = false,
  ): Promise<'UPDATED' | RuleConflict> {
    try {
      // updateMany, so the tenant scope is part of the WHERE: another
      // organization's rule matches nothing rather than being checked for.
      await this.prisma.client.assignmentRule.updateMany({ where: { id }, data: changes });
      return 'UPDATED';
    } catch (error) {
      const conflict = conflictOf(error, isFallback);
      if (conflict) return conflict;
      throw error;
    }
  }

  /**
   * An ACTIVE rule that would collide with these changes, other than this one.
   *
   * Asked BEFORE an update, because an update cannot use ON CONFLICT DO
   * NOTHING the way an insert can: `updateMany` has no such clause, and a
   * raised unique violation drops the connection on the in-process PGlite the
   * development suite uses. The partial unique indexes remain the authority
   * under concurrency — this read is what turns the ordinary case into a
   * message an administrator can act on.
   */
  async conflictingRule(input: {
    excludeId: string;
    criteriaKey?: string | undefined;
    priority?: number | undefined;
    isFallback: boolean;
  }): Promise<RuleConflict | undefined> {
    if (input.isFallback) {
      const fallback = await this.prisma.client.assignmentRule.findFirst({
        where: { status: 'ACTIVE', isFallback: true, id: { not: input.excludeId } },
        select: { id: true },
      });
      if (fallback) return { conflict: 'FALLBACK_EXISTS' };
    }

    if (input.criteriaKey !== undefined) {
      const sameCriteria = await this.prisma.client.assignmentRule.findFirst({
        where: {
          status: 'ACTIVE',
          isFallback: false,
          criteriaKey: input.criteriaKey,
          id: { not: input.excludeId },
        },
        select: { id: true },
      });
      if (sameCriteria) return { conflict: 'CRITERIA_TAKEN' };
    }

    if (input.priority !== undefined && !input.isFallback) {
      const samePriority = await this.prisma.client.assignmentRule.findFirst({
        where: {
          status: 'ACTIVE',
          isFallback: false,
          priority: input.priority,
          id: { not: input.excludeId },
        },
        select: { id: true },
      });
      if (samePriority) return { conflict: 'PRIORITY_TAKEN' };
    }

    return undefined;
  }

  /** The team a rule may target: same tenant, and its current status. */
  async findTeam(teamId: string) {
    return this.prisma.client.team.findFirst({
      where: { id: teamId },
      select: { id: true, name: true, status: true },
    });
  }

  /** The product a rule may reference: same tenant, and whether it is offered. */
  async findProduct(productId: string) {
    return this.prisma.client.product.findFirst({
      where: { id: productId },
      select: { id: true, name: true, sku: true, active: true },
    });
  }
}

/** Which invariant refused a write. */
export type RuleConflict =
  | { conflict: 'FALLBACK_EXISTS' }
  | { conflict: 'CRITERIA_TAKEN' }
  | { conflict: 'PRIORITY_TAKEN' };

/**
 * Which invariant a unique violation hit.
 *
 * Prisma reports the FIELDS of the index rather than its name, so the three
 * are told apart by what they cover: criteria_key, priority, or
 * organization_id alone — which can only be the one-active-fallback index.
 * That last one is confirmed against the caller's intent rather than assumed,
 * because guessing wrong would report a misleading conflict.
 *
 * Anything unrecognised is NOT turned into a 409: an unexpected unique
 * violation is a bug, and dressing it as a conflict would hide it.
 */
function conflictOf(error: unknown, isFallback: boolean): RuleConflict | undefined {
  const failure = error as { code?: string; meta?: { target?: unknown } };
  if (failure.code !== 'P2002') return undefined;

  const target = Array.isArray(failure.meta?.target)
    ? failure.meta.target.join(',')
    : String(failure.meta?.target ?? '');

  if (target.includes('criteria')) return { conflict: 'CRITERIA_TAKEN' };
  if (target.includes('priority')) return { conflict: 'PRIORITY_TAKEN' };
  if (isFallback && target.includes('organization_id')) return { conflict: 'FALLBACK_EXISTS' };

  return undefined;
}

const RULE_INCLUDE = {
  targetTeam: { select: { id: true, name: true, status: true } },
  product: { select: { id: true, name: true, sku: true } },
} as const;

/** Only what the evaluator needs. No names, no descriptions, no PII. */
const EVALUATION_SELECT = {
  id: true,
  name: true,
  priority: true,
  isFallback: true,
  sourceKey: true,
  productId: true,
  targetTeamId: true,
  targetTeam: { select: { id: true, name: true, status: true } },
} as const;
