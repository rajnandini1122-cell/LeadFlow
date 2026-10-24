import { Injectable } from '@nestjs/common';
import {
  CALL_OUTCOME_RULES,
  ERROR_CODES,
  PERMISSIONS,
  type CallOutcome,
  type LeadStatus,
} from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import type { FollowUpType } from '../../generated/prisma/enums';
import { LeadsRepository } from '../leads/leads.repository';
import { visibilityFilter } from '../leads/lead-visibility';
import { isTerminal } from '../leads/lead-status';
import { FollowUpsRepository, findReplay, lockFollowUpRow } from './follow-ups.repository';
import { AUDIT_ACTIONS } from '../../common/audit/audit.repository';
import { formatZonedDateTime } from '../../common/utils/zoned-time';
import { BUCKETS, windowFor, type Bucket } from './follow-up-buckets';
import type { RecordOutcomeDto } from './dto/record-outcome.dto';
import type {
  CancelFollowUpDto,
  CompleteFollowUpDto,
  CreateFollowUpDto,
  RecordAttemptDto,
  RescheduleFollowUpDto,
} from './dto/follow-ups.dto';

/** The sales workspace's numbers. See FollowUpsService.workspaceSummary. */
export interface WorkspaceSummary {
  /** The IANA timezone every day boundary was computed in. */
  timezone: string;
  /** Whose work these numbers describe. */
  scope: 'OWN' | 'TEAM';
  followUps: Record<Bucket, number>;
  leads: {
    /** Still NEW and never reached. */
    fresh: number;
    /** Waiting on the customer — last outcome, or a quotation out. */
    awaiting: number;
    /** Nobody owns them. Null when the caller cannot see the whole team. */
    unassigned: number | null;
  };
}

/** What logging one call produced. */
export interface RecordOutcomeResult {
  leadId: string;
  outcome: CallOutcome;
  /** The stage after the call — returned so the caller can SEE whether it moved. */
  leadStatus: LeadStatus;
  /** The follow-up this call completed, or null (a missed call completes nothing). */
  completedFollowUpId: string | null;
  /** The next action now queued, or null (closed, or nobody owns the lead). */
  followUp: FollowUpView | null;
  nextFollowUpAt: string | null;
  /** True when this answered a repeat of an earlier request with the same key. */
  replayed: boolean;
}

export interface FollowUpView {
  id: string;
  /**
   * The opportunity, when there is one.
   *
   * Null for an account-level follow-up — "call ABC Foods on Monday about a
   * repeat order", which is real work with no open enquiry behind it. Every
   * lead-derived field below is null in that case for the same reason.
   */
  leadId: string | null;
  leadNumber: string | null;
  leadName: string | null;
  /** The customer, when the follow-up is on the relationship rather than a deal. */
  accountId: string | null;
  accountName: string | null;
  companyName: string | null;
  mobile: string | null;
  leadStatus: string | null;
  leadPriority: string | null;
  /** What the last call on this lead established — a CALL_OUTCOMES code. */
  leadLastOutcome: string | null;
  leadLastOutcomeAt: string | null;
  /** Already fetched for the row; surfaced so a report can total value at risk. */
  estimatedValue: string | null;
  scheduledAt: string;
  type: string;
  status: string;
  title: string | null;
  notes: string | null;
  outcome: string | null;
  completedAt: string | null;
  /**
   * Set when this follow-up was moved: it points at its replacement. A
   * CANCELLED row with this set was RESCHEDULED, not abandoned — the queue
   * history shows the two differently.
   */
  rescheduledToId: string | null;
  assignedTo: { id: string; fullName: string };
  isOverdue: boolean;
}

@Injectable()
export class FollowUpsService {
  constructor(
    private readonly repository: FollowUpsRepository,
    private readonly leads: LeadsRepository,
  ) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async listBucket(
    bucket: Bucket,
    principal: TenantPrincipal,
    options: { assignedUserId?: string | undefined; limit?: number | undefined },
  ): Promise<FollowUpView[]> {
    const timezone = await this.leads.organizationTimezone();
    const window = windowFor(bucket, timezone);

    const rows = await this.repository.list({
      window,
      assignedUserId: options.assignedUserId,
      restrictToUserId: this.restriction(principal),
      limit: options.limit ?? 100,
    });

    return rows.map(toView);
  }

