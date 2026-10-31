import { HttpStatus, Inject, Injectable, forwardRef } from '@nestjs/common';
import {
  ERROR_CODES,
  EXISTING_LEAD_REFINEMENT,
  QUALIFICATION_NOTE_OUTCOMES,
  REFINEMENT_OUTCOMES,
  type LeadQualification,
} from '@leadflow/api-types';
import { AppException } from '../../../common/errors/app.exception';
import { AuditRepository } from '../../../common/audit/audit.repository';
import type { TenantPrincipal } from '../../../common/tenancy/tenant-context.service';
import { FollowUpsRepository } from '../../follow-ups/follow-ups.repository';
import { LeadsRepository } from '../leads.repository';
import { visibilityFilter } from '../lead-visibility';
import { LeadContactsRepository } from '../contacts/lead-contacts.repository';
import { LeadContactsService } from '../contacts/lead-contacts.service';
import type {
  QualificationNoteDto,
  RefineLeadDto,
  RevertToRoughDto,
} from './lead-qualification.dto';
import {
  LeadQualificationRepository,
  type QualificationRow,
} from './lead-qualification.repository';

export interface QualificationChecklist {
  /** A company name, or a linked customer account. */
  company: boolean;
  /** At least one active point of contact with a phone, WhatsApp or email. */
  contact: boolean;
}

export interface QualificationView {
  leadId: string;
  qualification: LeadQualification;
  checklist: QualificationChecklist;
  /** Null for a Rough lead, and for leads that predate qualification. */
  refinedAt: string | null;
  refinedBy: { id: string; fullName: string } | null;
  /** A REFINEMENT_OUTCOMES code, or EXISTING_LEAD. */
  refinementOutcome: string | null;
  refinementNote: string | null;
}

/**
 * Rough -> Refined, and back.
 *
 *  * Qualification notes record research and qualification calls on a Rough
 *    lead without scheduling sales work.
 *  * Refining needs a company, a reachable contact and a confirmed business
 *    fit; it records who, when and why, and -- for an assigned lead with no
 *    open follow-up -- creates its first sales follow-up so it enters a queue.
 *  * Reverting needs a reason. Follow-ups are kept as they are; while the lead
 *    is Rough they are simply out of the queues and counts.
 *  * Nothing promotes a lead automatically: only an explicit refine does.
 */
@Injectable()
export class LeadQualificationService {
  constructor(
    private readonly repository: LeadQualificationRepository,
    private readonly leads: LeadsRepository,
    private readonly contactsRepo: LeadContactsRepository,
    private readonly contacts: LeadContactsService,
    @Inject(forwardRef(() => FollowUpsRepository))
    private readonly followUps: FollowUpsRepository,
    private readonly audit: AuditRepository,
  ) {}

  async view(leadId: string, principal: TenantPrincipal): Promise<QualificationView> {
    const lead = await this.requireVisible(leadId, principal);
    return this.toView(lead, await this.checklist(lead));
  }

  async addNote(
    leadId: string,
    dto: QualificationNoteDto,
    principal: TenantPrincipal,
  ): Promise<QualificationView> {
    await this.requireVisible(leadId, principal);
    const contact = await this.contacts.resolveContactRef(leadId, dto.contactId, {
      allowInactive: true,
    });
    const nextAt = dto.nextQualificationAt ? new Date(dto.nextQualificationAt) : null;
    if (nextAt && nextAt.getTime() <= Date.now()) {
      throw AppException.validation('The next qualification date must be in the future.', {
        nextQualificationAt: ['choose a time after now'],
      });
    }

    await this.followUps.inLeadTransaction(leadId, async (tx, locked) => {
      if (!locked) throw AppException.leadNotFound();
      const lead = await this.repository.find(leadId, tx);
      if (!lead) throw AppException.leadNotFound();
      if (lead.qualification !== 'ROUGH') {
        throw AppException.conflict(
          ERROR_CODES.CONFLICT,
          'This lead is already Refined. Log calls with "Log outcome" instead.',
        );
      }
      if (nextAt) await this.repository.setQualifyBy(tx, leadId, nextAt, principal.userId);

      const label =
        QUALIFICATION_NOTE_OUTCOMES[dto.outcome as keyof typeof QUALIFICATION_NOTE_OUTCOMES];
      const who = contact ? ` — with ${contact.name}` : '';
      await this.followUps.recordLeadActivity(tx, {
        leadId,
        activityType: 'NOTE_ADDED',
        description: `Qualification: ${label}${who}${dto.note ? ` — ${dto.note}` : ''}`.slice(
          0,
          1000,
        ),
        actorId: principal.userId,
        result: {
          qualificationOutcome: dto.outcome,
          ...(contact ? { contactId: contact.id, contactName: contact.name } : {}),
          ...(nextAt ? { nextQualificationAt: nextAt.toISOString() } : {}),
        },
      });
    });

    return this.view(leadId, principal);
  }

