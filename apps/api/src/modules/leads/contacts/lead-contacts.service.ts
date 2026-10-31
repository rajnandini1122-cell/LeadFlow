import { HttpStatus, Inject, Injectable, forwardRef } from '@nestjs/common';
import {
  ERROR_CODES,
  MAX_LEAD_CONTACTS,
  type ContactRef,
  type LeadContactView,
} from '@leadflow/api-types';
import { AppException } from '../../../common/errors/app.exception';
import { AuditRepository } from '../../../common/audit/audit.repository';

import type { TenantPrincipal } from '../../../common/tenancy/tenant-context.service';
import { PhoneParseError, toE164 } from '../../../common/utils/phone';
import { FollowUpsRepository } from '../../follow-ups/follow-ups.repository';
import { LeadsRepository } from '../leads.repository';
import { visibilityFilter } from '../lead-visibility';
import type {
  AddLeadContactDto,
  LeadContactInputDto,
  UpdateLeadContactDto,
} from './lead-contacts.dto';
import {
  LeadContactsRepository,
  type LinkRow,
  type PersonFields,
  type PrismaTransaction,
} from './lead-contacts.repository';

/**
 * Points of contact (POCs) on a lead.
 *
 * RULES
 *  * A POC is a link to a `Contact` -- the organization's one record of a
 *    person. A phone number that already belongs to somebody links THAT
 *    person; it never creates a second copy of them.
 *  * While a lead has any active POC, exactly one is primary. Adding the first
 *    one, deactivating the primary, or reactivating onto a lead with none all
 *    keep that true.
 *  * Every change runs under the lead's row lock, so concurrent edits of one
 *    lead's contacts are serialised; the partial unique index is the backstop.
 *  * The lead's own name / mobile / email are never rewritten here. They are
 *    the enquiry as it arrived and the duplicate-detection key.
 *  * Nothing here sends a message.
 */
@Injectable()
export class LeadContactsService {
  constructor(
    private readonly repository: LeadContactsRepository,
    private readonly leads: LeadsRepository,
    @Inject(forwardRef(() => FollowUpsRepository))
    private readonly followUps: FollowUpsRepository,
    private readonly audit: AuditRepository,
  ) {}

  async list(leadId: string, principal: TenantPrincipal): Promise<LeadContactView[]> {
    const lead = await this.requireVisibleLead(leadId, principal);
    if (lead.contactId) await this.repository.ensureLegacyLink(leadId, lead.contactId);
    return (await this.repository.listForLead(leadId)).map(toLinkView);
  }

  async add(
    leadId: string,
    dto: AddLeadContactDto,
    principal: TenantPrincipal,
  ): Promise<LeadContactView> {
    const lead = await this.requireVisibleLead(leadId, principal);
    if (lead.contactId) await this.repository.ensureLegacyLink(leadId, lead.contactId);
    const person = await this.normalisePerson(dto);

    const link = await this.inLock(leadId, async (tx) => {
      if ((await this.repository.countActive(tx, leadId)) >= MAX_LEAD_CONTACTS) {
        throw AppException.validation(
          `A lead can have at most ${MAX_LEAD_CONTACTS} active contacts.`,
          {
            contacts: ['mark someone who no longer handles this enquiry inactive first'],
          },
        );
      }

      const created = await this.linkPerson(tx, {
        leadId,
        accountId: lead.accountId ?? null,
        companyName: lead.companyName ?? null,
        person,
        notes: dto.notes ?? null,
        makePrimary: dto.isPrimary === true,
        allowDuplicate: dto.allowDuplicate === true,
        actorId: principal.userId,
      });

      await this.followUps.recordLeadActivity(tx, {
        leadId,
        activityType: 'LEAD_UPDATED',
        description: `Contact added: ${describe(created)}${created.isPrimary ? ' (primary)' : ''}`,
        actorId: principal.userId,
      });
      return created;
    });

    await this.audit.record({
      action: 'lead.contact_added',
      entityType: 'lead',
      entityId: leadId,
      after: { linkId: link.id, contactId: link.contactId, isPrimary: link.isPrimary },
    });
    return toLinkView(link);
  }

