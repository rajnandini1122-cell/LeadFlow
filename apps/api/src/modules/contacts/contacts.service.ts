import { Injectable } from '@nestjs/common';
import { ERROR_CODES, type Paginated } from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import { AuditRepository } from '../../common/audit/audit.repository';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { PhoneParseError, toE164 } from '../../common/utils/phone';
import { ContactsRepository } from './contacts.repository';
import type { CreateContactDto, MergeContactsDto, UpdateContactDto } from './dto/contacts.dto';

export interface ContactView {
  id: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  mobile: string | null;
  email: string | null;
  companyName: string | null;
  city: string | null;
  notes: string | null;
  leadCount: number;
  createdAt: string;
}

/** Fields a merge must decide between when both records carry a value. */
const MERGEABLE_FIELDS = [
  'firstName',
  'lastName',
  'mobile',
  'email',
  'companyName',
  'city',
  'notes',
] as const;

export type MergeableField = (typeof MERGEABLE_FIELDS)[number];

@Injectable()
export class ContactsService {
  constructor(
    private readonly repository: ContactsRepository,
    private readonly audit: AuditRepository,
  ) {}

  async list(options: {
    search?: string | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
  }): Promise<Paginated<ContactView>> {
    const limit = options.limit ?? 25;
    const [rows, total] = await Promise.all([
      this.repository.page({ search: options.search, cursor: options.cursor, limit }),
      this.repository.countAll(options.search),
    ]);

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(toView);

    return {
      items,
      hasMore,
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
      total,
    };
  }

  async findOne(id: string) {
    const contact = await this.repository.findById(id);
    // Another tenant's contact is indistinguishable from one that never existed.
    if (!contact) throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Contact not found.');

    return {
      ...toView({ ...contact, _count: { leads: contact.leads.length } }),
      mergedIntoId: contact.mergedIntoId,
      leads: contact.leads.map((lead) => ({
        id: lead.id,
        leadNumber: lead.leadNumber,
        status: lead.status,
        priority: lead.priority,
        estimatedValue: lead.estimatedValue?.toString() ?? null,
        nextFollowUpAt: lead.nextFollowUpAt?.toISOString() ?? null,
        assignedTo: lead.assignedTo,
        createdAt: lead.createdAt.toISOString(),
      })),
    };
  }

  async create(dto: CreateContactDto, principal: TenantPrincipal): Promise<ContactView> {
    const mobile = dto.mobile ? await this.normaliseMobile(dto.mobile) : undefined;

    const contact = await this.repository.create({
      firstName: dto.firstName,
      lastName: dto.lastName,
      mobile,
      email: dto.email?.toLowerCase(),
      companyName: dto.companyName,
      city: dto.city,
      notes: dto.notes,
      actorId: principal.userId,
    });

    await this.audit.record({
      action: 'contact.created',
      entityType: 'contact',
      entityId: contact.id,
      after: { mobile, email: dto.email },
    });

    return toView({ ...contact, _count: { leads: 0 } });
  }

  async update(
    id: string,
    dto: UpdateContactDto,
    principal: TenantPrincipal,
  ): Promise<ContactView> {
    const existing = await this.repository.findById(id);
    if (!existing) throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Contact not found.');

    const data: Record<string, unknown> = { updatedBy: principal.userId };
    for (const field of ['firstName', 'lastName', 'companyName', 'city', 'notes'] as const) {
      if (dto[field] !== undefined) data[field] = dto[field];
    }
    if (dto.email !== undefined) data['email'] = dto.email.toLowerCase();
    if (dto.mobile !== undefined) data['mobile'] = await this.normaliseMobile(dto.mobile);

    const updated = await this.repository.update(id, data);
    if (updated === 0) throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Contact not found.');

    await this.audit.record({
      action: 'contact.updated',
      entityType: 'contact',
      entityId: id,
    });

    const refreshed = await this.repository.findById(id);
    return toView({ ...refreshed!, _count: { leads: refreshed!.leads.length } });
  }

  // ---------------------------------------------------------------------------
  // Duplicates
  // ---------------------------------------------------------------------------