  async refine(
    leadId: string,
    dto: RefineLeadDto,
    principal: TenantPrincipal,
  ): Promise<QualificationView> {
    const visible = await this.requireVisible(leadId, principal);
    // Legacy leads get their contact link before the checklist reads it.
    const legacy = await this.leads.findById(leadId);
    if (legacy?.contactId) await this.contactsRepo.ensureLegacyLink(leadId, legacy.contactId);
    if (visible.qualification === 'REFINED') throw alreadyRefined();

    if (dto.outcome === 'OTHER' && !dto.note) {
      throw AppException.validation('Say why in the note when the outcome is "Other".', {
        note: ['is required'],
      });
    }

    let followUpCreated = false;
    await this.followUps.inLeadTransaction(leadId, async (tx, locked) => {
      if (!locked) throw AppException.leadNotFound();
      const lead = await this.repository.find(leadId, tx);
      if (!lead) throw AppException.leadNotFound();
      if (lead.qualification === 'REFINED') throw alreadyRefined();
      if (lead.deactivatedAt) {
        throw AppException.validation('Reactivate this lead before refining it.', {
          lead: ['is inactive'],
        });
      }
      if (lead.status === 'WON' || lead.status === 'LOST') {
        throw AppException.validation('Reopen this lead before refining it.', {
          lead: ['is closed'],
        });
      }

      // What must be verified. All missing items are reported at once.
      const checklist = await this.checklist(lead, tx);
      const missing: Record<string, string[]> = {};
      if (!checklist.company) missing['company'] = ['add the company name or link the customer'];
      if (!checklist.contact) missing['contact'] = ['add a contact with a phone number or email'];
      if (dto.businessFitConfirmed !== true)
        missing['businessFitConfirmed'] = ['confirm the business fit'];
      if (Object.keys(missing).length > 0) {
        throw new AppException(
          ERROR_CODES.QUALIFICATION_INCOMPLETE,
          'This lead cannot be refined yet: ' + Object.values(missing).flat().join('; ') + '.',
          HttpStatus.BAD_REQUEST,
          missing,
        );
      }

      await this.repository.markRefined(tx, leadId, {
        outcome: dto.outcome,
        note: dto.note ?? null,
        actorId: principal.userId,
      });

      // Into the sales workflow: an owner with nothing queued gets the first
      // sales follow-up, at the qualify-by date if it is still ahead.
      if (lead.assignedToId && (await this.repository.openFollowUps(tx, leadId)) === 0) {
        const soon = new Date(Date.now() + 60 * 60 * 1000);
        const scheduledAt =
          lead.nextFollowUpAt && lead.nextFollowUpAt > soon ? lead.nextFollowUpAt : soon;
        await this.followUps.create({
          leadId,
          assignedUserId: lead.assignedToId,
          scheduledAt,
          type: 'CALL',
          title: 'First sales contact',
          actorId: principal.userId,
          tx,
        });
        await this.followUps.syncLeadNextFollowUp(leadId, tx);
        followUpCreated = true;
      }

      const label = REFINEMENT_OUTCOMES[dto.outcome as keyof typeof REFINEMENT_OUTCOMES];
      await this.followUps.recordLeadActivity(tx, {
        leadId,
        activityType: 'LEAD_UPDATED',
        description: `Marked as Refined — ${label}${dto.note ? `: ${dto.note}` : ''}`.slice(
          0,
          1000,
        ),
        actorId: principal.userId,
        result: { qualification: 'REFINED', refinementOutcome: dto.outcome },
      });
    });

    await this.audit.record({
      action: 'lead.refined',
      entityType: 'lead',
      entityId: leadId,
      before: { qualification: 'ROUGH' },
      after: { qualification: 'REFINED', outcome: dto.outcome, followUpCreated },
    });
    return this.view(leadId, principal);
  }

