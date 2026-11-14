import { Injectable, Logger } from '@nestjs/common';
import {
  ERROR_CODES,
  LEAD_BULK_LIMIT,
  type LeadBulkAction,
  type LeadBulkItemResult,
  type LeadBulkResult,
  type LeadStatus,
} from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import { AuditRepository } from '../../common/audit/audit.repository';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { LeadsRepository } from './leads.repository';
import { LeadsService } from './leads.service';
import { LeadMutationsService } from './lead-mutations.service';
import { visibilityFilter } from './lead-visibility';
import { canTransition, isTerminal } from './lead-status';
import { assertStatusAllowed } from './lead-qualification';
import type {
  BulkAssignLeadsDto,
  BulkUpdateLeadsDto,
  LeadSelectionDto,
} from './dto/bulk-leads.dto';

type Lead = NonNullable<Awaited<ReturnType<LeadsRepository['findById']>>>;
type Plan =
  | { outcome: 'WILL_CHANGE' }
  | { outcome: 'UNCHANGED' | 'REFUSED' | 'CONFLICT'; reason: string; code?: string };

/** Kept in step with LeadsRepository.findBulkResult. */
const BULK_AUDIT = 'lead.bulk.applied';
const REPLAY_WINDOW_MS = 24 * 3_600_000;

/**
 * Changes many leads in ONE server request — never a browser loop.
 *
 * Every lead goes through the same domain services a single edit uses
 * (LeadMutationsService.update / assign), so the pipeline rules, follow-up
 * queue, customer promotion, activities and per-lead audit are identical. On
 * top of that this adds what only a bulk change needs:
 *
 *   selection    explicit ids, or "all matching these filters", resolved here
 *                with the caller's own visibility; capped at LEAD_BULK_LIMIT
 *   dry run      a per-lead plan (will change / unchanged / refused + why)
 *                before anything is written
 *   concurrency  a lead changed after the person's snapshot is skipped as
 *                CONFLICT, never overwritten
 *   partial      each lead commits on its own; one refusal never undoes others
 *   idempotency  the same Idempotency-Key replays the stored result
 *   audit        one parent record with every lead's outcome
 *
 * WON is not available in bulk: a win needs a customer and a value per deal.
 */
@Injectable()
export class LeadBulkService {
  private readonly logger = new Logger(LeadBulkService.name);

  constructor(
    private readonly repository: LeadsRepository,
    private readonly leads: LeadsService,
    private readonly mutations: LeadMutationsService,
    private readonly audit: AuditRepository,
  ) {}

  async update(
    dto: BulkUpdateLeadsDto,
    principal: TenantPrincipal,
    idempotencyKey: string | undefined,
  ): Promise<LeadBulkResult> {
    this.requireParams(dto);
    return this.run(dto.action, dto.selection, Boolean(dto.dryRun), principal, idempotencyKey, {
      plan: (lead) => this.planUpdate(dto, lead),
      apply: async (lead) => {
        await this.mutations.update(
          lead.id,
          dto.action === 'SET_STATUS'
            ? {
                status: dto.status!,
                ...(dto.lostReason ? { lostReason: dto.lostReason } : {}),
                ...(dto.nextFollowUpAt ? { nextFollowUpAt: dto.nextFollowUpAt } : {}),
              }
            : dto.action === 'SET_PRIORITY'
              ? { priority: dto.priority! }
              : { nextFollowUpAt: dto.nextFollowUpAt! },
          principal,
        );
      },
      params: {
        status: dto.status ?? null,
        priority: dto.priority ?? null,
        nextFollowUpAt: dto.nextFollowUpAt ?? null,
        lostReason: dto.lostReason ?? null,
      },
    });
  }

  async assign(
    dto: BulkAssignLeadsDto,
    principal: TenantPrincipal,
    idempotencyKey: string | undefined,
  ): Promise<LeadBulkResult> {
    // `leads.assigned_to` references the GLOBAL users table: membership is checked once, here.
    if (!(await this.repository.isActiveMember(dto.assignedToId))) {
      throw AppException.validation('Cannot assign these leads.', {
        assignedToId: ['must be an active member of your organization'],
      });
    }
    return this.run('ASSIGN', dto.selection, Boolean(dto.dryRun), principal, idempotencyKey, {
      plan: (lead) =>
        lead.assignedToId === dto.assignedToId
          ? { outcome: 'UNCHANGED', reason: 'Already assigned to this person.' }
          : { outcome: 'WILL_CHANGE' },
      apply: async (lead) => {
        await this.mutations.assign(
          lead.id,
          { assignedToId: dto.assignedToId, reason: dto.reason ?? 'Reassigned in bulk' },
          principal,
        );
      },
      params: { assignedToId: dto.assignedToId },
    });
  }

