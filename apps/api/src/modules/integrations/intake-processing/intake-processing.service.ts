import { Injectable, Logger } from '@nestjs/common';
import { AuditRepository } from '../../../common/audit/audit.repository';
import { splitPersonName } from '../../../common/utils/person-name';
import { parsePhone } from '../../../common/utils/phone';
import type { PrismaTransaction } from '../../../common/prisma/transaction';
import { ContactsRepository } from '../../contacts/contacts.repository';
import { LeadsRepository } from '../../leads/leads.repository';
import { FollowUpsRepository } from '../../follow-ups/follow-ups.repository';
import { TeamsService } from '../../teams/teams.service';
import { TerritoriesService } from '../../territories/territories.service';
import { AssignmentRulesService } from '../../assignment-rules/assignment-rules.service';
import { IntakeProcessingRepository } from './intake-processing.repository';

/** Audit actions this module writes. `noun.verb`, like every other module. */
export const INTAKE_AUDIT = {
  PROCESSED: 'integration.intake.processed',
  BLOCKED: 'integration.intake.blocked',
  DUPLICATE_DETECTED: 'integration.intake.duplicate_detected',
  AUTO_ASSIGNED: 'lead.auto_assigned',
} as const;

/**
 * Why an intake did not become a lead.
 *
 * Short machine-readable codes, stored alongside a sentence. The code is what a
 * filter and a metric use; the sentence is what an operator reads.
 */
export const BLOCK_CODE = {
  NO_MATCH: 'NO_MATCH',
  NO_ELIGIBLE_AGENTS: 'NO_ELIGIBLE_AGENTS',
  DUPLICATE_LEAD: 'DUPLICATE_LEAD',
  NO_NAME: 'NO_NAME',
} as const;

/*
 * There is deliberately no DUPLICATE_CONTACT.
 *
 * A matching CONTACT is not a reason to refuse: the same customer legitimately
 * comes back with a new enquiry after an old one closed, and a returning
 * customer is one person with two enquiries rather than a duplicate. The
 * contact is reused, which is what keeps their history together.
 *
 * A matching active LEAD is different, and is refused — that is a second live
 * conversation about the same thing, which is what the duplicate rule exists
 * to prevent.
 */

export type ProcessOutcome =
  | { result: 'CONVERTED'; leadId: string; teamId: string; userId: string }
  | { result: 'ALREADY_PROCESSED'; leadId: string | null }
  | { result: 'SKIPPED'; reason: string }
  | { result: 'BLOCKED'; code: string }
  | { result: 'DUPLICATE'; code: string };

/**
 * A website enquiry becomes CRM work.
 *
 * The whole pipeline, and all of it inside ONE transaction:
 *
 *   lock the intake -> re-check for duplicates -> resolve the territory
 *   -> evaluate the routing rules -> lock the team's rotation
 *   -> pick the next eligible agent -> create or reuse the contact
 *   -> create the lead and its activities -> create the first follow-up
 *   -> point the lead at it -> mark the intake PROCESSED -> advance the rotation
 *
 * The transaction boundary is the design, not an implementation detail. Every
 * one of those steps is part of what "converted" means, and any subset of them
 * is a broken state somebody would have to find and repair by hand: a lead with
 * no follow-up is the promise this product makes, broken; an advanced rotation
 * with no lead silently skips a salesperson's turn; a PROCESSED intake with no
 * lead loses a customer with no trace that anything went wrong.
 *
 * Three things it deliberately does NOT do:
 *
 *   it never overrides a duplicate. J1 flags a likely duplicate for a person to
 *   decide, and an automated process setting allowDuplicate would be the
 *   machine overruling that decision on its own authority;
 *
 *   it never invents a routing fact. The website supplies a country, so the
 *   country is what territory resolution gets. It does not guess a state from a
 *   phone number, or a product from free text;
 *
 *   it never picks somebody outside the eligible set. Round robin chooses among
 *   the people J3 says can take work right now, read inside this transaction.
 *   There is no fallback to a manager when the team is empty — an unstaffed
 *   team is a configuration problem, and routing round it would hide it.
 */
@Injectable()
export class IntakeProcessingService {
  private readonly logger = new Logger(IntakeProcessingService.name);

  constructor(
    private readonly repository: IntakeProcessingRepository,
    private readonly territories: TerritoriesService,
    private readonly rules: AssignmentRulesService,
    private readonly teams: TeamsService,
    private readonly contacts: ContactsRepository,
    private readonly leads: LeadsRepository,
    private readonly followUps: FollowUpsRepository,
    private readonly audit: AuditRepository,
  ) {}