  async update(
    leadId: string,
    linkId: string,
    dto: UpdateLeadContactDto,
    principal: TenantPrincipal,
  ): Promise<LeadContactView> {
    const lead = await this.requireVisibleLead(leadId, principal);
    const changes = await this.normaliseChanges(dto);

    const updated = await this.inLock(leadId, async (tx) => {
      const link = await this.requireLink(tx, leadId, linkId);

      const phones = [changes.mobile, changes.whatsapp].filter(
        (p): p is string => typeof p === 'string',
      );
      const email = typeof changes.email === 'string' ? changes.email : null;
      if (!dto.allowDuplicate && (phones.length > 0 || email)) {
        const lookalikes = await this.repository.findLookalikes(tx, {
          leadId,
          accountId: lead.accountId ?? null,
          phones,
          email,
          exceptContactId: link.contactId,
        });
        if (lookalikes.length > 0) throw duplicateWarning(lookalikes);
      }

      const { notes, ...person } = changes;
      if (Object.keys(person).length > 0) {
        await this.repository.updatePerson(tx, link.contactId, person, principal.userId);
      }
      if (notes !== undefined)
        await this.repository.updateLink(tx, linkId, { notes }, principal.userId);

      const after = await this.requireLink(tx, leadId, linkId);
      await this.followUps.recordLeadActivity(tx, {
        leadId,
        activityType: 'LEAD_UPDATED',
        description: `Contact updated: ${describe(after)}`,
        actorId: principal.userId,
      });
      return after;
    });

    await this.audit.record({
      action: 'lead.contact_updated',
      entityType: 'lead',
      entityId: leadId,
      after: { linkId, fields: Object.keys(changes) },
    });
    return toLinkView(updated);
  }

  /** Atomic: the old primary is cleared and the new one set in one commit. */
  async setPrimary(
    leadId: string,
    linkId: string,
    principal: TenantPrincipal,
  ): Promise<LeadContactView[]> {
    await this.requireVisibleLead(leadId, principal);

    await this.inLock(leadId, async (tx) => {
      const link = await this.requireLink(tx, leadId, linkId);
      if (link.inactiveAt) {
        throw AppException.validation('An inactive contact cannot be the primary contact.', {
          linkId: ['mark them active first'],
        });
      }
      if (link.isPrimary) return;

      await this.repository.setPrimary(tx, leadId, linkId, principal.userId);
      await this.followUps.recordLeadActivity(tx, {
        leadId,
        activityType: 'LEAD_UPDATED',
        description: `Primary contact changed to ${describe(link)}`,
        actorId: principal.userId,
      });
    });

    await this.audit.record({
      action: 'lead.contact_primary_changed',
      entityType: 'lead',
      entityId: leadId,
      after: { linkId },
    });
    return (await this.repository.listForLead(leadId)).map(toLinkView);
  }

  /**
   * Inactive, not deleted: calls already logged with this person must still
   * say who was spoken to. If they were primary, the longest-standing active
   * contact takes over, so the lead never silently loses its primary.
   */
  async deactivate(
    leadId: string,
    linkId: string,
    principal: TenantPrincipal,
  ): Promise<LeadContactView[]> {
    await this.requireVisibleLead(leadId, principal);

    await this.inLock(leadId, async (tx) => {
      const link = await this.requireLink(tx, leadId, linkId);
      if (link.inactiveAt) return;

      await this.repository.updateLink(
        tx,
        linkId,
        { inactiveAt: new Date(), inactiveBy: principal.userId, isPrimary: false },
        principal.userId,
      );

      let promoted: LinkRow | null = null;
      if (link.isPrimary) {
        promoted = await this.repository.oldestActive(tx, leadId, linkId);
        if (promoted) await this.repository.setPrimary(tx, leadId, promoted.id, principal.userId);
      }

      await this.followUps.recordLeadActivity(tx, {
        leadId,
        activityType: 'LEAD_UPDATED',
        description:
          `Contact marked inactive: ${describe(link)}` +
          (promoted ? `. Primary contact is now ${describe(promoted)}` : ''),
        actorId: principal.userId,
      });
    });

    await this.audit.record({
      action: 'lead.contact_deactivated',
      entityType: 'lead',
      entityId: leadId,
      after: { linkId },
    });
    return (await this.repository.listForLead(leadId)).map(toLinkView);
  }