  // --- the shared engine ---------------------------------------------------------

  private async run(
    action: LeadBulkAction,
    selection: LeadSelectionDto,
    dryRun: boolean,
    principal: TenantPrincipal,
    idempotencyKey: string | undefined,
    step: {
      plan: (lead: Lead) => Plan;
      apply: (lead: Lead) => Promise<void>;
      params: Record<string, unknown>;
    },
  ): Promise<LeadBulkResult> {
    if (!dryRun) {
      if (!idempotencyKey || !/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) {
        throw AppException.validation(
          'An Idempotency-Key header (16–100 letters, digits, - or _) is required to apply a bulk change.',
        );
      }
      const replay = await this.replay(idempotencyKey);
      if (replay) return { ...replay, replayed: true };
    }

    const ids = await this.resolve(selection, principal);
    const snapshot = new Date(selection.snapshotAt);
    const restrict = visibilityFilter(principal)?.assignedToId;
    const items: LeadBulkItemResult[] = [];

    for (const id of ids) {
      const lead = await this.repository.findById(id, restrict);
      if (!lead) {
        items.push({
          id,
          name: null,
          outcome: 'REFUSED',
          code: 'NOT_FOUND',
          reason: 'Not found or not visible to you.',
        });
        continue;
      }
      const name = displayName(lead);
      if (lead.updatedAt.getTime() > snapshot.getTime()) {
        items.push({
          id,
          name,
          outcome: 'CONFLICT',
          code: 'STALE_RECORD',
          reason: 'Someone changed this lead after you selected it. Reload and try again.',
        });
        continue;
      }
      const plan = step.plan(lead);
      if (plan.outcome !== 'WILL_CHANGE') {
        items.push({
          id,
          name,
          outcome: plan.outcome,
          reason: plan.reason,
          ...(plan.code ? { code: plan.code } : {}),
        });
        continue;
      }
      if (dryRun) {
        items.push({ id, name, outcome: 'WILL_CHANGE' });
        continue;
      }
      try {
        await step.apply(lead);
        items.push({ id, name, outcome: 'CHANGED' });
      } catch (error) {
        if (!(error instanceof AppException)) {
          this.logger.error(`Bulk ${action} failed for lead ${id}: ${(error as Error).message}`);
        }
        items.push({
          id,
          name,
          outcome: 'REFUSED',
          code: error instanceof AppException ? error.code : 'FAILED',
          reason:
            error instanceof AppException
              ? error.message
              : 'This lead could not be changed. Nothing was written for it.',
        });
      }
    }

    const result: LeadBulkResult = {
      action,
      dryRun,
      replayed: false,
      summary: summarise(items),
      items,
    };
    if (!dryRun) {
      await this.audit.record({
        action: BULK_AUDIT,
        entityType: 'lead',
        after: {
          idempotencyKey,
          action,
          params: step.params,
          selection: selection.ids
            ? { ids: selection.ids.length }
            : { query: selection.query ?? {} },
          result: { action, dryRun: false, replayed: false, summary: result.summary, items },
        },
      });
    }
    return result;
  }

  /** The leads a selection means, with the caller's own visibility. */
  private async resolve(
    selection: LeadSelectionDto,
    principal: TenantPrincipal,
  ): Promise<string[]> {
    if (selection.ids && selection.query) {
      throw AppException.validation('Choose either ticked leads or all matching leads, not both.');
    }
    if (selection.ids) {
      if (selection.ids.length === 0) throw AppException.validation('Select at least one lead.');
      return [...new Set(selection.ids)];
    }
    if (!selection.query) throw AppException.validation('Select at least one lead.');
    const excluded = new Set(selection.excludeIds ?? []);
    const ids: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.leads.list(
        { ...selection.query, ...(cursor ? { cursor } : {}), limit: 100 },
        principal,
      );
      if ((page.total ?? 0) - excluded.size > LEAD_BULK_LIMIT) {
        throw AppException.conflict(
          ERROR_CODES.CONFLICT,
          `This view matches ${page.total ?? 0} leads. Narrow it to ${LEAD_BULK_LIMIT} or fewer to change them together.`,
        );
      }
      for (const item of page.items) if (!excluded.has(item.id)) ids.push(item.id);
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    if (ids.length === 0) throw AppException.validation('No leads match this selection.');
    return ids;
  }

