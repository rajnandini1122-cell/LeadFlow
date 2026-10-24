import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { ERROR_CODES } from '@leadflow/api-types';
import { AuditRepository } from '../../common/audit/audit.repository';
import { AppException } from '../../common/errors/app.exception';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { LeadsRepository } from './leads.repository';
import { FollowUpsRepository } from '../follow-ups/follow-ups.repository';
import type { DeactivateLeadDto, ReactivateLeadDto } from './dto/lead-lifecycle.dto';

/**
 * Taking a lead out of service, and putting it back.
 *
 * THE DEFECT THIS FIXES. A wrongly imported lead could not be removed from the
 * pipeline in a way that said why. The only tool was `archive` — `deletedAt` —
 * which records no reason, no dedicated actor, and has NO reverse operation, so
 * a mistaken archive was permanent. In practice people left bad rows in the
 * pipeline, where they distorted every forecast, or marked them LOST, which
 * poisons loss analysis with data about nobody's selling.
 *
 * THREE STATES, KEPT SEPARATE ON PURPOSE. The brief for this work said not to
 * conflate them and it is right:
 *
 *   status = LOST   A real opportunity, pursued and not won. Business history.
 *   deletedAt       Archived. No reason, no reversal. Unchanged by this work.
 *   deactivatedAt   This record should not be live work. Reversible, reasoned
 *                   and attributed.
 *
 * WHAT IS NEVER DONE HERE: nothing is physically deleted. The lead row, its
 * activities, its contact, its account link, its originating enquiry and its
 * import batch all stay exactly as they are. Deactivation sets three columns
 * and cancels open reminders; that is the whole of it.
 */
@Injectable()
export class LeadLifecycleService {
  constructor(
    private readonly repository: LeadsRepository,
    private readonly audit: AuditRepository,
    /*
     * forwardRef for the same reason as LeadMutationsService: leads and
     * follow-ups reference each other. Reactivation needs the follow-up
     * repository so the next action becomes a queue row in the same commit.
     */
    @Inject(forwardRef(() => FollowUpsRepository))
    private readonly followUps: FollowUpsRepository,
  ) {}

  /**
   * Takes a lead out of the live pipeline.
   *
   * Idempotent: deactivating an already-deactivated lead succeeds without
   * rewriting the original reason or actor. Two people clicking the same button
   * should not produce an error, and the FIRST reason is the one that explains
   * why the record is out of service.
   */
  async deactivate(id: string, dto: DeactivateLeadDto, principal: TenantPrincipal): Promise<void> {
    const lead = await this.requireVisible(id);

    if (lead.deactivatedAt) return;

    /*
     * Open reminders are cancelled in the SAME transaction.
     *
     * A deactivated lead that keeps paging a salesperson every morning is worse
     * than one nobody deactivated: they learn to dismiss the reminder, and then
     * they dismiss the real ones too. `applyLifecycleChange` is the one place
     * that does this, so deactivation gets exactly the same treatment as
     * archival and closure rather than a second implementation that drifts.
     */
    const { leadsChanged } = await this.repository.applyLifecycleChange({
      leadId: id,
      data: {
        deactivatedAt: new Date(),
        deactivationReason: dto.reason,
        deactivatedBy: principal.userId,
        /*
         * Cleared, which the database now permits.
         *
         * `leads_active_requires_followup` was widened in 20261013090000 to
         * exempt deactivated rows. Leaving the date set would keep the lead in
         * every "due today" count, which is the opposite of taking it out of
         * service.
         */
        nextFollowUpAt: null,
        updatedBy: principal.userId,
      },
      closesLead: true,
      activityType: 'LEAD_UPDATED',
      // The reason goes on the TIMELINE as well as the column, because the
      // timeline is what a person reads when they open the lead and ask what
      // happened to it.
      description: `Lead deactivated: ${dto.reason}`,
      actorId: principal.userId,
      cancelReason: 'Lead deactivated',
    });

    if (leadsChanged === 0) throw AppException.leadNotFound();

    await this.audit.record({
      action: 'lead.deactivated',
      entityType: 'lead',
      entityId: id,
      before: { status: lead.status, deactivatedAt: null },
      after: { reason: dto.reason, deactivatedBy: principal.userId },
    });
  }