  /**
   * Everything the sales workspace counts, in one response.
   *
   * Lead counts use the lead list's own filters (`fresh`, `awaiting`,
   * `unassigned`) and the caller's lead visibility, exactly as the list they
   * open does. Unassigned is null for someone who cannot see the whole team —
   * for them it would always be zero, which reads as "nothing to assign".
   */
  async workspaceSummary(
    principal: TenantPrincipal,
    options: { assignedUserId?: string | undefined } = {},
  ): Promise<WorkspaceSummary> {
    const timezone = await this.leads.organizationTimezone();
    const leadScope = visibilityFilter(principal)?.assignedToId;
    const owner = leadScope ?? options.assignedUserId;
    const seesTeam = leadScope === undefined;

    const [followUps, fresh, awaiting, unassigned] = await Promise.all([
      this.bucketCounts(principal, options),
      this.leads.countMatching({ fresh: true, lifecycle: 'ACTIVE', ...(owner ? { restrictToUserId: owner } : {}) }),
      this.leads.countMatching({ awaiting: true, lifecycle: 'ACTIVE', ...(owner ? { restrictToUserId: owner } : {}) }),
      seesTeam ? this.leads.countMatching({ unassigned: true, lifecycle: 'ACTIVE' }) : Promise.resolve(null),
    ]);

    return {
      timezone,
      scope: seesTeam && !options.assignedUserId ? 'TEAM' : 'OWN',
      followUps,
      leads: { fresh, awaiting, unassigned },
    };
  }

  /**
   * The true size of every bucket, from the same predicate as the lists.
   *
   * The tabs used to count the rows a 200-row page had fetched, so a bucket of
   * 340 read "200". These are real totals, computed with ONE `now` so the
   * buckets partition the same instant rather than drifting between queries.
   */
  async bucketCounts(
    principal: TenantPrincipal,
    options: { assignedUserId?: string | undefined } = {},
  ): Promise<Record<Bucket, number>> {
    const timezone = await this.leads.organizationTimezone();
    const now = new Date();
    const scope = { assignedUserId: options.assignedUserId, restrictToUserId: this.restriction(principal) };

    const counts = await Promise.all(
      BUCKETS.map((bucket) => this.repository.count({ window: windowFor(bucket, timezone, now), ...scope })),
    );
    return Object.fromEntries(BUCKETS.map((bucket, i) => [bucket, counts[i] ?? 0])) as Record<Bucket, number>;
  }

  /**
   * Follow-ups owed on a CUSTOMER rather than on any one enquiry.
   *
   * No lead visibility filter applies, because there is no lead: access is
   * governed by the caller holding account.view, which the controller checks.
   */
  async listForAccount(accountId: string): Promise<FollowUpView[]> {
    return (await this.repository.listForAccount(accountId)).map(toView);
  }

  /**
   * Schedules a follow-up on a customer, with no lead involved.
   *
   * Deliberately does NOT apply the "no lead left behind" rule: there is no
   * enquiry behind this, so nothing can be left behind. Forcing a lead into
   * existence to record "call them next Monday" is exactly what corrupted the
   * pipeline before account follow-ups existed.
   *
   * The caller has already verified the account belongs to this tenant.
   */
  async createForAccount(
    accountId: string,
    dto: CreateFollowUpDto,
    principal: TenantPrincipal,
  ): Promise<FollowUpView> {
    const assignedUserId = await this.resolveAssignee(
      dto.assignedUserId,
      { assignedToId: null },
      principal,
    );

    const followUp = await this.repository.create({
      accountId,
      assignedUserId,
      scheduledAt: parseWhen(dto.scheduledAt),
      type: (dto.type ?? 'CALL') as FollowUpType,
      title: dto.title,
      notes: dto.notes,
      actorId: principal.userId,
    });

    return toView(followUp);
  }

