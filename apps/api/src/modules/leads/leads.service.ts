import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  ERROR_CODES,
  isTerminalLeadStatus,
  type LeadPriority,
  type LeadStatus,
  type Paginated,
} from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import { AuditRepository } from '../../common/audit/audit.repository';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { LeadsRepository } from './leads.repository';
import type { ListLeadsDto } from './dto/leads.dto';
import type { CreateLeadDto } from './dto/create-lead.dto';
import { visibilityFilter } from './lead-visibility';
import { PhoneParseError, toE164 } from '../../common/utils/phone';

export interface LeadSummary {
  id: string;
  leadNumber: string;
  name: string;
  companyName: string | null;
  mobile: string | null;
  status: LeadStatus;
  priority: LeadPriority;
  estimatedValue: string | null;
  nextFollowUpAt: string | null;
  assignedTo: { id: string; fullName: string } | null;
  createdAt: string;
}

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  constructor(
    private readonly repository: LeadsRepository,
    private readonly audit: AuditRepository,
  ) {}

  async list(dto: ListLeadsDto, principal: TenantPrincipal): Promise<Paginated<LeadSummary>> {
    const limit = dto.limit ?? 25;
    const restriction = visibilityFilter(principal);

    const rows = await this.repository.list({
      status: dto.status,
      assignedToId: dto.assignedToId,
      search: dto.search,
      cursor: dto.cursor,
      limit,
      restrictToUserId: restriction?.assignedToId,
    });

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(toSummary);

    return {
      items,
      hasMore,
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  }

  async findOne(
    id: string,
    principal: TenantPrincipal,
  ): Promise<LeadSummary & { activities: unknown[] }> {
    // A lead outside the caller's visibility is a 404, exactly like one in
    // another tenant — the response must not confirm it exists.
    const lead = await this.repository.findById(id, visibilityFilter(principal)?.assignedToId);
    // Another tenant's lead and a non-existent lead are the same 404.
    if (!lead) throw AppException.leadNotFound();

    const activities = await this.repository.listActivities(id, 50);

    return {
      ...toSummary(lead),
      activities: activities.map((activity) => ({
        id: activity.id,
        type: activity.activityType,
        description: activity.description,
        performedBy: activity.performedBy,
        createdAt: activity.createdAt.toISOString(),
      })),
    };
  }

  async assignableUsers(): Promise<{ id: string; fullName: string }[]> {
    return this.repository.assignableUsers();
  }

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------

  async create(dto: CreateLeadDto, principal: TenantPrincipal): Promise<LeadSummary> {
    const status = dto.status ?? 'NEW';
    const nextFollowUpAt = this.resolveFollowUp(dto, status);

    await this.assertAssignableTo(dto.assignedToId);

    // Canonicalise BEFORE the duplicate check, so "+91 98200 11001" and
    // "09820011001" are recognised as the same customer.
    const mobile = await this.normaliseMobile(dto.mobile);

    // --- duplicate detection (spec §23) -------------------------------------
    // The rule is explicitly "do not silently create another lead". We return
    // the existing one so the client can offer to open it; creating anyway
    // requires the caller to opt in.
    if (!dto.allowDuplicate) {
      const existing = await this.repository.findActiveByMobile(mobile);
      if (existing) {
        const name = [existing.firstName, existing.lastName].filter(Boolean).join(" ").trim();

        // Details carry the existing lead so the client can offer
        // "Open existing lead" without a second round trip.
        throw new AppException(
          ERROR_CODES.DUPLICATE_LEAD,
          `A lead with mobile ${mobile} already exists (${existing.leadNumber}).`,
          HttpStatus.CONFLICT,
          {
            existingLeadId: [existing.id],
            existingLeadNumber: [existing.leadNumber],
            existingLeadName: [name || existing.companyName || existing.leadNumber],
            existingLeadStatus: [existing.status],
          },
        );
      }
    }

    const leadId = await this.createWithRetry(dto, status, nextFollowUpAt, principal, mobile);
    const lead = await this.repository.findById(leadId);
    if (!lead) throw AppException.leadNotFound();

    await this.audit.record({
      action: 'lead.created',
      entityType: 'lead',
      entityId: lead.id,
      after: {
        leadNumber: lead.leadNumber,
        mobile,
        status,
        assignedToId: dto.assignedToId ?? null,
        duplicateOverridden: dto.allowDuplicate === true,
      },
    });

    return toSummary(lead);
  }

  /**
   * Converts user input to E.164 using the ORGANIZATION's country.
   *
   * The country is tenant data, not a constant: a US organization and an
   * Indian one interpret the same digits differently, and getting this wrong
   * silently breaks duplicate detection.
   */
  private async normaliseMobile(input: string): Promise<string> {
    const country = await this.repository.organizationCountry();

    try {
      return toE164(input, country);
    } catch (error) {
      if (error instanceof PhoneParseError) {
        throw AppException.validation('Invalid phone number.', {
          mobile: [error.message],
        });
      }
      throw error;
    }
  }

  /**
   * Rejects an assignee who is not an active member of this organization.
   *
   * leads.assigned_to references the global users table, so a foreign or
   * non-existent id would otherwise be accepted and another organization's
   * user would surface as the owner of this lead.
   */
  private async assertAssignableTo(assignedToId?: string): Promise<void> {
    if (!assignedToId) return;

    const isMember = await this.repository.isActiveMember(assignedToId);
    if (!isMember) {
      // 400, not 404: the caller supplied a bad value. It deliberately does not
      // reveal whether the id exists in some other organization.
      throw AppException.validation('Cannot assign this lead.', {
        assignedToId: ['must be an active member of your organization'],
      });
    }
  }

  /**
   * Enforces the "no lead left behind" rule at the API boundary.
   *
   * The database CHECK constraint is the real guarantee, but catching it here
   * yields a field-level validation error instead of a 500 from Postgres.
   */
  private resolveFollowUp(dto: CreateLeadDto, status: LeadStatus): Date | null {
    if (isTerminalLeadStatus(status)) return null;

    if (!dto.nextFollowUpAt) {
      throw AppException.validation(
        'An active lead must have a next follow-up date.',
        { nextFollowUpAt: ['is required unless the lead is created as WON or LOST'] },
      );
    }

    const date = new Date(dto.nextFollowUpAt);
    if (Number.isNaN(date.getTime())) {
      throw AppException.validation('Invalid follow-up date.', {
        nextFollowUpAt: ['must be a valid date'],
      });
    }

    return date;
  }

  /**
   * Retries on a lead-number collision.
   *
   * `nextLeadNumber` reads the current maximum, so two simultaneous creates can
   * pick the same value. The unique index rejects the loser; recomputing and
   * retrying is simpler and cheaper than a per-tenant sequence table, and the
   * window is microseconds wide.
   */
  private async createWithRetry(
    dto: CreateLeadDto,
    status: LeadStatus,
    nextFollowUpAt: Date | null,
    principal: TenantPrincipal,
    mobile: string,
    attempt = 1,
  ): Promise<string> {
    const leadNumber = await this.repository.nextLeadNumber();

    try {
      return await this.repository.createWithActivity({
        leadNumber,
        firstName: dto.firstName,
        lastName: dto.lastName,
        mobile,
        email: dto.email,
        companyName: dto.companyName,
        city: dto.city,
        source: dto.source,
        productInterest: dto.productInterest,
        estimatedValue: dto.estimatedValue,
        status,
        priority: dto.priority ?? 'MEDIUM',
        assignedToId: dto.assignedToId,
        nextFollowUpAt,
        actorId: principal.userId,
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      const constraint = String((error as { meta?: { target?: unknown } }).meta?.target ?? '');

      // P2002 = unique constraint violation.
      if (code === 'P2002' && attempt <= 5) {
        // The mobile index firing means another request created the same
        // customer between our duplicate check and this insert. That is the
        // race the index exists to catch, and it is not retryable.
        if (constraint.includes('mobile')) {
          throw AppException.conflict(
            ERROR_CODES.DUPLICATE_LEAD,
            'A lead with this mobile number was just created.',
          );
        }

        this.logger.warn(
          `Lead number ${leadNumber} collided, retrying (attempt ${attempt})`,
        );
        return this.createWithRetry(dto, status, nextFollowUpAt, principal, mobile, attempt + 1);
      }

      throw error;
    }
  }
}

type LeadRow = {
  id: string;
  leadNumber: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  mobile: string | null;
  status: string;
  priority: string;
  estimatedValue: { toString(): string } | null;
  nextFollowUpAt: Date | null;
  createdAt: Date;
  assignedTo: { id: string; fullName: string } | null;
};

function toSummary(lead: LeadRow): LeadSummary {
  const name = [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim();

  return {
    id: lead.id,
    leadNumber: lead.leadNumber,
    name: name || '(no name)',
    companyName: lead.companyName,
    mobile: lead.mobile,
    status: lead.status as LeadStatus,
    priority: lead.priority as LeadPriority,
    // Decimal is serialised as a string: JSON numbers are IEEE-754 doubles and
    // would silently round a large deal value.
    estimatedValue: lead.estimatedValue?.toString() ?? null,
    nextFollowUpAt: lead.nextFollowUpAt?.toISOString() ?? null,
    assignedTo: lead.assignedTo,
    createdAt: lead.createdAt.toISOString(),
  };
}