  async reactivate(
    leadId: string,
    linkId: string,
    principal: TenantPrincipal,
  ): Promise<LeadContactView[]> {
    await this.requireVisibleLead(leadId, principal);

    await this.inLock(leadId, async (tx) => {
      const link = await this.requireLink(tx, leadId, linkId);
      if (!link.inactiveAt) return;
      if ((await this.repository.countActive(tx, leadId)) >= MAX_LEAD_CONTACTS) {
        throw AppException.validation(
          `A lead can have at most ${MAX_LEAD_CONTACTS} active contacts.`,
          {
            contacts: ['mark someone else inactive first'],
          },
        );
      }

      const becomesPrimary = !(await this.repository.hasPrimary(tx, leadId));
      await this.repository.updateLink(
        tx,
        linkId,
        { inactiveAt: null, inactiveBy: null, isPrimary: becomesPrimary },
        principal.userId,
      );
      await this.followUps.recordLeadActivity(tx, {
        leadId,
        activityType: 'LEAD_UPDATED',
        description: `Contact marked active: ${describe(link)}${becomesPrimary ? ' (primary)' : ''}`,
        actorId: principal.userId,
      });
    });

    return (await this.repository.listForLead(leadId)).map(toLinkView);
  }

  // ---------------------------------------------------------------------------
  // Used by lead creation, follow-ups and call logging
  // ---------------------------------------------------------------------------

  /**
   * Checks the extra people sent with a NEW lead before the lead is written,
   * so a bad number or a repeated person fails the request instead of leaving
   * a lead with half its contacts. Returns them normalised.
   */
  async prepareForCreate(
    enquirer: { mobile: string | null; email: string | null },
    extras: LeadContactInputDto[],
  ): Promise<
    Array<PersonFields & { firstName: string; notes: string | null; isPrimary: boolean }>
  > {
    if (extras.filter((c) => c.isPrimary).length > 1) {
      throw AppException.validation('Only one contact can be primary.', {
        additionalContacts: ['choose a single primary contact'],
      });
    }
    const seenPhones = new Set([enquirer.mobile].filter((p): p is string => !!p));
    const seenEmails = new Set([enquirer.email?.toLowerCase()].filter((e): e is string => !!e));
    const out = [];
    for (const [index, extra] of extras.entries()) {
      const person = await this.normalisePerson(extra);
      for (const phone of [person.mobile, person.whatsapp]) {
        if (!phone) continue;
        if (seenPhones.has(phone)) {
          throw AppException.validation('The same phone number is entered for two contacts.', {
            [`additionalContacts.${index}.mobile`]: [`${phone} is already given above`],
          });
        }
        seenPhones.add(phone);
      }
      if (person.email) {
        if (seenEmails.has(person.email)) {
          throw AppException.validation('The same email is entered for two contacts.', {
            [`additionalContacts.${index}.email`]: [`${person.email} is already given above`],
          });
        }
        seenEmails.add(person.email);
      }
      out.push({ ...person, notes: extra.notes ?? null, isPrimary: extra.isPrimary === true });
    }
    return out;
  }

  /** Links the prepared extras to a lead that was just created, in one commit. */
  async addOnCreate(
    lead: { id: string; accountId: string | null; companyName: string | null },
    people: Awaited<ReturnType<LeadContactsService['prepareForCreate']>>,
    actorId: string,
  ): Promise<void> {
    if (people.length === 0) return;
    await this.inLock(lead.id, async (tx) => {
      for (const { notes, isPrimary, ...person } of people) {
        await this.linkPerson(tx, {
          leadId: lead.id,
          accountId: lead.accountId,
          companyName: lead.companyName,
          person,
          notes,
          makePrimary: isPrimary,
          // Repeats inside the request were refused by prepareForCreate. A
          // lookalike elsewhere at the company is not a reason to fail a lead
          // that has already been created.
          allowDuplicate: true,
          actorId,
        });
      }
      await this.followUps.recordLeadActivity(tx, {
        leadId: lead.id,
        activityType: 'LEAD_UPDATED',
        description: `${people.length} more contact${people.length === 1 ? '' : 's'} added with the lead`,
        actorId,
      });
    });
  }