  async listForLead(leadId: string, principal: TenantPrincipal): Promise<FollowUpView[]> {
    // Reading the lead first applies the caller's lead visibility, so a rep
    // cannot see follow-ups on a colleague's lead by asking for them here.
    await this.requireVisibleLead(leadId, principal);
    return (await this.repository.listForLead(leadId)).map(toView);
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  async create(
    leadId: string,
    dto: CreateFollowUpDto,
    principal: TenantPrincipal,
    idempotencyKey: string | null = null,
  ): Promise<FollowUpView> {
    await this.requireVisibleLead(leadId, principal);
    const scheduledAt = parseWhen(dto.scheduledAt);

    // Row, mirror and timeline in one commit, under the lead's lock.
    return this.repository.inLeadTransaction(leadId, async (tx, lead) => {
      if (!lead) throw AppException.leadNotFound();

      const replay = await findReplay(tx, {
        leadId,
        activityType: 'FOLLOW_UP_CREATED',
        key: idempotencyKey,
      });
      if (typeof replay?.['followUpId'] === 'string') {
        const original = await this.repository.findById(replay['followUpId'], undefined, tx);
        if (original) return toView(original);
      }

      // Checked under the lock, so a lead closed a moment ago is seen closed.
      if (isTerminal(lead.status as LeadStatus)) {
        throw AppException.validation(
          'This lead is closed. Reopen it before scheduling a follow-up.',
          { leadId: ['lead is won or lost'] },
        );
      }

      const assignedUserId = await this.resolveAssignee(dto.assignedUserId, lead, principal);

      const followUp = await this.repository.create({
        leadId,
        assignedUserId,
        scheduledAt,
        type: (dto.type ?? 'CALL') as FollowUpType,
        title: dto.title,
        notes: dto.notes,
        actorId: principal.userId,
        tx,
      });

      await this.repository.syncLeadNextFollowUp(leadId, tx);
      await this.repository.recordLeadActivity(tx, {
        leadId,
        activityType: 'FOLLOW_UP_CREATED',
        // In the organization's time, not a UTC ISO string nobody can read.
        description: `Follow-up scheduled for ${formatZonedDateTime(scheduledAt, await this.repository.organizationTimezone(tx))}`,
        actorId: principal.userId,
        idempotencyKey,
        result: { followUpId: followUp.id },
      });

      return toView(followUp);
    });
  }

  /**
   * Completes a follow-up.
   *
   * This is where the product promise is actually enforced: an active lead may
   * not be left with nothing scheduled, so completion must either schedule the
   * next action or close the lead. Allowing a bare "done" is precisely how
   * leads get forgotten — and the database CHECK constraint would reject the
   * write anyway, as a 500 rather than a useful message.
   */
  async complete(
    id: string,
    dto: CompleteFollowUpDto,
    principal: TenantPrincipal,
    idempotencyKey: string | null = null,
  ): Promise<{ followUp: FollowUpView; nextFollowUpAt: string | null }> {
    const existing = await this.requireOwnFollowUp(id, principal);

    /*
     * The "no lead left behind" rule applies to a LEAD.
     *
     * An account-level follow-up has no pipeline behind it, so completing one
     * without scheduling another leaves nothing forgotten — there is no open
     * enquiry to forget. Applying the lead rule here would force a rep to
     * schedule a perpetual call on every customer they ever spoke to.
     *
     * For a lead the rule is unchanged and just as strict.
     */
    const leadStatusAfter = existing.lead
      ? ((dto.leadStatus ?? existing.lead.status) as LeadStatus)
      : null;
    const leadStaysOpen = leadStatusAfter !== null && !isTerminal(leadStatusAfter);

    if (leadStaysOpen && !dto.nextFollowUpAt) {
      throw AppException.validation(
        'Schedule the next follow-up, or mark the lead won or lost.',
        { nextFollowUpAt: ['is required while the lead is still open'] },
      );
    }

    if (!existing.lead && dto.leadStatus) {
      throw AppException.validation(
        'This follow-up is on a customer, not on a lead, so it has no lead status to set.',
        { leadStatus: ['not applicable to an account follow-up'] },
      );
    }

    const nextAt = dto.nextFollowUpAt ? parseWhen(dto.nextFollowUpAt) : null;

    /*
     * ONE commit for the whole outcome of one conversation: close this
     * follow-up, change the stage, schedule the next action, re-derive the
     * mirror and write the timeline.
     *
     * These were five separate writes. A failure after the close left a
     * completed follow-up with no next action — and the mirror update then hit
     * the CHECK constraint as a 500, AFTER the completion had already landed.
     */
    return this.repository.inLeadTransaction(existing.leadId, async (tx) => {
      if (existing.leadId) {
        const replay = await findReplay(tx, {
          leadId: existing.leadId,
          activityType: 'FOLLOW_UP_COMPLETED',
          key: idempotencyKey,
        });
        if (replay) {
          // The same request again — a double click or a retry after a lost
          // response. It succeeded the first time; say so, with that result,
          // rather than "already completed", which reads as a failure.
          const original = await this.repository.findById(id, undefined, tx);
          const mirror = await this.repository.leadNextFollowUpAt(existing.leadId, tx);
          return {
            followUp: toView(original ?? existing),
            nextFollowUpAt: mirror?.toISOString() ?? null,
          };
        }
      } else {
        /*
         * An account follow-up has no lead to lock and no timeline to hold the
         * key. Its own row is locked instead, and the key is matched against
         * the audit entry the first request wrote — so a retried completion of
         * a customer follow-up is answered like a lead one, not with 409.
         */
        await lockFollowUpRow(tx, id);
        const replay = await this.repository.findAccountReplay(tx, {
          followUpId: id,
          action: AUDIT_ACTIONS.ACCOUNT_FOLLOW_UP_COMPLETED,
          key: idempotencyKey,
        });
        if (replay) {
          const original = await this.repository.findById(id, undefined, tx);
          // An account follow-up carries no next-action mirror; the first
          // response said null too.
          return { followUp: toView(original ?? existing), nextFollowUpAt: null };
        }
      }

      const closed = await this.repository.close({
        id,
        status: 'COMPLETED',
        outcome: dto.outcome,
        notes: dto.notes,
        actorId: principal.userId,
        tx,
      });

      // Zero rows means somebody else already completed or cancelled it. A
      // genuine conflict — a replay of THIS request was answered above.
      if (closed === 0) {
        throw AppException.conflict(
          ERROR_CODES.CONFLICT,
          'This follow-up has already been completed or cancelled.',
        );
      }

      if (existing.leadId && dto.leadStatus && dto.leadStatus !== existing.lead?.status) {
        await this.leads.applyStatusChange({
          leadId: existing.leadId,
          status: dto.leadStatus,
          lostReason: dto.lostReason,
          wonValue: dto.wonValue,
          actorId: principal.userId,
          tx,
        });
      }

      /*
       * A next action is scheduled when the lead stays open, and is ALLOWED on
       * an account follow-up when the caller asks for one — a rep who says
       * "call them again in a month" should get that, without a lead existing.
       */
      let nextFollowUpId: string | null = null;
      if (nextAt && (leadStaysOpen || !existing.leadId)) {
        const next = await this.repository.create({
          leadId: existing.leadId,
          accountId: existing.accountId,
          assignedUserId: existing.assignedUserId,
          scheduledAt: nextAt,
          type: (dto.nextType ?? existing.type) as FollowUpType,
          actorId: principal.userId,
          tx,
        });
        nextFollowUpId = next.id;
      }

      // Only a lead carries the denormalised next_follow_up_at mirror.
      const nextFollowUpAt = existing.leadId
        ? await this.repository.syncLeadNextFollowUp(existing.leadId, tx)
        : null;

      if (existing.leadId) {
        await this.repository.recordLeadActivity(tx, {
          leadId: existing.leadId,
          activityType: 'FOLLOW_UP_COMPLETED',
          description: dto.outcome
            ? `Follow-up completed: ${dto.outcome}`
            : 'Follow-up completed',
          actorId: principal.userId,
          idempotencyKey,
          result: { followUpId: id, nextFollowUpId },
        });
      } else {
        await this.repository.recordAccountFollowUpAction(tx, {
          followUpId: id,
          action: AUDIT_ACTIONS.ACCOUNT_FOLLOW_UP_COMPLETED,
          actorId: principal.userId,
          idempotencyKey,
          result: { outcome: dto.outcome ?? null, nextFollowUpId },
        });
      }

      const refreshed = await this.repository.findById(id, undefined, tx);

      return {
        followUp: toView(refreshed ?? existing),
        nextFollowUpAt: nextFollowUpAt?.toISOString() ?? null,
      };
    });
  }

  /**
   * Reschedules by creating a REPLACEMENT and linking the original to it.
   *
   * Mutating `scheduledAt` in place would be simpler and would erase the fact
   * that an attempt was missed — which is the single most useful signal a
   * manager has. The chain stays visible instead.
   */
  /**
   * Records a FAILED CONTACT ATTEMPT and schedules the retry.
   *
   * THE DEFECT THIS FIXES. "No answer" posted a single activity row and
   * stopped: no retry was scheduled, the pending follow-up was untouched, and
   * nothing reached the queue. A rep who rang four times and got no answer had
   * four timeline entries, an overdue follow-up still sitting at its original
   * date, and no record that anybody had tried.
   *
   * WHY THIS IS NOT `complete`. An unanswered call is an attempt, not an
   * outcome: the work is still owed. Completing the follow-up would mark the
   * task done and drop it out of the queue — the precise opposite of what a
   * missed call means. So the attempt is logged, the pending follow-up is
   * SUPERSEDED by one at the retry time, and the lead keeps its place in the
   * queue.
   *
   * THE SALES STAGE IS NEVER TOUCHED. Not by omission — there is no parameter
   * for it, so no caller can. A lead at NEW that nobody answered is still at
   * NEW: "Contacted" means somebody was reached, and letting a failed attempt
   * set it would overstate the pipeline and corrupt every stage-conversion
   * figure computed from it.
   *
   * Outcome, note and retry time are all ONE request, so the three facts about
   * one phone call commit together or not at all.
   */
  async recordAttempt(
    leadId: string,
    dto: RecordAttemptDto,
    principal: TenantPrincipal,
    idempotencyKey: string | null = null,
  ): Promise<{
    followUp: FollowUpView | null;
    nextFollowUpAt: string | null;
    leadStatus: LeadStatus;
  }> {
    await this.requireVisibleLead(leadId, principal);
    const retryAt = parseWhen(dto.retryAt);

    /*
     * The attempt and its retry commit TOGETHER, under the lead's lock.
     *
     * They were two writes: the timeline entry, then the reschedule. A double
     * click therefore logged two attempts and superseded the retry twice, and a
     * failure between the two left an attempt on record with no retry behind
     * it — the dead end this endpoint exists to remove.
     */
    return this.repository.inLeadTransaction(leadId, async (tx, lead) => {
      if (!lead) throw AppException.leadNotFound();

      const replay = await findReplay(tx, {
        leadId,
        activityType: dto.activityType,
        key: idempotencyKey,
      });
      if (replay) {
        // The same click again. ONE attempt happened; answer with its result.
        const followUpId = typeof replay['followUpId'] === 'string' ? replay['followUpId'] : null;
        const followUp = followUpId ? await this.repository.findById(followUpId, undefined, tx) : null;
        const mirror = await this.repository.leadNextFollowUpAt(leadId, tx);
        return {
          followUp: followUp ? toView(followUp) : null,
          nextFollowUpAt: mirror?.toISOString() ?? null,
          leadStatus: lead.status as LeadStatus,
        };
      }

      /*
       * A closed lead owes nobody a call.
       *
       * Refused rather than silently reopening it: reopening is a deliberate
       * decision with its own audit trail, and a quick-action button is not
       * where a won deal should be able to make it. Checked under the lock, so
       * a lead closed a moment ago is seen closed.
       */
      if (isTerminal(lead.status as LeadStatus)) {
        throw AppException.validation(
          'This lead is closed. Reopen it before logging another attempt.',
          { leadId: ['lead is won or lost'] },
        );
      }

      const result = await this.repository.setNextForLead({
        leadId,
        scheduledAt: retryAt,
        // Null when nobody owns the lead: there is no such thing as an
        // unassigned follow-up, and inventing an assignee would hand this
        // person's work to whoever happened to click the button.
        assignedUserId: lead.assignedToId ?? null,
        ...(dto.type ? { type: dto.type as FollowUpType } : {}),
        reason: `Retry after ${ATTEMPT_LABELS[dto.activityType] ?? 'a failed attempt'}`,
        actorId: principal.userId,
        tx,
      });

      /*
       * The same facts the outcome endpoint records, so a missed call logged
       * through this older endpoint still shows as the lead's last outcome.
       * WhatsApp has no call outcome, so it leaves them untouched.
       */
      const legacyOutcome = LEGACY_ATTEMPT_OUTCOMES[dto.activityType];
      if (legacyOutcome) {
        await this.repository.recordLeadOutcomeFacts(tx, {
          leadId,
          outcome: legacyOutcome,
          at: new Date(),
          reached: CALL_OUTCOME_RULES[legacyOutcome].reached,
          actorId: principal.userId,
        });
      }

      await this.repository.recordLeadActivity(tx, {
        leadId,
        activityType: dto.activityType,
        description: attemptDescription(dto),
        actorId: principal.userId,
        idempotencyKey,
        result: { followUpId: result.followUpId },
      });

      const followUp = result.followUpId
        ? await this.repository.findById(result.followUpId, undefined, tx)
        : null;

      return {
        followUp: followUp ? toView(followUp) : null,
        nextFollowUpAt: result.nextFollowUpAt.toISOString(),
        // Returned so the caller can SEE the stage did not move, rather than
        // taking it on trust.
        leadStatus: lead.status as LeadStatus,
      };
    });
  }

  /**
   * Records the outcome of one call, and everything it decides, in ONE commit.
   *
   * The outcome's rule (CALL_OUTCOME_RULES) decides the behaviour:
   *
   *   reached       the follow-up being worked is COMPLETED with the outcome;
   *                 a NEW lead becomes CONTACTED; lastContactedAt moves.
   *   not reached   the follow-up is NOT completed — it is superseded by the
   *                 retry, so the work stays owed and stays in the queue.
   *
   * Either way exactly one open follow-up remains (the next action), unless the
   * lead is closed as LOST, which the outcome must offer. The stage never moves
   * backwards, and a missed call or a reschedule never moves it at all.
   *
   * Idempotent on the Idempotency-Key, under the lead's row lock — a double
   * click is answered with the first result, never a second call on the record.
   */
  async recordOutcome(
    leadId: string,
    dto: RecordOutcomeDto,
    principal: TenantPrincipal,
    idempotencyKey: string | null = null,
  ): Promise<RecordOutcomeResult> {
    await this.requireVisibleLead(leadId, principal);
    const rule = CALL_OUTCOME_RULES[dto.outcome];

    // --- shape checks that depend on the outcome ------------------------------
    const requirementGiven =
      dto.productId !== undefined ||
      dto.productInterest !== undefined ||
      dto.quantity !== undefined ||
      dto.expectedPurchaseDate !== undefined;
    if (requirementGiven && !rule.capturesRequirement) {
      throw AppException.validation(`"${rule.label}" does not record a requirement.`, {
        outcome: ['requirement fields are only accepted with a requirement outcome'],
      });
    }
    if (dto.close && !rule.offersClose) {
      throw AppException.validation(`"${rule.label}" cannot close the lead.`, {
        close: ['not offered for this outcome — schedule the next action instead'],
      });
    }
    if (dto.markQualified && !rule.suggestsQualified) {
      throw AppException.validation(`"${rule.label}" does not qualify the lead.`, {
        markQualified: ['not offered for this outcome'],
      });
    }
    if (!dto.close && !dto.nextFollowUpAt) {
      // The "no lead left behind" rule: an open lead keeps a next action.
      throw AppException.validation('Schedule the next action, or close the lead.', {
        nextFollowUpAt: ['is required unless the lead is being closed'],
      });
    }
    if (dto.expectedPurchaseDate && Number.isNaN(Date.parse(`${dto.expectedPurchaseDate}T00:00:00Z`))) {
      throw AppException.validation('Invalid date.', { expectedPurchaseDate: ['is not a real date'] });
    }
    if (dto.productId && !(await this.leads.productExists(dto.productId))) {
      throw AppException.validation('That product does not exist.', { productId: ['not found'] });
    }
    const nextAt = dto.nextFollowUpAt ? parseWhen(dto.nextFollowUpAt) : null;

    return this.repository.inLeadTransaction(leadId, async (tx, lead) => {
      if (!lead) throw AppException.leadNotFound();

      // --- a replay of this exact request --------------------------------------
      const replay = await findReplay(tx, {
        leadId,
        activityType: rule.activityType,
        key: idempotencyKey,
      });
      if (replay) {
        const nextId = typeof replay['nextFollowUpId'] === 'string' ? replay['nextFollowUpId'] : null;
        const next = nextId ? await this.repository.findById(nextId, undefined, tx) : null;
        const currentStatus = await this.repository.leadStatus(leadId, tx);
        return {
          leadId,
          outcome: (replay['outcome'] as CallOutcome | undefined) ?? dto.outcome,
          leadStatus: (currentStatus ?? lead.status) as LeadStatus,
          completedFollowUpId:
            typeof replay['completedFollowUpId'] === 'string' ? replay['completedFollowUpId'] : null,
          followUp: next ? toView(next) : null,
          nextFollowUpAt: (await this.repository.leadNextFollowUpAt(leadId, tx))?.toISOString() ?? null,
          replayed: true,
        };
      }

      // Checked under the lock, so a lead closed a moment ago is seen closed.
      if (isTerminal(lead.status as LeadStatus)) {
        throw AppException.validation(
          'This lead is closed. Reopen it before logging another call.',
          { leadId: ['lead is won or lost'] },
        );
      }

      const now = new Date();
      const worked = await this.repository.findWorkedFollowUp(tx, leadId, dto.followUpId);
      if (dto.followUpId && !worked) {
        throw AppException.conflict(
          ERROR_CODES.CONFLICT,
          'That follow-up is no longer open — somebody may have completed or rescheduled it.',
        );
      }

      // 1. The follow-up being worked. Completed only if the call happened.
      let completedFollowUpId: string | null = null;
      if (rule.followUp === 'complete' && worked) {
        const closed = await this.repository.close({
          id: worked.id,
          status: 'COMPLETED',
          outcome: rule.label.slice(0, 60),
          notes: dto.note,
          actorId: principal.userId,
          tx,
        });
        if (closed > 0) completedFollowUpId = worked.id;
      }

      // 2. The stage — forward only, and only by rule.
      const current = lead.status as LeadStatus;
      let target: LeadStatus = current;
      if (dto.close) {
        target = 'LOST';
      } else {
        if (rule.reached && current === 'NEW') target = 'CONTACTED';
        if (dto.markQualified && ['NEW', 'CONTACTED', 'FOLLOW_UP'].includes(current)) {
          target = 'QUALIFIED';
        }
      }
      if (target !== current) {
        await this.leads.applyStatusChange({
          leadId,
          status: target,
          lostReason: target === 'LOST' ? (dto.lostReason ?? rule.defaultLostReason ?? rule.label) : undefined,
          actorId: principal.userId,
          tx,
        });
      }

      // 3. The next action — exactly one open follow-up afterwards.
      let nextFollowUpId: string | null = null;
      if (!dto.close && nextAt) {
        const result = await this.repository.setNextForLead({
          leadId,
          scheduledAt: nextAt,
          // Null when nobody owns the lead: the mirror alone carries the date.
          assignedUserId: lead.assignedToId ?? null,
          type: (dto.nextType ?? 'CALL') as FollowUpType,
          title: rule.nextTitle,
          reason: rule.followUp === 'retry' ? `Retry after: ${rule.label}` : `Superseded by: ${rule.label}`,
          actorId: principal.userId,
          tx,
        });
        nextFollowUpId = result.followUpId;
      }

      // 4. What the call established, on the lead itself.
      await this.repository.recordLeadOutcomeFacts(tx, {
        leadId,
        outcome: dto.outcome,
        at: now,
        reached: rule.reached,
        actorId: principal.userId,
        requirement: rule.capturesRequirement
          ? {
              productId: dto.productId,
              productInterest: dto.productInterest,
              quantity: dto.quantity,
              expectedPurchaseDate: dto.expectedPurchaseDate,
            }
          : undefined,
      });

      // 5. The timeline: one entry for one call, carrying the key and the result.
      await this.repository.recordLeadActivity(tx, {
        leadId,
        activityType: rule.activityType,
        description: outcomeDescription(rule.label, dto),
        actorId: principal.userId,
        idempotencyKey,
        result: {
          outcome: dto.outcome,
          completedFollowUpId,
          nextFollowUpId,
          ...(rule.capturesRequirement
            ? {
                quantity: dto.quantity ?? null,
                expectedPurchaseDate: dto.expectedPurchaseDate ?? null,
              }
            : {}),
        },
      });

      const next = nextFollowUpId ? await this.repository.findById(nextFollowUpId, undefined, tx) : null;

      return {
        leadId,
        outcome: dto.outcome,
        leadStatus: target,
        completedFollowUpId,
        followUp: next ? toView(next) : null,
        nextFollowUpAt: (await this.repository.leadNextFollowUpAt(leadId, tx))?.toISOString() ?? null,
        replayed: false,
      };
    });
  }

  /**
   * Moves a lead's next action, from the lead screen rather than a follow-up.
   *
   * Used by the lead edit form and by activity logging, both of which used to
   * write `leads.next_follow_up_at` directly and create no follow-up row. That
   * is what produced "Next action: a date" beside "Follow-ups: 0 open".
   */
  async setNextForLead(
    leadId: string,
    scheduledAt: Date,
    principal: TenantPrincipal,
    reason?: string,
  ): Promise<{ followUpId: string | null; nextFollowUpAt: Date }> {
    const lead = await this.requireVisibleLead(leadId, principal);

    return this.repository.setNextForLead({
      leadId,
      scheduledAt,
      assignedUserId: lead.assignedToId ?? null,
      ...(reason ? { reason } : {}),
      actorId: principal.userId,
    });
  }

  async reschedule(
    id: string,
    dto: RescheduleFollowUpDto,
    principal: TenantPrincipal,
    idempotencyKey: string | null = null,
  ): Promise<FollowUpView> {
    const existing = await this.requireOwnFollowUp(id, principal);
    const scheduledAt = parseWhen(dto.scheduledAt);

    // One transaction: cancel, replace, link and record. Previously the
    // replacement was created before the cancel, so a lost race left it behind
    // as an orphan and the lead ended up with two open follow-ups.
    const replacement = await this.repository.cancelAndReplace({
      originalId: id,
      // Carried through so the replacement keeps the original parent. The
      // CHECK constraint would reject a row with neither.
      leadId: existing.leadId,
      accountId: existing.accountId,
      assignedUserId: existing.assignedUserId,
      scheduledAt,
      type: (dto.type ?? existing.type) as FollowUpType,
      title: existing.title ?? undefined,
      reason: dto.reason ?? 'Rescheduled',
      actorId: principal.userId,
      idempotencyKey,
    });

    if (!replacement) {
      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        'This follow-up has already been completed or cancelled.',
      );
    }

    // The lead's mirror is re-derived inside cancelAndReplace, in the same
    // commit as the replacement.
    return toView(replacement);
  }

