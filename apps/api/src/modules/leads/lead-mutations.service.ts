import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES, type LeadStatus, type Paginated } from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import { Inject, forwardRef } from '@nestjs/common';
import { AuditRepository } from '../../common/audit/audit.repository';
import { FollowUpsService } from '../follow-ups/follow-ups.service';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { PhoneParseError, toE164 } from '../../common/utils/phone';
import { normaliseAdditionalPhones } from './additional-phones';
import { LeadsRepository } from './leads.repository';
import { visibilityFilter } from './lead-visibility';
import { canTransition, isTerminal, sideEffectsFor } from './lead-status';
import type {
  AssignLeadDto,
  CreateNoteDto,
  LogActivityDto,
  UpdateLeadDto,
} from './dto/update-lead.dto';

/**
 * Writes against a lead: update, reassign, archive, and timeline entries.
 *
 * Separated from LeadsService, which now handles reads and creation. The two
 * had grown to ~600 lines together with almost no shared logic, and the
 * concerns genuinely differ: reads are about visibility filtering, writes are
 * about transition rules, invariants and audit.
 *
 * Both share the same repository, so tenant scoping is identical either way.
 */
@Injectable()
export class LeadMutationsService {
  constructor(
    private readonly repository: LeadsRepository,
    private readonly audit: AuditRepository,
    /*
     * forwardRef because FollowUpsModule imports LeadsModule back.
     *
     * The dependency is real rather than incidental: a lead's next action IS a
     * follow-up, so moving one has to go through the domain that owns the
     * queue. Writing the mirror column from here instead is exactly the
     * shortcut that produced "Next action: a date" with "0 open".
     */
    @Inject(forwardRef(() => FollowUpsService))
    private readonly followUps: FollowUpsService,
  ) {}

