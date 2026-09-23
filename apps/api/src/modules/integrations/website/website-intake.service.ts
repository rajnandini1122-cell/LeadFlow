import { Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES } from '@leadflow/api-types';
import { AppConfig } from '../../../common/config/config.module';
import { AppException } from '../../../common/errors/app.exception';
import { AuditRepository } from '../../../common/audit/audit.repository';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service';
import { parsePhone } from '../../../common/utils/phone';
import { WebsiteIntakeRepository, type IntakeRecord } from './website-intake.repository';
import { payloadDigest, verifyIntakeSignature } from './intake-signature';
import type { WebsiteIntakeDto } from './dto/website-intake.dto';

/** The one value written to `source`. */
export const WEBSITE_SOURCE = 'WEBSITE';
/** The one value written to `event_type` in this phase. */
export const ENQUIRY_EVENT = 'ENQUIRY';

export interface IntakeReceipt {
  intakeId: string;
  status: string;
  /** True when this request created the record; false when it matched a retry. */
  created: boolean;
  receivedAt: string;
}

/**
 * The LeadFlow side of the website intake boundary.
 *
 * Three questions, in this order, and the order is the design:
 *
 *   1. Is this caller who they claim to be? An HMAC over the timestamp, the
 *      event id and the exact body bytes. Nothing in the payload means
 *      anything until that passes — a name, an email and a phone number are
 *      attacker-controlled strings until then.
 *
 *   2. Whose is it? Configuration says so. Never the request: a signature
 *      proves who is calling, not which tenant they may write to, and a body
 *      that could name an organization would turn one shared secret into
 *      access to all of them.
 *
 *   3. Have we seen it already? The database decides, through a unique index.
 *      A website that retries a submission whose response it never saw must
 *      get the first receipt back, not a second customer.
 *
 * WHAT THIS DOES NOT DO is create a Lead. See `submit` for why.
 */
@Injectable()
export class WebsiteIntakeService {
  private readonly logger = new Logger(WebsiteIntakeService.name);