  /**
   * Cancels a follow-up.
   *
   * Refused when it is the last open one on a still-active lead. That would
   * leave the lead with no next action — the exact state the product exists to
   * prevent — and the database CHECK constraint would reject it regardless.
   * Better a clear message than a 500.
   */
  async cancel(
    id: string,
    dto: CancelFollowUpDto,
    principal: TenantPrincipal,
  ): Promise<void> {
    const existing = await this.requireOwnFollowUp(id, principal);

    /*
     * Refusing to strand an open lead. An account follow-up cannot strand
     * anything — there is no enquiry behind it — so the check applies only
     * where a lead is actually at stake.
     */
    if (existing.leadId && existing.lead && !isTerminal(existing.lead.status as LeadStatus)) {
      const open = await this.repository.listForLead(existing.leadId);
      const otherOpen = open.filter(
        (row) => row.id !== id && ['UPCOMING', 'DUE', 'OVERDUE'].includes(row.status),
      );

      if (otherOpen.length === 0) {
        throw AppException.validation(
          'This is the only follow-up on an open lead. Reschedule it, or mark ' +
            'the lead won or lost instead.',
          { followUpId: ['cannot leave an open lead with no next action'] },
        );
      }
    }

    const closed = await this.repository.close({
      id,
      status: 'CANCELLED',
      reason: dto.reason,
      actorId: principal.userId,
    });

    if (closed === 0) {
      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        'This follow-up has already been completed or cancelled.',
      );
    }