  /**
   * Candidate duplicates, for review — never merged automatically.
   *
   * A merge is destructive and cannot be undone by the user, so the system's
   * job is to SURFACE candidates and let a human decide. Auto-merging on a
   * shared email address would combine two colleagues at the same company who
   * both used `info@`.
   */
  async duplicatesOf(id: string) {
    const contact = await this.repository.findById(id);
    if (!contact) throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Contact not found.');

    const candidates = await this.repository.findDuplicatesOf(contact);

    return candidates.map((candidate) => ({
      ...toView(candidate),
      matchedOn: [
        contact.mobile && candidate.mobile === contact.mobile ? 'mobile' : null,
        contact.email && candidate.email === contact.email ? 'email' : null,
      ].filter(Boolean) as string[],
    }));
  }

  /** Every duplicate cluster in the organization, for a review screen. */
  async duplicateGroups(): Promise<
    { matchedOn: 'mobile' | 'email'; value: string; contacts: ContactView[] }[]
  > {
    const groups = await this.repository.duplicateGroups(50);
    const result: { matchedOn: 'mobile' | 'email'; value: string; contacts: ContactView[] }[] = [];

    for (const group of groups.byMobile) {
      if (!group.mobile) continue;
      const contacts = await this.repository.findByMobileOrEmail({ mobile: group.mobile });
      if (contacts.length > 1) {
        result.push({ matchedOn: 'mobile', value: group.mobile, contacts: contacts.map(toView) });
      }
    }

    for (const group of groups.byEmail) {
      if (!group.email) continue;
      const contacts = await this.repository.findByMobileOrEmail({ email: group.email });
      // Skip clusters already reported under a shared mobile, or the same set
      // would appear twice and the duplicate count would be inflated.
      const alreadyReported = result.some((entry) =>
        entry.contacts.every((c) => contacts.some((candidate) => candidate.id === c.id)),
      );
      if (contacts.length > 1 && !alreadyReported) {
        result.push({ matchedOn: 'email', value: group.email, contacts: contacts.map(toView) });
      }
    }

    return result;
  }

  /**
   * Merges two contacts after explicit confirmation.
   *
   * `fieldChoices` says which record wins for each conflicting field. Defaulting
   * silently would quietly discard whichever value the user actually wanted,
   * and they would have no way to tell.
   */
  async merge(
    dto: MergeContactsDto,
    principal: TenantPrincipal,
  ): Promise<{ targetId: string; leadsMoved: number }> {
    if (dto.sourceId === dto.targetId) {
      throw AppException.validation('Cannot merge a contact into itself.', {
        sourceId: ['must differ from targetId'],
      });
    }

    const [source, target] = await Promise.all([
      this.repository.findById(dto.sourceId),
      this.repository.findById(dto.targetId),
    ]);

    // Tenant-scoped reads, so a contact from another organization is simply not
    // found — the merge cannot reach across tenants even with a valid id.
    if (!source || !target) {
      throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Contact not found.');
    }
    if (source.mergedIntoId || target.mergedIntoId) {
      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        'One of these contacts has already been merged.',
      );
    }

    // Only fields explicitly awarded to the source move across; everything else
    // keeps the target's value.
    const winningFields: Record<string, unknown> = {};
    for (const field of MERGEABLE_FIELDS) {
      if (dto.fieldChoices?.[field] === 'source') {
        winningFields[field] = source[field];
      }
    }

    const { leadsMoved } = await this.repository.merge({
      sourceId: dto.sourceId,
      targetId: dto.targetId,
      winningFields,
      actorId: principal.userId,
    });

    await this.audit.record({
      action: 'contact.merged',
      entityType: 'contact',
      entityId: dto.targetId,
      before: { sourceId: dto.sourceId, sourceMobile: source.mobile, sourceEmail: source.email },
      after: { targetId: dto.targetId, leadsMoved, winningFields },
    });

    return { targetId: dto.targetId, leadsMoved };
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

type ContactRow = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  mobile: string | null;
  email: string | null;
  companyName: string | null;
  city: string | null;
  notes: string | null;
  createdAt: Date;
  _count?: { leads: number } | undefined;
};

function toView(contact: ContactRow): ContactView {
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim();

  return {
    id: contact.id,
    name: name || contact.companyName || '(no name)',
    firstName: contact.firstName,
    lastName: contact.lastName,
    mobile: contact.mobile,
    email: contact.email,
    companyName: contact.companyName,
    city: contact.city,
    notes: contact.notes,
    leadCount: contact._count?.leads ?? 0,
    createdAt: contact.createdAt.toISOString(),
  };
}

export { MERGEABLE_FIELDS };