  private planUpdate(dto: BulkUpdateLeadsDto, lead: Lead): Plan {
    const current = lead.status as LeadStatus;
    if (dto.action === 'SET_PRIORITY') {
      return lead.priority === dto.priority
        ? { outcome: 'UNCHANGED', reason: 'Already this priority.' }
        : (this.needsFollowUp(lead, current) ?? { outcome: 'WILL_CHANGE' });
    }
    if (dto.action === 'SCHEDULE_FOLLOW_UP') {
      return isTerminal(current)
        ? {
            outcome: 'REFUSED',
            code: 'CLOSED_LEAD',
            reason: `A ${current.toLowerCase()} lead has no follow-ups.`,
          }
        : { outcome: 'WILL_CHANGE' };
    }
    const target = dto.status!;
    if (target === current) return { outcome: 'UNCHANGED', reason: 'Already at this stage.' };
    try {
      assertStatusAllowed(lead.qualification, target);
    } catch (error) {
      if (error instanceof AppException)
        return { outcome: 'REFUSED', code: error.code, reason: error.message };
      throw error;
    }
    const check = canTransition(current, target);
    if (!check.allowed) {
      return {
        outcome: 'REFUSED',
        code: ERROR_CODES.INVALID_STATUS_TRANSITION,
        reason: check.reason ?? 'That stage change is not allowed.',
      };
    }
    if (!isTerminal(target) && !dto.nextFollowUpAt && !lead.nextFollowUpAt) {
      return {
        outcome: 'REFUSED',
        code: 'FOLLOW_UP_REQUIRED',
        reason: 'An open lead needs a next follow-up date. Choose one for this change.',
      };
    }
    return { outcome: 'WILL_CHANGE' };
  }

  /** An open lead with no next action cannot be saved by any edit; say so up front. */
  private needsFollowUp(lead: Lead, status: LeadStatus): Plan | null {
    return !isTerminal(status) && !lead.nextFollowUpAt
      ? {
          outcome: 'REFUSED',
          code: 'FOLLOW_UP_REQUIRED',
          reason: 'Schedule a next follow-up for this lead first.',
        }
      : null;
  }

  private requireParams(dto: BulkUpdateLeadsDto): void {
    if (dto.action === 'SET_STATUS') {
      if (!dto.status)
        throw AppException.validation('Choose the new stage.', { status: ['is required'] });
      if (dto.status === 'WON') {
        throw AppException.validation(
          'Won is set one lead at a time, so each win records its customer and value.',
          { status: ['WON is not available in bulk'] },
        );
      }
      if (dto.status === 'LOST' && !dto.lostReason) {
        throw AppException.validation('A reason is required when marking leads lost.', {
          lostReason: ['is required'],
        });
      }
    }
    if (dto.action === 'SET_PRIORITY' && !dto.priority) {
      throw AppException.validation('Choose the new priority.', { priority: ['is required'] });
    }
    if (dto.action === 'SCHEDULE_FOLLOW_UP' && !dto.nextFollowUpAt) {
      throw AppException.validation('Choose the follow-up date.', {
        nextFollowUpAt: ['is required'],
      });
    }
  }

  /** The stored answer for this key in this organization, within the replay window. */
  private async replay(key: string): Promise<LeadBulkResult | null> {
    return (await this.repository.findBulkResult(
      key,
      new Date(Date.now() - REPLAY_WINDOW_MS),
    )) as LeadBulkResult | null;
  }
}

function summarise(items: LeadBulkItemResult[]): LeadBulkResult['summary'] {
  const count = (o: LeadBulkItemResult['outcome']) => items.filter((i) => i.outcome === o).length;
  return {
    matched: items.length,
    willChange: count('WILL_CHANGE'),
    changed: count('CHANGED'),
    unchanged: count('UNCHANGED'),
    refused: count('REFUSED'),
    conflicts: count('CONFLICT'),
  };
}

function displayName(lead: Lead): string {
  const person = [lead.firstName, lead.lastName].filter(Boolean).join(' ');
  return lead.companyName ? `${lead.companyName}${person ? ` · ${person}` : ''}` : person || 'Lead';
}