  async update(
    id: string,
    dto: UpdateLeadDto,
    principal: TenantPrincipal,
  ): Promise<{ id: string }> {
    const lead = await this.requireVisible(id, principal);

    const data: Record<string, unknown> = { updatedBy: principal.userId };

    for (const field of [
      'firstName',
      'lastName',
      'designation',
      'email',
      'companyName',
      'city',
      'addressLine1',
      'addressLine2',
      'state',
      'postalCode',
      'source',
      'productInterest',
      'estimatedValue',
      'priority',
    ] as const) {
      if (dto[field] !== undefined) data[field] = dto[field];
    }

    // Extra phones canonicalised like `mobile`; anything that merely repeats the
    // primary mobile or email is dropped, so the list holds only OTHER ways in.
    if (dto.additionalPhones !== undefined) {
      const primary = dto.mobile !== undefined ? await this.normaliseMobile(dto.mobile) : lead.mobile;
      data['additionalPhones'] = normaliseAdditionalPhones(
        dto.additionalPhones,
        primary,
        await this.repository.organizationCountry(),
      );
    }
    if (dto.additionalEmails !== undefined) {
      const primary = dto.email !== undefined ? dto.email : lead.email;
      data['additionalEmails'] = dto.additionalEmails.filter((email) => email !== primary);
    }

    /*
     * The product, checked against THIS tenant's catalogue.
     *
     * The tenant extension scopes queries; the foreign key does not. Without
     * this, a foreign product id would be accepted and another organization's
     * catalogue entry would start accumulating our leads in its KPIs.
     *
     * An explicit null clears it, which is how a mis-mapped lead is corrected.
     */
    if (dto.productId !== undefined) {
      if (dto.productId === null) {
        data['productId'] = null;
      } else {
        if (!(await this.repository.productExists(dto.productId))) {
          throw AppException.validation('That product does not exist.', {
            productId: ['not found'],
          });
        }
        data['productId'] = dto.productId;
      }
    }

    /*
     * The customer this opportunity belongs to.
     *
     * Same gap as the product check above, and worse in consequence. The tenant
     * extension scopes QUERIES; a foreign key assignment is not a query.
     * Without this, Org A could set accountId to one of Org B's customers — the
     * insert would succeed, the foreign key would be satisfied, and Org B's
     * Customer 360 would quietly begin showing Org A's opportunities and
     * revenue.
     *
     * An explicit null detaches it, which is the honest correction when a lead
     * turns out to have been filed under the wrong company.
     */
    if (dto.accountId !== undefined) {
      if (dto.accountId === null) {
        data['accountId'] = null;
      } else {
        if (!(await this.repository.accountExists(dto.accountId))) {
          throw AppException.validation('That customer does not exist.', {
            accountId: ['not found'],
          });
        }
        data['accountId'] = dto.accountId;
      }
    }

    // Re-canonicalised against the TENANT country, exactly as create does, so
    // an edited number stays comparable for duplicate detection.
    if (dto.mobile !== undefined) data['mobile'] = await this.normaliseMobile(dto.mobile);

    const currentStatus = lead.status as LeadStatus;
    const targetStatus = (dto.status ?? currentStatus) as LeadStatus;
    const statusChanging = dto.status !== undefined && dto.status !== currentStatus;

    if (statusChanging) {
      const check = canTransition(currentStatus, targetStatus);
      if (!check.allowed) {
        throw AppException.conflict(
          ERROR_CODES.INVALID_STATUS_TRANSITION,
          check.reason ?? 'That status change is not allowed.',
        );
      }

      if (targetStatus === 'LOST' && !dto.lostReason) {
        // Without it, "why do we lose?" is unanswerable — and that is the most
        // valuable question in the dataset.
        throw AppException.validation('A reason is required when marking a lead lost.', {
          lostReason: ['is required'],
        });
      }

      const effects = sideEffectsFor(targetStatus, {
        lostReason: dto.lostReason,
        wonValue: dto.wonValue,
      });

      data['status'] = targetStatus;
      data['wonAt'] = effects.wonAt;
      data['lostAt'] = effects.lostAt;
      data['lostReason'] = effects.lostReason;
      data['wonValue'] = effects.wonValue ?? null;
    }

    /*
     * The CHECK constraint permits a null next action only for terminal
     * statuses. Catching it here produces a field error rather than a 500.
     *
     * The column IS still written here, and that is deliberate rather than the
     * old shortcut: `leads_active_requires_followup` is checked by the same
     * statement that sets the status, so reopening a lost lead has to carry its
     * new date in that write or the constraint refuses it. Restructuring this
     * to defer the date broke exactly that case.
     *
     * What follows the status change is the RECONCILIATION — see
     * `movesNextAction` below. The queue row is created there and the mirror is
     * recomputed from the rows, so this write is a transient that the next step
     * either confirms or corrects. What it must never be again is the ONLY
     * write, which is what left a date on the lead with nothing in the queue.
     */
    const movesNextAction =
      dto.nextFollowUpAt !== undefined && !isTerminal(targetStatus)
        ? new Date(dto.nextFollowUpAt)
        : null;

    if (dto.nextFollowUpAt !== undefined) {
      data['nextFollowUpAt'] = isTerminal(targetStatus)
        ? null
        : new Date(dto.nextFollowUpAt);
    } else if (isTerminal(targetStatus)) {
      data['nextFollowUpAt'] = null;
    } else if (!lead.nextFollowUpAt) {
      throw AppException.validation('An open lead must have a next follow-up date.', {
        nextFollowUpAt: ['is required unless the lead is won or lost'],
      });
    }

    /*
     * A lead that has just been won or lost is no longer live work, so its open
     * follow-ups are cancelled in the same transaction as the status change.
     *
     * Leaving them open is what put closed deals in the overdue bucket — and a
     * team that learns to ignore "overdue" because half of it is already-won
     * business has lost the only signal the product gives them.
     */
    const closesLead = statusChanging && isTerminal(targetStatus);

    const { leadsChanged } = await this.applyOrExplainDuplicate(id, data, {
      leadId: id,
      data,
      closesLead,
      // Promotes this lead's account to CUSTOMER inside the same transaction.
      // Atomic with the win on purpose: a separate call could fail afterwards,
      // leaving a paying customer recorded as a prospect.
      winsLead: statusChanging && targetStatus === 'WON',
      activityType: statusChanging
        ? targetStatus === 'WON'
          ? 'LEAD_WON'
          : targetStatus === 'LOST'
            ? 'LEAD_LOST'
            : 'STATUS_CHANGED'
        : 'LEAD_UPDATED',
      description: statusChanging
        ? targetStatus === 'LOST' && dto.lostReason
          ? `Marked lost: ${dto.lostReason}`
          : `Status changed to ${targetStatus}`
        : 'Lead details updated',
      actorId: principal.userId,
      cancelReason: closesLead ? `Lead marked ${targetStatus}` : undefined,
    });

    if (leadsChanged === 0) throw AppException.leadNotFound();

    /*
     * The next action is moved AFTER the status change, and through the
     * follow-up domain.
     *
     * After, because closing a lead cancels its open follow-ups in the
     * transaction above — doing this first would schedule a retry that the
     * close then cancelled, leaving a cancelled row and a null mirror where the
     * user expected a date.
     *
     * Through the domain, because `leads.next_follow_up_at` mirrors the
     * earliest open follow-up. Writing it inline moved the date on the lead
     * while the queue kept the old one.
     */
    if (movesNextAction) {
      await this.followUps.setNextForLead(
        id,
        movesNextAction,
        principal,
        'Next action moved on the lead',
      );
    }

    await this.audit.record({
      action: 'lead.updated',
      entityType: 'lead',
      entityId: id,
      before: { status: currentStatus },
      after: { status: targetStatus },
    });

    return { id };
  }