  /** Phones to E.164 and the shape the repository writes. Throws 422 on a bad number. */
  async normalisePerson(dto: LeadContactInputDto): Promise<PersonFields & { firstName: string }> {
    const mobile = dto.mobile ? await this.toE164(dto.mobile, 'mobile') : null;
    let whatsapp = dto.whatsapp ? await this.toE164(dto.whatsapp, 'whatsapp') : null;
    if (whatsapp && whatsapp === mobile) whatsapp = null;
    return {
      firstName: dto.firstName,
      lastName: dto.lastName ?? null,
      designation: dto.designation ?? null,
      department: dto.department ?? null,
      mobile,
      whatsapp,
      email: dto.email ?? null,
    };
  }

  /**
   * Links one person to a lead inside the caller's transaction (which must
   * hold the lead's lock). Reuses the existing person for a known mobile and
   * fills only the fields they do not have yet -- never overwrites them.
   */
  async linkPerson(
    tx: PrismaTransaction,
    input: {
      leadId: string;
      accountId: string | null;
      companyName: string | null;
      person: PersonFields & { firstName: string };
      notes: string | null;
      makePrimary: boolean;
      allowDuplicate: boolean;
      actorId: string;
    },
  ): Promise<LinkRow> {
    const { person } = input;
    const existing = person.mobile
      ? await this.repository.findPersonByMobile(tx, person.mobile)
      : null;

    if (existing) {
      const already = await this.repository.findLinkByContact(tx, input.leadId, existing.id);
      if (already) {
        throw new AppException(
          ERROR_CODES.DUPLICATE_CONTACT,
          already.inactiveAt
            ? `${describe(already)} is already on this lead, marked inactive. Mark them active instead.`
            : `${describe(already)} is already a contact on this lead.`,
          HttpStatus.CONFLICT,
          {
            linkId: [already.id],
            name: [describe(already)],
            inactive: [String(already.inactiveAt !== null)],
          },
        );
      }
    }

    if (!input.allowDuplicate) {
      const lookalikes = await this.repository.findLookalikes(tx, {
        leadId: input.leadId,
        accountId: input.accountId,
        phones: [person.mobile, person.whatsapp].filter((p): p is string => typeof p === 'string'),
        email: person.email ?? null,
        exceptContactId: existing?.id,
      });
      if (lookalikes.length > 0) throw duplicateWarning(lookalikes);
    }

    let contactId: string;
    if (existing) {
      contactId = existing.id;
      const fill: PersonFields & { accountId?: string } = {};
      for (const key of ['lastName', 'designation', 'department', 'whatsapp', 'email'] as const) {
        if (!existing[key] && person[key]) fill[key] = person[key];
      }
      if (!existing.accountId && input.accountId) fill.accountId = input.accountId;
      if (Object.keys(fill).length > 0)
        await this.repository.updatePerson(tx, contactId, fill, input.actorId);
    } else {
      const created = await this.repository.createPerson(tx, {
        ...person,
        companyName: input.companyName,
        accountId: input.accountId,
        actorId: input.actorId,
      });
      contactId = created.id;
    }

    const becomesPrimary =
      input.makePrimary || !(await this.repository.hasPrimary(tx, input.leadId));
    const link = await this.repository.createLink(tx, {
      leadId: input.leadId,
      contactId,
      isPrimary: false,
      notes: input.notes,
      actorId: input.actorId,
    });
    if (becomesPrimary) await this.repository.setPrimary(tx, input.leadId, link.id, input.actorId);

    return (await this.repository.findLink(tx, input.leadId, link.id)) as LinkRow;
  }

  /**
   * The person a follow-up or call log names, checked to be a POC of THIS
   * lead. Null when none was named. An inactive POC is accepted for a call
   * log (history), refused for something new to schedule.
   */
  async resolveContactRef(
    leadId: string,
    contactId: string | undefined,
    options: { allowInactive: boolean },
    tx?: PrismaTransaction,
  ): Promise<ContactRef | null> {
    if (!contactId) return null;
    const link = await this.repository.activeLinkForContact(leadId, contactId, tx);
    if (!link || (link.inactiveAt && !options.allowInactive)) {
      throw AppException.validation('That person is not an active contact on this lead.', {
        contactId: ['choose one of the lead’s contacts'],
      });
    }
    return toContactRef(link.contact);
  }