  /**
   * Converts one intake, or explains why it could not be.
   *
   * Idempotent: the second call finds the row already PROCESSED and reports the
   * lead the first call made. Safe to call from the sweep, from a retry, and
   * from a BullMQ redelivery of a job whose acknowledgement was lost.
   *
   * Must already be inside the intake's tenant context.
   */
  async process(intakeId: string): Promise<ProcessOutcome> {
    const outcome = await this.repository.transaction(async (tx) => this.convert(tx, intakeId));

    // Audit OUTSIDE the conversion transaction, deliberately. An audit write
    // that failed would otherwise roll back a perfectly good conversion, and
    // the record of what happened matters less than the thing that happened.
    await this.recordAudit(intakeId, outcome);

    return outcome;
  }

  // ---------------------------------------------------------------------------

  private async convert(tx: PrismaTransaction, intakeId: string): Promise<ProcessOutcome> {
    /*
     * The lock comes first, and it carries the status predicate.
     *
     * A second worker — or a retry of a job whose acknowledgement was lost —
     * finds no row to claim and stops here. That is what makes process() twice
     * produce one lead: not a check, but the absence of anything to claim.
     */
    const claimed = await this.repository.claim(tx, intakeId);

    if (!claimed) {
      const existing = await this.repository.load(tx, intakeId);

      if (existing?.status === 'PROCESSED') {
        return { result: 'ALREADY_PROCESSED', leadId: existing.createdLeadId };
      }

      // Missing, another tenant's, held by another worker, or in a status this
      // pipeline does not touch. All of them mean "not mine to convert".
      return { result: 'SKIPPED', reason: existing ? `status ${existing.status}` : 'not found' };
    }

    const intake = await this.repository.load(tx, intakeId);
    if (!intake) return { result: 'SKIPPED', reason: 'not found' };

    const policy = await this.repository.tenantPolicy(tx);

    /*
     * A lead needs a name, and the website form cannot be trusted to have
     * provided one. Blocked rather than invented: "Unknown" in front of a
     * salesperson reads as a customer who typed it.
     */
    const person = splitPersonName(intake.name);
    if (!person) {
      return this.block(tx, intakeId, {
        code: BLOCK_CODE.NO_NAME,
        reason: 'The enquiry carries no name, so no contact could be created from it.',
      });
    }

    const mobile = canonicalMobile(intake.phone, intake.country ?? policy.country);
    const email = intake.email ?? undefined;

    /*
     * --- the processing-time duplicate re-check ----------------------------
     *
     * J1 asked this when the enquiry arrived. Time has passed: somebody may
     * have created this customer by hand, or a different enquiry from the same
     * person may have been converted a second ago. Asking again inside the lock
     * is what closes that window, and doing it here rather than trusting the
     * stored flag is what makes two concurrent intakes for one mobile produce
     * one lead.
     */
    if (mobile) {
      const existingLead = await this.repository.activeLeadByMobile(tx, mobile);

      if (existingLead) {
        return this.duplicate(tx, intakeId, {
          code: BLOCK_CODE.DUPLICATE_LEAD,
          reason: `An active lead (${existingLead.leadNumber}) already exists for this number.`,
          matchedLeadId: existingLead.id,
        });
      }
    }

    // --- routing, all inside the transaction that will act on it -------------
    // Resolved INSIDE the transaction: the map an enquiry is routed by should
    // be the map as it stands when the assignment is written, and a read that
    // reached for its own connection would deadlock against this one.
    const territory = await this.territories.resolve({ country: intake.country }, tx);

    const decision = await this.rules.evaluate(
      {
        source: intake.source,
        /*
         * No product, and that is a decision.
         *
         * The website stores what the customer typed. Turning "onion powder,
         * 500kg" into a catalogue id means guessing, and a wrong guess routes
         * a customer to the wrong team and files the revenue under the wrong
         * product. It stays free text on the lead, where a person can map it.
         */
        productId: undefined,
        territoryId: territory.territory?.id ?? null,
      },
      territory.territory,
      tx,
    );

    const routing = {
      resolvedTerritoryId: territory.territory?.id ?? null,
      matchedAssignmentRuleId: decision.rule?.id ?? null,
      assignedTeamId: decision.team?.id ?? null,
    };

    if (decision.decision === 'NO_MATCH') {
      return this.block(tx, intakeId, {
        code: BLOCK_CODE.NO_MATCH,
        reason: 'No assignment rule matches this enquiry, and there is no fallback rule.',
        ...routing,
      });
    }

    if (decision.decision === 'NO_ELIGIBLE_AGENTS' || !decision.team) {
      return this.block(tx, intakeId, {
        code: BLOCK_CODE.NO_ELIGIBLE_AGENTS,
        reason: decision.team
          ? `Nobody in ${decision.team.name} can receive assigned work right now.`
          : 'The matching rule has no usable target team.',
        ...routing,
      });
    }

    // --- round robin ---------------------------------------------------------
    const teamId = decision.team.id;
    const sequence = await this.repository.lockCursor(tx, teamId);

    /*
     * Read AFTER the cursor lock, not before.
     *
     * The lock is what makes this list stable for the rest of the transaction,
     * so the candidates chosen from are the candidates that exist at assignment
     * time. The preview's list — computed before the lock, during evaluation —
     * is a report, and routing on it would mean assigning to somebody who was
     * suspended in between.
     */
    const candidates = await this.teams.eligibleAgentsInRotationOrder(teamId, tx);

    if (candidates.length === 0) {
      // Between evaluation and the lock, the last eligible person left or was
      // switched off. Blocked rather than assigned to a stale candidate.
      return this.block(tx, intakeId, {
        code: BLOCK_CODE.NO_ELIGIBLE_AGENTS,
        reason: `Nobody in ${decision.team.name} can receive assigned work right now.`,
        ...routing,
      });
    }

    /*
     * The rotation, in one line.
     *
     * `sequence` counts assignments this team has made and only ever climbs;
     * the modulo maps it onto whoever is eligible NOW. That is what lets the
     * candidate list change with no cursor migration — and it is why exact
     * lifetime equal counts are not promised across membership changes, only
     * fair deterministic rotation among the people currently eligible.
     */
    const index = Number(sequence % BigInt(candidates.length));
    const chosen = candidates[index];

    if (!chosen) {
      // Unreachable: index is a remainder over a non-empty array. Guarded
      // because assigning `undefined` would be worse than throwing.
      throw new Error(`Round-robin index ${index} outside ${candidates.length} candidates`);
    }

    // --- the conversion ------------------------------------------------------

    /*
     * A live contact for this person is a duplicate signal too, but a weaker
     * one than a lead: the same customer legitimately comes back with a new
     * enquiry after an old one closed. So a matching contact is REUSED rather
     * than refused — a returning customer is one person with two enquiries.
     */
    const contact = await this.contacts.findOrCreateByMobile({
      mobile,
      firstName: person.firstName,
      lastName: person.lastName,
      email,
      companyName: intake.company ?? undefined,
      // No actor. `created_by` is nullable with no foreign key, so null says
      // honestly that nobody typed this in.
      actorId: null,
      tx,
    });

    // Serialised per tenant for the length of this transaction, so read-then-
    // write numbering cannot raise a unique violation that would abort the
    // whole conversion. See LeadsRepository.lockLeadNumbering.
    await this.leads.lockLeadNumbering(tx);
    const leadNumber = await this.leads.nextLeadNumber(tx);

    const scheduledAt = new Date(intake.receivedAt.getTime() + policy.slaMinutes * 60_000);

    const leadId = await this.leads.createWithActivity({
      leadNumber,
      firstName: person.firstName,
      lastName: person.lastName,
      mobile,
      email,
      companyName: intake.company ?? undefined,
      source: intake.source,
      /*
       * What the customer actually asked for, kept as they wrote it. NOT
       * resolved to a catalogue product — see the evaluation above.
       */
      productInterest: intake.productInterest ?? undefined,
      status: 'NEW',
      priority: 'MEDIUM',
      assignedToId: chosen.userId,
      nextFollowUpAt: scheduledAt,
      contactId: contact.id,
      // Never. A duplicate website enquiry is not authorisation to create a
      // second lead; that decision belongs to a person.
      duplicateAcknowledged: false,
      actorId: null,
      tx,
    });

    await this.followUps.create({
      leadId,
      assignedUserId: chosen.userId,
      /*
       * Measured from when the enquiry ARRIVED, never from when the worker got
       * to it. A sweep that ran late should produce a follow-up that is
       * honestly already due, not one whose clock was quietly restarted —
       * hiding the delay would hide exactly the thing an operator needs to see.
       */
      scheduledAt,
      type: 'CALL',
      title: 'First response to website enquiry',
      actorId: null,
      tx,
    });

    // Belt and braces: createWithActivity already wrote this, and writing it
    // again from the same value is what guarantees the two agree rather than
    // relying on two call sites staying in step.
    await this.repository.setLeadNextFollowUp(tx, leadId, scheduledAt);

    await this.repository.recordOutcome(tx, intakeId, {
      status: 'PROCESSED',
      processingCode: null,
      failureReason: null,
      processedAt: new Date(),
      createdLeadId: leadId,
      assignedMembershipId: chosen.membershipId,
      assignedUserId: chosen.userId,
      matchedContactId: contact.id,
      ...routing,
    });

    // Last, so a failure anywhere above consumes no turn in the rotation.
    await this.repository.advanceCursor(tx, teamId);

    return { result: 'CONVERTED', leadId, teamId, userId: chosen.userId };
  }

