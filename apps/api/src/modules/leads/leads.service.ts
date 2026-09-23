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
import { ContactsRepository } from '../contacts/contacts.repository';
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
    private readonly contacts: ContactsRepository,
    private readonly audit: AuditRepository,
  ) {}

  async list(dto: ListLeadsDto, principal: TenantPrincipal): Promise<Paginated<LeadSummary>> {
    const limit = dto.limit ?? 25;
    const restriction = visibilityFilter(principal);

    const filters = {
      status: dto.status,
      assignedToId: dto.assignedToId,
      productId: dto.productId,
      accountId: dto.accountId,
      search: dto.search,
      restrictToUserId: restriction?.assignedToId,
    };

    // The total is counted with the SAME filters, so "showing 25 of 812"
    // describes the list the caller is actually looking at.
    const [rows, total] = await Promise.all([
      this.repository.list({ ...filters, cursor: dto.cursor, limit }),
      this.repository.countMatching(filters),
    ]);

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(toSummary);

    return {
      items,
      hasMore,
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
      total,
    };
  }

  async findOne(
    id: string,
    principal: TenantPrincipal,
  ): Promise<
    LeadSummary & {
      activities: unknown[];
      /* Both the grouping key and the enquiry text — see the return below. */
      productId: string | null;
      product: { id: string; name: string; sku: string; active: boolean } | null;
      productInterest: string | null;
      accountId: string | null;
      account: { id: string; name: string; status: string } | null;
      source: string | null;
    }
  > {
    // A lead outside the caller's visibility is a 404, exactly like one in
    // another tenant — the response must not confirm it exists.
    const lead = await this.repository.findById(id, visibilityFilter(principal)?.assignedToId);
    // Another tenant's lead and a non-existent lead are the same 404.
    if (!lead) throw AppException.leadNotFound();

    const activities = await this.repository.listActivities(id, 50);

    /*
     * The detail view carries more than a list row.
     *
     * `LeadSummary` stays lean on purpose — it is what a page of results
     * returns, and every field added there is paid for on every row. The
     * detail page is one record, so it can afford the product and the enquiry
     * text.
     */
    return {
      ...toSummary(lead),
      /*
       * Both, deliberately.
       *
       * `product` is the standardised grouping key every KPI uses;
       * `productInterest` is what the customer actually asked for. A catalogue
       * entry cannot carry "500 kg monthly, food manufacturing use", so the
       * detail page shows the two side by side rather than one standing in for
       * the other.
       */
      productId: lead.productId,
      product: lead.product,
      productInterest: lead.productInterest,
      /*
       * The customer this opportunity belongs to.
       *
       * `companyName` above is kept beside it, unchanged. That free text is
       * what was captured at the time and it is the evidence the mapping screen
       * shows; the account is a grouping key placed beside it, not a
       * replacement for it.
       */
      accountId: lead.accountId,
      account: lead.account,
      source: lead.source,
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
    await this.assertProductExists(dto.productId);
    await this.assertAccountExists(dto.accountId);

    // Canonicalise BEFORE the duplicate check, so "+91 98200 11001" and
    // "09820011001" are recognised as the same customer. Null when the lead
    // has no phone number, which a social conversation genuinely may not.
    const mobile = await this.normaliseMobile(dto.mobile);

    /*
     * --- duplicate detection (spec §23) -------------------------------------
     *
     * The rule is explicitly "do not silently create another lead". We return
     * the existing one so the client can offer to open it; creating anyway
     * requires the caller to opt in.
     *
     * Skipped entirely without a mobile, because the mobile IS the duplicate
     * key. Matching on name or company instead would be far worse than missing
     * a duplicate: "John Smith at Acme" collides constantly, and wrongly
     * refusing to create a lead loses a real enquiry.
     */
    if (mobile !== null && !dto.allowDuplicate) {
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

    // Every lead belongs to a person. Reusing the existing contact for this
    // mobile is what lets a returning customer's history survive a closed deal:
    // the second enquiry is a new lead, not a new person.
    //
    // With no mobile there is nothing to match on, so a fresh contact is
    // created. Guessing that two nameless, numberless enquiries are the same
    // person would silently merge unrelated customers, which is precisely what
    // the manual merge workflow exists to avoid.
    const contact = await this.contacts.findOrCreateByMobile({
      mobile,
      firstName: dto.firstName,
      lastName: dto.lastName,
      email: dto.email,
      companyName: dto.companyName,
      city: dto.city,
      actorId: principal.userId,
    });

    const leadId = await this.createWithRetry(
      dto,
      status,
      nextFollowUpAt,
      principal,
      mobile,
      contact.id,
    );
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
  private async normaliseMobile(input: string | undefined): Promise<string | null> {
    // No number is a valid state, not a validation failure — see CreateLeadDto.
    if (input === undefined || input.trim() === '') return null;

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
  /**
   * Rejects a product that is not this organization's.
   *
   * The tenant extension scopes queries; the foreign key does not. Without
   * this, Org A could attach Org B's product and Org B's KPIs would silently
   * include Org A's leads.
   */
  private async assertProductExists(productId?: string): Promise<void> {
    if (!productId) return;

    if (!(await this.repository.productExists(productId))) {
      throw AppException.validation('That product does not exist.', {
        productId: ['not found'],
      });
    }
  }

  /**
   * Rejects an account that is not this organization's.
   *
   * The same gap the product check closes, and it matters more here. The tenant
   * extension scopes QUERIES; a foreign key assignment is not a query. Without
   * this, Org A could set accountId to one of Org B's customers — the insert
   * would succeed, the foreign key would be satisfied, and Org B's Customer 360
   * would quietly start showing Org A's opportunities and revenue.
   */
  private async assertAccountExists(accountId?: string): Promise<void> {
    if (!accountId) return;

    if (!(await this.repository.accountExists(accountId))) {
      throw AppException.validation('That customer does not exist.', {
        accountId: ['not found'],
      });
    }
  }

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
   * Creates the lead, and turns a mobile collision into a refusal.
   *
   * The lead NUMBER can no longer collide: `createWithActivity` allocates it
   * under the tenant's numbering lock, on every path. What remains is the
   * duplicate-mobile index, which is a business rule rather than a race —
   * somebody created this customer between our check and our insert — and
   * the caller needs to be told, not retried.
   *
   * The retry is kept, narrowed to the case it can still help: a P2002 that
   * is NOT the mobile. That should now be unreachable, and the log line says
   * so, because a constraint firing where none can is worth seeing rather
   * than silently absorbing.
   */
  private async createWithRetry(
    dto: CreateLeadDto,
    status: LeadStatus,
    nextFollowUpAt: Date | null,
    principal: TenantPrincipal,
    mobile: string | null,
    contactId: string,
    attempt = 1,
  ): Promise<string> {
    try {
      return await this.repository.createWithActivity({
        firstName: dto.firstName,
        lastName: dto.lastName,
        mobile,
        email: dto.email,
        companyName: dto.companyName,
        city: dto.city,
        source: dto.source,
        productId: dto.productId,
        accountId: dto.accountId,
        productInterest: dto.productInterest,
        estimatedValue: dto.estimatedValue,
        status,
        priority: dto.priority ?? 'MEDIUM',
        assignedToId: dto.assignedToId,
        nextFollowUpAt,
        contactId,
        duplicateAcknowledged: dto.allowDuplicate === true,
        actorId: principal.userId,
      });
    } catch (error) {
      const code = (error as { code?: string }).code;

      // P2002 = unique constraint violation.
      if (code === 'P2002' && attempt <= 5) {
        /*
         * Which unique index fired?
         *
         * Determined by looking at the data rather than by reading the error.
         * Prisma 7 removed the Rust engine, and the driver-adapter path no
         * longer populates `meta.target` — the previous code read it, found
         * undefined, and so never recognised a mobile collision. Every such
         * collision fell through to the lead-number retry below, exhausted its
         * attempts and surfaced as a 500, including the ordinary race this
         * branch was written to handle.
         *
         * A re-query cannot go stale the way a parsed error shape can, and it
         * only runs on the rare collision path.
         */
        /*
         * Only a mobile can collide on the duplicate index, and since
         * numbering moved under the tenant lock it is the only collision
         * left. Established by re-querying rather than by parsing the error,
         * which cannot go stale the way a parsed shape can.
         */
        const collidingLead =
          mobile === null ? null : await this.repository.findActiveByMobile(mobile);

        /*
         * An acknowledged duplicate is excluded from the index, so a P2002
         * here cannot have come from the mobile. Treating it as one would
         * report a duplicate to somebody who explicitly allowed one.
         */
        if (collidingLead && dto.allowDuplicate !== true) {
          // Another request created this customer between our duplicate check
          // and this insert. That is the race the index exists to catch, and
          // it is not retryable.
          throw AppException.conflict(
            ERROR_CODES.DUPLICATE_LEAD,
            'A lead with this mobile number was just created.',
          );
        }

        /*
         * Unexpected now, and logged as such.
         *
         * Lead numbers are allocated under the tenant's advisory lock and
         * cannot collide; an acknowledged duplicate is outside the mobile
         * index. A P2002 reaching here means a constraint fired that this
         * path does not know about, which is worth a loud line rather than a
         * quiet retry.
         */
        this.logger.warn(
          `Unexpected unique violation creating a lead, retrying (attempt ${attempt})`,
        );
        return this.createWithRetry(
          dto,
          status,
          nextFollowUpAt,
          principal,
          mobile,
          contactId,
          attempt + 1,
        );
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