  // ---------------------------------------------------------------------------

  private async normaliseChanges(dto: UpdateLeadContactDto) {
    const changes: PersonFields & { notes?: string | null } = {};
    if (dto.firstName !== undefined) changes.firstName = dto.firstName;
    if (dto.lastName !== undefined) changes.lastName = dto.lastName;
    if (dto.designation !== undefined) changes.designation = dto.designation;
    if (dto.department !== undefined) changes.department = dto.department;
    if (dto.email !== undefined) changes.email = dto.email;
    if (dto.notes !== undefined) changes.notes = dto.notes;
    if (dto.mobile !== undefined)
      changes.mobile = dto.mobile ? await this.toE164(dto.mobile, 'mobile') : null;
    if (dto.whatsapp !== undefined) {
      changes.whatsapp = dto.whatsapp ? await this.toE164(dto.whatsapp, 'whatsapp') : null;
    }
    return changes;
  }

  private async toE164(input: string, field: string): Promise<string> {
    const country = await this.leads.organizationCountry();
    try {
      return toE164(input, country);
    } catch (error) {
      if (error instanceof PhoneParseError) {
        throw AppException.validation('Invalid phone number.', { [field]: [error.message] });
      }
      throw error;
    }
  }

  /** The lead's lock for the whole change; a lost race on the primary index becomes a 409. */
  private async inLock<T>(leadId: string, work: (tx: PrismaTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.followUps.inLeadTransaction(leadId, async (tx, lead) => {
        if (!lead) throw AppException.leadNotFound();
        return work(tx);
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        throw AppException.conflict(
          ERROR_CODES.CONFLICT,
          'Someone else changed this lead’s contacts at the same moment. Refresh and try again.',
        );
      }
      throw error;
    }
  }

  private async requireLink(
    tx: PrismaTransaction,
    leadId: string,
    linkId: string,
  ): Promise<LinkRow> {
    const link = await this.repository.findLink(tx, leadId, linkId);
    if (!link)
      throw AppException.notFound(
        ERROR_CODES.LEAD_CONTACT_NOT_FOUND,
        'Contact not found on this lead.',
      );
    return link;
  }

  /** Same visibility as the lead itself: a 404, like another tenant's lead. */
  private async requireVisibleLead(leadId: string, principal: TenantPrincipal) {
    const lead = await this.leads.findById(leadId, visibilityFilter(principal)?.assignedToId);
    if (!lead) throw AppException.leadNotFound();
    return lead;
  }
}

function personName(contact: { firstName: string | null; lastName: string | null }): string {
  return [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() || '(no name)';
}

function describe(link: { contact: LinkRow['contact'] }): string {
  const name = personName(link.contact);
  return link.contact.designation ? `${name}, ${link.contact.designation}` : name;
}

function duplicateWarning(lookalikes: LinkRow['contact'][]): AppException {
  const names = lookalikes.map((c) => personName(c));
  return new AppException(
    ERROR_CODES.DUPLICATE_CONTACT,
    `${names.join(', ')} already ${names.length === 1 ? 'has' : 'have'} this phone number or email at this company. ` +
      'Add anyway only if this is a different person.',
    HttpStatus.CONFLICT,
    { matches: names, contactIds: lookalikes.map((c) => c.id) },
  );
}

export function toContactRef(contact: LinkRow['contact']): ContactRef {
  return {
    id: contact.id,
    name: personName(contact),
    designation: contact.designation,
    mobile: contact.mobile,
  };
}

export function toLinkView(link: LinkRow): LeadContactView {
  return {
    id: link.id,
    contactId: link.contactId,
    name: personName(link.contact),
    firstName: link.contact.firstName,
    lastName: link.contact.lastName,
    designation: link.contact.designation,
    department: link.contact.department,
    mobile: link.contact.mobile,
    whatsapp: link.contact.whatsapp,
    email: link.contact.email,
    notes: link.notes,
    isPrimary: link.isPrimary,
    active: link.inactiveAt === null,
    inactiveAt: link.inactiveAt?.toISOString() ?? null,
    createdAt: link.createdAt.toISOString(),
    updatedAt: link.updatedAt.toISOString(),
  };
}