  /**
   * Durable, valid, and waiting on configuration.
   *
   * Not FAILED, and not deleted. The enquiry is perfectly good; the routing
   * table has no answer for it yet. It stays visible and retryable, so fixing
   * the rule or staffing the team and pressing retry converts it.
   */
  private async block(
    tx: PrismaTransaction,
    intakeId: string,
    input: {
      code: string;
      reason: string;
      resolvedTerritoryId?: string | null;
      matchedAssignmentRuleId?: string | null;
      assignedTeamId?: string | null;
    },
  ): Promise<ProcessOutcome> {
    await this.repository.recordOutcome(tx, intakeId, {
      status: 'BLOCKED',
      processingCode: input.code,
      failureReason: input.reason,
      ...(input.resolvedTerritoryId !== undefined
        ? { resolvedTerritoryId: input.resolvedTerritoryId }
        : {}),
      ...(input.matchedAssignmentRuleId !== undefined
        ? { matchedAssignmentRuleId: input.matchedAssignmentRuleId }
        : {}),
      ...(input.assignedTeamId !== undefined ? { assignedTeamId: input.assignedTeamId } : {}),
    });

    return { result: 'BLOCKED', code: input.code };
  }

  /**
   * Somebody already in the CRM looks like this person.
   *
   * Held for review, exactly as J1 holds one found at arrival. Nothing existing
   * is touched: overwriting a customer record on the strength of a web form is
   * how a real relationship gets quietly rewritten by a stranger who typed the
   * same phone number.
   */
  private async duplicate(
    tx: PrismaTransaction,
    intakeId: string,
    input: { code: string; reason: string; matchedLeadId?: string; matchedContactId?: string },
  ): Promise<ProcessOutcome> {
    await this.repository.recordOutcome(tx, intakeId, {
      status: 'DUPLICATE',
      processingCode: input.code,
      failureReason: input.reason,
      ...(input.matchedLeadId !== undefined ? { matchedLeadId: input.matchedLeadId } : {}),
      ...(input.matchedContactId !== undefined ? { matchedContactId: input.matchedContactId } : {}),
    });

    return { result: 'DUPLICATE', code: input.code };
  }