    if (existing.leadId) await this.repository.syncLeadNextFollowUp(existing.leadId);
  }

  // ---------------------------------------------------------------------------

  /** Undefined means "see everything in the organization". */
  private restriction(principal: TenantPrincipal): string | undefined {
    if (principal.permissions.includes(PERMISSIONS.FOLLOW_UP_VIEW_TEAM)) return undefined;
    if (principal.permissions.includes(PERMISSIONS.LEAD_VIEW_ALL)) return undefined;
    return principal.userId;
  }

  private async requireVisibleLead(leadId: string, principal: TenantPrincipal) {
    const lead = await this.leads.findById(leadId, visibilityFilter(principal)?.assignedToId);
    // Same 404 as a lead in another tenant — the response must not confirm it
    // exists.
    if (!lead) throw AppException.leadNotFound();
    return lead;
  }

  private async requireOwnFollowUp(id: string, principal: TenantPrincipal) {
    const followUp = await this.repository.findById(id, this.restriction(principal));
    if (!followUp) {
      throw AppException.notFound(ERROR_CODES.FOLLOW_UP_NOT_FOUND, 'Follow-up not found.');
    }
    return followUp;
  }

  /**
   * Resolves who owes the follow-up.
   *
   * Defaults to the lead's assignee, falling back to the caller. An explicit
   * assignee is verified to be an active member — the same check lead
   * assignment does, because `assigned_user_id` also references the GLOBAL
   * users table.
   */
  private async resolveAssignee(
    requested: string | undefined,
    lead: { assignedToId: string | null },
    principal: TenantPrincipal,
  ): Promise<string> {
    if (!requested) return lead.assignedToId ?? principal.userId;

    const isMember = await this.leads.isActiveMember(requested);
    if (!isMember) {
      throw AppException.validation('Cannot assign this follow-up.', {
        assignedUserId: ['must be an active member of your organization'],
      });
    }

    return requested;
  }
}