  /** Reassigns ownership. Requires lead.assign, not merely lead.update. */
  async assign(
    id: string,
    dto: AssignLeadDto,
    principal: TenantPrincipal,
  ): Promise<{ id: string }> {
    const lead = await this.requireVisible(id, principal);

    // `leads.assigned_to` references the GLOBAL users table, so without this a
    // foreign organization's user could be set as the owner.
    const isMember = await this.repository.isActiveMember(dto.assignedToId);
    if (!isMember) {
      throw AppException.validation('Cannot assign this lead.', {
        assignedToId: ['must be an active member of your organization'],
      });
    }

    // Owner, owed work and timeline in one commit — see `reassign` for why the
    // follow-ups have to move with the lead.
    const result = await this.repository.reassign({
      leadId: id,
      previousOwnerId: lead.assignedToId,
      newOwnerId: dto.assignedToId,
      actorId: principal.userId,
      activityType: lead.assignedToId ? 'LEAD_REASSIGNED' : 'LEAD_ASSIGNED',
      description: dto.reason ?? 'Lead ownership changed',
    });
    if (result.leadsChanged === 0) throw AppException.leadNotFound();

    await this.audit.record({
      action: 'lead.assigned',
      entityType: 'lead',
      entityId: id,
      before: { assignedToId: lead.assignedToId },
      after: {
        assignedToId: dto.assignedToId,
        followUpsMoved: result.followUpsMoved,
        followUpCreated: result.followUpCreated,
      },
    });

    return { id };
  }

  /**
   * Archives (soft-deletes).
   *
   * Never a hard delete: lead_activities cascade from the lead, so removing the
   * row would erase every call made and quotation sent — the relationship
   * history that makes the CRM worth keeping.
   */
  async archive(id: string, principal: TenantPrincipal): Promise<void> {
    await this.requireVisible(id, principal);

    // Archiving also ends live work, so it cancels open follow-ups in the same
    // transaction. An archived lead that keeps generating reminders is worse
    // than one that was never archived at all.
    const { leadsChanged } = await this.repository.applyLifecycleChange({
      leadId: id,
      data: { deletedAt: new Date(), nextFollowUpAt: null, updatedBy: principal.userId },
      closesLead: true,
      activityType: 'LEAD_UPDATED',
      description: 'Lead archived',
      actorId: principal.userId,
      cancelReason: 'Lead archived',
    });

    if (leadsChanged === 0) throw AppException.leadNotFound();

    await this.audit.record({ action: 'lead.archived', entityType: 'lead', entityId: id });
  }

