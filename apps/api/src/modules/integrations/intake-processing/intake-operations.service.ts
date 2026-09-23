import { Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  type IntakeRetryResponse,
  type IntakeRetryResult,
  type IntakeStatus,
  type IntegrationIntakeDetail,
  type IntegrationIntakeListItem,
  type IntegrationIntakePage,
  type LeadSourceIntake,
} from '@leadflow/api-types';
import { AppException } from '../../../common/errors/app.exception';
import { IntakeOperationsRepository } from './intake-operations.repository';
import { IntakeProcessingService } from './intake-processing.service';
import type { IntakeQueryDto } from './dto/intake-operations.dto';

/**
 * The website intake queue, as an operator sees it.
 *
 * Read, and one action: retry. Retry re-evaluates the SAME durable row — it
 * takes no payload, cannot change a single character of what the customer
 * wrote, and cannot mint a new event id. That distinction is the whole reason
 * this is a narrow endpoint rather than a general "reprocess with these
 * values": an operations tool that can rewrite a customer's submission is a
 * tool that will eventually be used to.
 *
 * There is no "create anyway" for a duplicate. J1 and the conversion pipeline
 * both stop at a likely duplicate so a person can decide, and an override here
 * would be that decision made by whoever clicked first, with no record of what
 * they were told. A richer duplicate-resolution workflow is its own piece of
 * work.
 */
@Injectable()
export class IntakeOperationsService {
  constructor(
    private readonly repository: IntakeOperationsRepository,
    private readonly processing: IntakeProcessingService,
  ) {}

  async list(query: IntakeQueryDto): Promise<IntegrationIntakePage> {
    const page = await this.repository.list({
      status: query.status as IntakeStatus | undefined,
      source: query.source,
      receivedFrom: query.receivedFrom ? new Date(query.receivedFrom) : undefined,
      receivedTo: query.receivedTo ? new Date(query.receivedTo) : undefined,
      limit: query.limit ?? 25,
      offset: query.offset ?? 0,
    });

    return { items: page.items.map(toListItem), total: page.total };
  }

  async findOne(id: string): Promise<IntegrationIntakeDetail> {
    return toDetail(await this.require(id));
  }

  /**
   * Evaluates the same enquiry again.
   *
   * For an intake blocked by configuration this is the whole recovery path:
   * an administrator fixes the rule, staffs the team or adds the coverage, and
   * presses this. Converting is idempotent, so pressing it on a row that
   * somebody else just converted reports the existing lead rather than making
   * a second one.
   */
  async retry(id: string): Promise<IntakeRetryResponse> {
    const intake = await this.require(id);

    if (intake.status === 'DUPLICATE') {
      /*
       * Refused, and the message says why rather than just saying no.
       *
       * A duplicate is a decision waiting for a person. Retrying it would
       * either do nothing — the re-check finds the same match — or, if it did
       * something, would mean the machine had overruled the review. Neither is
       * a retry.
       */
      throw AppException.validation('This enquiry is held for duplicate review.', {
        status: ['a person needs to decide whether this is the same customer'],
      });
    }

    if (intake.status === 'PROCESSED') {
      return { result: 'ALREADY_PROCESSED', intake: toDetail(intake) };
    }

    /*
     * BLOCKED and FAILED rows are moved back to RECEIVED so the pipeline's own
     * claim predicate can pick them up. That predicate is what makes conversion
     * idempotent, and giving retry a second way in would mean two paths to the
     * same write with only one of them locked.
     */
    await this.repository.reopen(id);

    const outcome = await this.processing.process(id);

    return {
      result: outcome.result as IntakeRetryResult,
      intake: toDetail(await this.require(id)),
    };
  }

  /** The enquiry behind a lead, for the source panel. Null when there is none. */
  async forLead(leadId: string): Promise<LeadSourceIntake | null> {
    const intake = await this.repository.findByLeadId(leadId);
    if (!intake) return null;

    return {
      id: intake.id,
      source: intake.source,
      receivedAt: intake.receivedAt.toISOString(),
      sourcePage: intake.sourcePage,
      message: intake.message,
      productInterest: intake.productInterest,
      territory: intake.resolvedTerritory,
      rule: intake.matchedAssignmentRule,
      team: intake.assignedTeam,
    };
  }

  /** Another organization's intake is indistinguishable from one that is gone. */
  private async require(id: string) {
    const intake = await this.repository.findById(id);
    if (!intake) throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Enquiry not found.');

    return intake;
  }
}

type DetailRow = NonNullable<Awaited<ReturnType<IntakeOperationsRepository['findById']>>>;
type ListRow = Awaited<ReturnType<IntakeOperationsRepository['list']>>['items'][number];

function toListItem(row: ListRow): IntegrationIntakeListItem {
  return {
    id: row.id,
    source: row.source,
    status: row.status as IntakeStatus,
    receivedAt: row.receivedAt.toISOString(),
    name: row.name,
    company: row.company,
    productInterest: row.productInterest,
    sourcePage: row.sourcePage,
    processingCode: row.processingCode,
    failureReason: row.failureReason,
    processingAttempts: row.processingAttempts,
    lastProcessingAt: row.lastProcessingAt?.toISOString() ?? null,
    processedAt: row.processedAt?.toISOString() ?? null,
    territory: row.resolvedTerritory,
    rule: row.matchedAssignmentRule,
    team: row.assignedTeam,
    assignedTo: row.assignedUser,
    createdLead: row.createdLead,
  };
}

function toDetail(row: DetailRow): IntegrationIntakeDetail {
  return {
    ...toListItem(row),
    email: row.email,
    phone: row.phone,
    country: row.country,
    message: row.message,
    matchedContactId: row.matchedContactId,
    matchedLeadId: row.matchedLeadId,
  };
}