/**
 * How each attempt type reads in a sentence.
 *
 * Only the types that mean "I tried and did not get through" are here; the
 * DTO's own `@IsIn` is what restricts the input to them.
 */
/**
 * How the older /attempts types map onto structured outcomes. "They asked me
 * to call back" means somebody answered, so it is a reached outcome.
 */
const LEGACY_ATTEMPT_OUTCOMES: Partial<Record<string, CallOutcome>> = {
  CALL_NOT_ANSWERED: 'NOT_ANSWERED',
  CALL_BACK_LATER: 'CONNECTED_CALL_BACK',
};

const ATTEMPT_LABELS: Record<string, string> = {
  CALL_NOT_ANSWERED: 'no answer',
  CALL_BACK_LATER: 'a call-back request',
  WHATSAPP_OPENED: 'a WhatsApp message',
};

/**
 * The timeline entry for one attempt.
 *
 * The rep's own note wins when there is one, because it says more than any
 * label this code could choose. Without a note the label still records what
 * happened, so the entry is never just "activity logged".
 */
function attemptDescription(dto: { activityType: string; note?: string | undefined }): string {
  const label = ATTEMPT_LABELS[dto.activityType] ?? 'attempt';
  const base = `Tried to reach the customer — ${label}`;

  return dto.note ? `${base}: ${dto.note}` : base;
}