  constructor(
    private readonly config: AppConfig,
    private readonly repository: WebsiteIntakeRepository,
    private readonly audit: AuditRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Whether this deployment has the integration switched on at all. */
  get enabled(): boolean {
    return this.config.get('WEBSITE_INTAKE_ENABLED');
  }

  /**
   * Authenticates a request, or throws the one error every failure produces.
   *
   * Deliberately a single message and a single code for every reason: a caller
   * debugging their own integration learns which request failed, and a caller
   * probing it learns nothing about WHICH part was wrong — whether the secret
   * was close, whether the timestamp window is long, or whether that event id
   * exists. The reason is logged for us, never returned.
   */
  authenticate(input: {
    rawBody: Buffer | undefined;
    signatureHeader: string | undefined;
    timestampHeader: string | undefined;
    eventId: string | undefined;
  }): void {
    const result = verifyIntakeSignature({
      ...input,
      secret: this.config.get('WEBSITE_INTAKE_SIGNING_SECRET'),
    });

    if (result.valid) return;

    // The category only. Never the signature, the expected value, the secret,
    // or any part of the body.
    this.logger.warn(
      { reason: result.reason, source: WEBSITE_SOURCE },
      'Rejected website intake: signature check failed',
    );

    throw AppException.unauthorized('This request could not be authenticated.');
  }

  /**
   * Records a submission.
   *
   * NO LEAD IS CREATED, and that is a decision rather than an omission.
   *
   * An active lead must carry a next follow-up date — a CHECK constraint in
   * the database says so, and LeadsService refuses to create one without it.
   * Choosing that date for a website enquiry is a business policy ("someone
   * will call within a day"), and choosing an owner is the assignment
   * workstream that has not happened yet. Inventing either here would put a
   * date nobody agreed to on every website lead, and would either leave leads
   * unassigned or pick a victim.
   *
   * So the intake is stored, tenant-scoped and auditable, and conversion waits
   * for the phase that can answer those questions. Nothing is lost: the
   * submission is durable, the duplicate signal is recorded, and
   * `created_lead_id` is the column that will say when it became CRM work.
   */
  async submit(input: {
    dto: WebsiteIntakeDto;
    rawBody: Buffer;
    eventId: string;
  }): Promise<IntakeReceipt> {
    const organizationId = this.config.get('WEBSITE_INTAKE_ORGANIZATION_ID');

    if (!organizationId) {
      // Unreachable in a validly configured process — the env schema refuses
      // to boot without it when the integration is enabled — but the cost of
      // being wrong is writing into an unknown tenant, so it is checked.
      this.logger.error('Website intake is enabled with no organization configured');
      throw AppException.internal('This integration is not configured.');
    }

    const hash = payloadDigest(input.rawBody);

    return this.tenantContext.runForOrganization(organizationId, 'website intake', async () => {
      if (!(await this.repository.organizationIsUsable())) {
        this.logger.error(
          { organizationId },
          'Website intake is configured for an organization that is missing or not active',
        );
        throw AppException.internal('This integration is not configured.');
      }

      const canonical = await this.canonicalise(input.dto);
      const match = await this.repository.findLikelyMatch({
        phone: canonical.phone,
        email: input.dto.email,
      });

      const created = await this.repository.create({
        source: WEBSITE_SOURCE,
        externalEventId: input.eventId,
        eventType: ENQUIRY_EVENT,
        payloadHash: hash,
        /*
         * DUPLICATE means "this looks like somebody we already know, so a
         * person should decide" — not "discarded". The matching record is
         * untouched: overwriting a customer on the strength of a website form
         * is how a real relationship gets quietly rewritten by a stranger who
         * typed the same phone number.
         */
        status: match.contactId || match.leadId ? 'DUPLICATE' : 'RECEIVED',
        name: input.dto.name,
        email: input.dto.email,
        phone: canonical.phone,
        country: canonical.country,
        company: input.dto.company,
        message: input.dto.message,
        productInterest: input.dto.productInterest,
        sourcePage: input.dto.sourcePage,
        matchedContactId: match.contactId,
        matchedLeadId: match.leadId,
      });

      if (created) {
        await this.audit.record({
          action: 'integration.intake.received',
          entityType: 'IntegrationIntake',
          entityId: created.id,
          // What an operator needs to answer "when, from where, which tenant,
          // and what happened" — and nothing a subject would mind us keeping:
          // no name, no message, no contact details.
          after: {
            source: WEBSITE_SOURCE,
            eventType: ENQUIRY_EVENT,
            externalEventId: input.eventId,
            status: created.status,
            matchedExisting: Boolean(match.contactId || match.leadId),
          },
        });

        return receipt(created, true);
      }

      return this.existingReceipt(input.eventId, hash);
    });
  }

  /**
   * The receipt of a submission we already hold.
   *
   * Same event id and same bytes: the same receipt, because this is one
   * submission that was sent twice. Same id, different bytes: a refusal,
   * because one of the two is not what the website thinks it sent, and
   * silently keeping the first — or overwriting it with the second — would
   * lose whichever was real.
   */
  private async existingReceipt(eventId: string, hash: string): Promise<IntakeReceipt> {
    const existing = await this.repository.findByEventId(WEBSITE_SOURCE, eventId);

    if (!existing) {
      // The insert lost a race and yet nothing is there to find: possible only
      // if the row was deleted in between. Nothing sensible to return.
      this.logger.error({ eventId }, 'Intake conflicted with a row that then disappeared');
      throw AppException.internal();
    }

    if (existing.payloadHash !== hash) {
      this.logger.warn(
        { eventId, intakeId: existing.id },
        'Website intake reused an event id with a different payload',
      );

      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        'This event id has already been used for a different submission. ' +
          'Use a new event id, or resend the original submission unchanged.',
      );
    }

    return receipt(existing, false);
  }

  /**
   * Phone and country in the forms the CRM stores them.
   *
   * The same parser every other write path uses — there is exactly one in this
   * codebase, and a second would eventually disagree with it about whose
   * number is whose. The country stated by the caller wins; otherwise the
   * tenant's own is the dialling region, which is the same order of precedence
   * the CRM applies.
   *
   * An unparseable number is DROPPED rather than refused: a website visitor
   * cannot be asked to try again, and losing the enquiry because the phone
   * field held "call me after 6" would be a worse outcome than losing the
   * number. The message, the name and the email are what sales acts on.
   */
  private async canonicalise(dto: WebsiteIntakeDto): Promise<{
    phone?: string | undefined;
    country?: string | undefined;
  }> {
    const country = dto.country ?? (await this.repository.organizationCountry());
    const parsed = parsePhone(dto.phone, { country });

    if (parsed.status === 'INVALID') {
      this.logger.debug('Website intake phone could not be canonicalised; storing without one');
    }

    return {
      phone: parsed.status === 'VALID' ? parsed.e164 : undefined,
      country: dto.country,
    };
  }
}

function receipt(record: IntakeRecord, created: boolean): IntakeReceipt {
  return {
    intakeId: record.id,
    status: record.status,
    created,
    receivedAt: record.receivedAt.toISOString(),
  };
}