  /**
   * Puts a lead back into the live pipeline.
   *
   * THIS CAN FAIL, and the reason is structural rather than incidental.
   * Deactivation RELEASES the lead's mobile and email from both partial unique
   * indexes — that is the point, so the corrected record can be created with
   * the same number. Which means that between deactivating and reactivating,
   * some other active lead may have taken the identifier.
   *
   * So both keys are re-checked here and a conflict is reported as a 409 naming
   * the lead that holds it. The alternative is letting the UPDATE fail on the
   * index with a raw constraint error, which tells the user nothing about which
   * record is in the way or what to do about it.
   */
  async reactivate(id: string, dto: ReactivateLeadDto, principal: TenantPrincipal): Promise<void> {
    const lead = await this.requireVisible(id);

    if (!lead.deactivatedAt) {
      throw AppException.validation('This lead is already active.', {
        status: ['only a deactivated lead can be reactivated'],
      });
    }

    await this.assertIdentifiersFree(lead);

    /*
     * A next action is required to come back.
     *
     * Reactivating into an ACTIVE status with no follow-up would violate
     * `leads_active_requires_followup` — the guarantee that no live lead is
     * ever left with nothing to do. Rather than inventing a date, the caller
     * supplies one: somebody putting a lead back into the pipeline knows when
     * they intend to act on it, and a server-chosen date would be a reminder
     * nobody agreed to.
     *
     * WON and LOST are exempt by the same constraint, so a lead deactivated
     * while closed comes back closed and needs none.
     */
    const isClosed = lead.status === 'WON' || lead.status === 'LOST';

    if (!isClosed && !dto.nextFollowUpAt) {
      throw AppException.validation('This lead needs a next follow-up date to come back.', {
        nextFollowUpAt: ['required when reactivating a lead that is not WON or LOST'],
      });
    }

    /*
     * THE DEFECT THIS FIXES (release audit). Reactivation wrote the date onto
     * the lead and nothing else. Deactivation had cancelled every open
     * follow-up, so a reactivated lead carried "next action: <date>" with no
     * follow-up row — in nobody's queue, the exact way a lead disappears.
     *
     * Now one transaction under the lead's row lock: the lead comes back AND
     * its next action is queued for its owner (the mirror alone for an
     * unassigned lead, which no queue can hold).
     */
    const { leadsChanged } = await this.followUps.inLeadTransaction(id, async (tx, locked) => {
      const changed = await this.repository.applyLifecycleChange({
      tx,
      leadId: id,
      data: {
        deactivatedAt: null,
        // The reason and the actor are CLEARED along with the timestamp.
        //
        // They describe a state the lead is no longer in, and a stale "why this
        // was deactivated" on a live lead reads as current. The audit trail and
        // the activity timeline keep the history; these three columns describe
        // only the present.
        deactivationReason: null,
        deactivatedBy: null,
        ...(isClosed ? {} : { nextFollowUpAt: new Date(dto.nextFollowUpAt as string) }),
        updatedBy: principal.userId,
      },
      // False: reactivation opens work rather than closing it, so it must not
      // cancel follow-ups.
      closesLead: false,
      activityType: 'LEAD_UPDATED',
      description: dto.reason ? `Lead reactivated: ${dto.reason}` : 'Lead reactivated',
      actorId: principal.userId,
    });

      if (changed.leadsChanged > 0 && !isClosed) {
        await this.followUps.setNextForLead({
          leadId: id,
          scheduledAt: new Date(dto.nextFollowUpAt as string),
          // The owner as read under the lock, not before it.
          assignedUserId: locked?.assignedToId ?? null,
          title: 'Next action',
          reason: 'Lead reactivated',
          actorId: principal.userId,
          tx,
        });
      }

      return changed;
    });

    if (leadsChanged === 0) throw AppException.leadNotFound();

    await this.audit.record({
      action: 'lead.reactivated',
      entityType: 'lead',
      entityId: id,
      before: {
        deactivatedAt: lead.deactivatedAt.toISOString(),
        deactivationReason: lead.deactivationReason,
      },
      after: { reason: dto.reason ?? null, reactivatedBy: principal.userId },
    });
  }

  /**
   * Whether this lead's mobile and email are still free to take back.
   *
   * Both are asked, and both report the lead that holds the identifier, so the
   * user can go and deal with THAT record. Mobile first, because it is the
   * stronger identity and the more useful thing to be told.
   */
  private async assertIdentifiersFree(lead: {
    id: string;
    mobile: string | null;
    email: string | null;
  }): Promise<void> {
    if (lead.mobile) {
      const holder = await this.repository.findActiveByMobile(lead.mobile);
      if (holder && holder.id !== lead.id) {
        throw AppException.conflict(
          ERROR_CODES.DUPLICATE_LEAD,
          `Lead ${holder.leadNumber} is now using this mobile number. ` +
            'Deal with that lead first, or clear the number on this one.',
        );
      }
    }

    if (lead.email) {
      const holder = await this.repository.findActiveByEmail(lead.email);
      if (holder && holder.id !== lead.id) {
        throw AppException.conflict(
          ERROR_CODES.DUPLICATE_LEAD,
          `Lead ${holder.leadNumber} is now using this email address. ` +
            'Deal with that lead first, or clear the address on this one.',
        );
      }
    }
  }

  /**
   * The lead, or a 404.
   *
   * Deliberately NOT filtered by assignee visibility. Deactivation and
   * reactivation are guarded by `lead.deactivate`, a permission held by
   * administrators — and the records that need deactivating are precisely the
   * badly imported ones, which may be assigned to somebody else or to nobody at
   * all. A visibility filter here would make the feature unable to reach the
   * rows it exists for.
   *
   * Tenant isolation is unaffected: the repository read runs inside the tenant
   * context, so another organization's lead is simply not found.
   */
  private async requireVisible(id: string) {
    const lead = await this.repository.findLifecycleState(id);
    if (!lead) throw AppException.leadNotFound();

    return lead;
  }
}