  /**
   * What happened, in identifiers.
   *
   * No message, no name, no phone number, no email — all of that is on the
   * intake row already, and a copy in the audit log would be a second place to
   * find and redact. The actor is null because the system did this; borrowing
   * a real user's id would attribute it to somebody who was asleep.
   */
  private async recordAudit(intakeId: string, outcome: ProcessOutcome): Promise<void> {
    try {
      if (outcome.result === 'CONVERTED') {
        await this.audit.record({
          action: INTAKE_AUDIT.PROCESSED,
          entityType: 'IntegrationIntake',
          entityId: intakeId,
          actorUserId: null,
          after: { leadId: outcome.leadId, teamId: outcome.teamId },
        });

        await this.audit.record({
          action: INTAKE_AUDIT.AUTO_ASSIGNED,
          entityType: 'Lead',
          entityId: outcome.leadId,
          actorUserId: null,
          after: { intakeId, teamId: outcome.teamId, assignedToId: outcome.userId },
        });
        return;
      }

      if (outcome.result === 'BLOCKED') {
        await this.audit.record({
          action: INTAKE_AUDIT.BLOCKED,
          entityType: 'IntegrationIntake',
          entityId: intakeId,
          actorUserId: null,
          after: { code: outcome.code },
        });
        return;
      }

      if (outcome.result === 'DUPLICATE') {
        await this.audit.record({
          action: INTAKE_AUDIT.DUPLICATE_DETECTED,
          entityType: 'IntegrationIntake',
          entityId: intakeId,
          actorUserId: null,
          after: { code: outcome.code },
        });
      }
    } catch (error) {
      // The conversion already committed. Losing its audit row is bad; undoing
      // a customer's lead because the audit write failed would be worse.
      this.logger.error({ err: error, intakeId }, 'Could not record intake processing audit');
    }
  }
}

/**
 * The intake's phone in the form the CRM stores and compares.
 *
 * The same parser every other write path uses. An unparseable number becomes
 * null rather than an error: J1 already decided that losing the enquiry because
 * the phone field held "call me after 6" is worse than losing the number, and
 * this must not reach a different conclusion about the same row.
 */
function canonicalMobile(phone: string | null, country: string): string | null {
  const parsed = parsePhone(phone ?? undefined, { country });
  return parsed.status === 'VALID' ? parsed.e164 : null;
}