  async revert(
    leadId: string,
    dto: RevertToRoughDto,
    principal: TenantPrincipal,
  ): Promise<QualificationView> {
    await this.requireVisible(leadId, principal);
    let previous: string | null = null;

    await this.followUps.inLeadTransaction(leadId, async (tx, locked) => {
      if (!locked) throw AppException.leadNotFound();
      const lead = await this.repository.find(leadId, tx);
      if (!lead) throw AppException.leadNotFound();
      if (lead.qualification === 'ROUGH') {
        throw AppException.conflict(ERROR_CODES.CONFLICT, 'This lead is already Rough.');
      }
      previous = lead.refinementOutcome;
      // Follow-ups are deliberately left alone: kept, just out of the queues
      // while the lead is Rough, and back in them if it is refined again.
      await this.repository.markRough(tx, leadId, principal.userId);
      await this.followUps.recordLeadActivity(tx, {
        leadId,
        activityType: 'LEAD_UPDATED',
        description: `Reverted to Rough: ${dto.reason}`.slice(0, 1000),
        actorId: principal.userId,
        result: { qualification: 'ROUGH', reason: dto.reason, previousOutcome: previous },
      });
    });

    await this.audit.record({
      action: 'lead.reverted_to_rough',
      entityType: 'lead',
      entityId: leadId,
      before: { qualification: 'REFINED', outcome: previous },
      after: { qualification: 'ROUGH', reason: dto.reason },
    });
    return this.view(leadId, principal);
  }

  // ---------------------------------------------------------------------------

  private async checklist(
    lead: Pick<QualificationRow, 'id' | 'companyName' | 'accountId'>,
    tx?: Parameters<LeadQualificationRepository['hasReachableContact']>[1],
  ): Promise<QualificationChecklist> {
    return {
      company: Boolean(lead.companyName?.trim()) || lead.accountId !== null,
      contact: await this.repository.hasReachableContact(lead.id, tx),
    };
  }

  private async toView(
    lead: QualificationRow,
    checklist: QualificationChecklist,
  ): Promise<QualificationView> {
    return {
      leadId: lead.id,
      qualification: lead.qualification,
      checklist,
      refinedAt: lead.refinedAt?.toISOString() ?? null,
      refinedBy: await this.repository.userName(lead.refinedBy),
      refinementOutcome: lead.refinementOutcome,
      refinementNote: lead.refinementNote,
    };
  }

  /** Same visibility as the lead itself: a 404, like another tenant's lead. */
  private async requireVisible(
    leadId: string,
    principal: TenantPrincipal,
  ): Promise<QualificationRow> {
    const visible = await this.leads.findById(leadId, visibilityFilter(principal)?.assignedToId);
    if (!visible) throw AppException.leadNotFound();
    if (visible.contactId) await this.contactsRepo.ensureLegacyLink(leadId, visible.contactId);
    const lead = await this.repository.find(leadId);
    if (!lead) throw AppException.leadNotFound();
    return lead;
  }
}

function alreadyRefined(): AppException {
  return AppException.conflict(ERROR_CODES.CONFLICT, 'This lead is already Refined.');
}

export { EXISTING_LEAD_REFINEMENT };