/** The timeline entry for one call: what happened, then the rep's own note. */
function outcomeDescription(label: string, dto: RecordOutcomeDto): string {
  const parts = [label];
  if (dto.quantity) parts.push(`quantity: ${dto.quantity}`);
  if (dto.expectedPurchaseDate) parts.push(`expected purchase: ${dto.expectedPurchaseDate}`);
  const base = parts.join(' · ');
  return (dto.note ? `${base} — ${dto.note}` : base).slice(0, 1000);
}

function parseWhen(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw AppException.validation('Invalid date.', { scheduledAt: ['must be a valid date'] });
  }
  return date;
}

type FollowUpRow = {
  id: string;
  /** Exactly one of these two is set. The CHECK constraint guarantees it. */
  leadId: string | null;
  accountId: string | null;
  scheduledAt: Date;
  type: string;
  status: string;
  title: string | null;
  notes: string | null;
  outcome: string | null;
  completedAt: Date | null;
  rescheduledToId: string | null;
  assignedUserId: string;
  lead: {
    leadNumber: string;
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
    mobile: string | null;
    status: string;
    priority: string;
    estimatedValue: { toString(): string } | null;
    lastOutcome: string | null;
    lastOutcomeAt: Date | null;
  } | null;
  account: { id: string; name: string; status: string } | null;
  assignedUser: { id: string; fullName: string };
};