  async logActivity(
    id: string,
    dto: LogActivityDto,
    principal: TenantPrincipal,
  ): Promise<void> {
    await this.requireVisible(id, principal);

    await this.repository.recordActivity({
      leadId: id,
      activityType: dto.activityType,
      description: dto.description,
      performedById: principal.userId,
    });

    /*
     * Lets "logged a call" and "scheduled the next one" be a single action,
     * which is the whole interaction after a phone call.
     *
     * Goes through the follow-up domain rather than writing
     * `leads.next_follow_up_at` directly. That column is a MIRROR of the
     * earliest open follow-up; writing it here created a lead that promised a
     * next action with no row behind it, so the lead screen showed a date
     * beside "Follow-ups: 0 open" and the work never reached anybody's queue.
     */
    if (dto.nextFollowUpAt) {
      await this.followUps.setNextForLead(
        id,
        new Date(dto.nextFollowUpAt),
        principal,
        'Rescheduled while logging an activity',
      );
    }
  }

  async addNote(id: string, dto: CreateNoteDto, principal: TenantPrincipal): Promise<void> {
    await this.requireVisible(id, principal);

    await this.repository.recordActivity({
      leadId: id,
      activityType: 'NOTE_ADDED',
      description: dto.body,
      performedById: principal.userId,
    });
  }

  /** Paginated timeline. Cursor rather than offset — a timeline only grows. */
  async listActivities(
    id: string,
    principal: TenantPrincipal,
    options: { cursor?: string | undefined; limit?: number | undefined },
  ): Promise<Paginated<unknown>> {
    await this.requireVisible(id, principal);

    const limit = options.limit ?? 25;
    const rows = await this.repository.pageActivities(id, limit, options.cursor);

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((activity) => ({
      id: activity.id,
      type: activity.activityType,
      description: activity.description,
      performedBy: activity.performedBy,
      createdAt: activity.createdAt.toISOString(),
    }));

    return {
      items,
      hasMore,
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * Loads a lead the caller is allowed to act on.
   *
   * Applies the same visibility filter as reads, so a sales rep cannot modify a
   * colleague's lead — and gets the same 404 as for another tenant's, which
   * reveals nothing about whether it exists.
   */
  private async requireVisible(id: string, principal: TenantPrincipal) {
    const lead = await this.repository.findById(id, visibilityFilter(principal)?.assignedToId);
    if (!lead) throw AppException.leadNotFound();
    return lead;
  }

  /**
   * Writes the change; a collision with ANOTHER lead's mobile or email becomes
   * a 409 that names that lead.
   *
   * Before 2026-10-30 an edit that gave a lead an address another live lead
   * already had hit `leads_org_email_uniq` / `leads_org_mobile_uniq` and came
   * back as a 500 carrying Prisma's raw message — server file paths included —
   * instead of the "already exists" that creating the same lead says.
   */
  private async applyOrExplainDuplicate(
    id: string,
    data: Record<string, unknown>,
    change: Parameters<LeadsRepository['applyLifecycleChange']>[0],
  ): Promise<{ leadsChanged: number }> {
    try {
      return await this.repository.applyLifecycleChange(change);
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error;

      const mobile = typeof data['mobile'] === 'string' ? data['mobile'] : null;
      const email = typeof data['email'] === 'string' ? data['email'] : null;
      const byMobile = mobile ? await this.repository.findActiveByMobile(mobile) : null;
      const byEmail = !byMobile && email ? await this.repository.findActiveByEmail(email) : null;
      const existing = [byMobile, byEmail].find((lead) => lead && lead.id !== id) ?? null;
      if (!existing) throw error;

      throw new AppException(
        ERROR_CODES.DUPLICATE_LEAD,
        `Another lead already has this ${byMobile ? 'mobile number' : 'email address'} (${existing.leadNumber}). ` +
          'Put it under Additional phones / emails instead, or update that lead.',
        HttpStatus.CONFLICT,
        {
          [byMobile ? 'mobile' : 'email']: [`already used by ${existing.leadNumber}`],
          existingLeadId: [existing.id],
          existingLeadNumber: [existing.leadNumber],
        },
      );
    }
  }

  private async normaliseMobile(input: string): Promise<string> {
    const country = await this.repository.organizationCountry();

    try {
      return toE164(input, country);
    } catch (error) {
      if (error instanceof PhoneParseError) {
        throw AppException.validation('Invalid phone number.', { mobile: [error.message] });
      }
      throw error;
    }
  }
}