/**
 * One row, for a screen.
 *
 * Every lead-derived field is null on an account follow-up rather than being
 * filled with the account's details. A caller that cannot tell the two apart
 * would show "ABC Foods" in a lead column and link to a lead that does not
 * exist; nulls make the difference impossible to miss.
 */
function toView(row: FollowUpRow): FollowUpView {
  const name = row.lead
    ? [row.lead.firstName, row.lead.lastName].filter(Boolean).join(' ').trim()
    : '';
  const open = ['UPCOMING', 'DUE', 'OVERDUE'].includes(row.status);

  return {
    id: row.id,
    leadId: row.leadId,
    leadNumber: row.lead?.leadNumber ?? null,
    leadName: row.lead ? name || '(no name)' : null,
    accountId: row.accountId,
    accountName: row.account?.name ?? null,
    // The account's own name stands in as the company for an account-level
    // follow-up: it IS the company, so a list can render one column honestly.
    companyName: row.lead ? row.lead.companyName : (row.account?.name ?? null),
    mobile: row.lead?.mobile ?? null,
    leadStatus: row.lead?.status ?? null,
    leadPriority: row.lead?.priority ?? null,
    leadLastOutcome: row.lead?.lastOutcome ?? null,
    leadLastOutcomeAt: row.lead?.lastOutcomeAt?.toISOString() ?? null,
    estimatedValue: row.lead?.estimatedValue?.toString() ?? null,
    scheduledAt: row.scheduledAt.toISOString(),
    type: row.type,
    status: row.status,
    title: row.title,
    notes: row.notes,
    outcome: row.outcome,
    completedAt: row.completedAt?.toISOString() ?? null,
    rescheduledToId: row.rescheduledToId,
    assignedTo: row.assignedUser,
    // Derived rather than read from `status`, because the Phase 6 worker that
    // flips UPCOMING → DUE → OVERDUE does not exist yet. Computing it here
    // means the UI is correct today and stays correct once the worker lands.
    isOverdue: open && row.scheduledAt.getTime() < Date.now(),
  };
}
