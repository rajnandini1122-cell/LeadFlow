import { Injectable } from '@nestjs/common';
import { PrismaService, type PrismaTransaction } from '../../../common/prisma/prisma.service';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service';

/** What the API returns about the person behind a link. */
export const CONTACT_FIELDS = {
  id: true,
  firstName: true,
  lastName: true,
  designation: true,
  department: true,
  mobile: true,
  whatsapp: true,
  email: true,
  accountId: true,
} as const;

export const LINK_INCLUDE = { contact: { select: CONTACT_FIELDS } } as const;

export type LinkRow = {
  id: string;
  leadId: string;
  contactId: string;
  isPrimary: boolean;
  notes: string | null;
  inactiveAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  contact: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    designation: string | null;
    department: string | null;
    mobile: string | null;
    whatsapp: string | null;
    email: string | null;
    accountId: string | null;
  };
};

/** Person fields a link edit may write. */
export type PersonFields = Partial<{
  firstName: string;
  lastName: string | null;
  designation: string | null;
  department: string | null;
  mobile: string | null;
  whatsapp: string | null;
  email: string | null;
}>;

/**
 * Points of contact on a lead.
 *
 * Every write takes the caller's transaction: the service holds the LEAD's row
 * lock (FollowUpsRepository.inLeadTransaction) for the whole change, so two
 * people editing the same lead's contacts are serialised, and "unset the old
 * primary, set the new one" can never interleave with another request. The
 * partial unique index `lead_contacts_one_primary` is the backstop if anything
 * ever writes without that lock.
 */
@Injectable()
export class LeadContactsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Primary first, then active, then oldest -- the order people expect. */
  async listForLead(leadId: string, tx?: PrismaTransaction): Promise<LinkRow[]> {
    return (tx ?? this.prisma.client).leadContact.findMany({
      where: { leadId },
      include: LINK_INCLUDE,
      orderBy: [
        { isPrimary: 'desc' },
        { inactiveAt: { sort: 'asc', nulls: 'first' } },
        { createdAt: 'asc' },
      ],
    });
  }

  async findLink(tx: PrismaTransaction, leadId: string, linkId: string): Promise<LinkRow | null> {
    return tx.leadContact.findFirst({ where: { id: linkId, leadId }, include: LINK_INCLUDE });
  }

  async findLinkByContact(tx: PrismaTransaction, leadId: string, contactId: string) {
    return tx.leadContact.findFirst({ where: { leadId, contactId }, include: LINK_INCLUDE });
  }

  async countActive(tx: PrismaTransaction, leadId: string): Promise<number> {
    return tx.leadContact.count({ where: { leadId, inactiveAt: null } });
  }

  async hasPrimary(tx: PrismaTransaction, leadId: string): Promise<boolean> {
    return (await tx.leadContact.count({ where: { leadId, isPrimary: true } })) > 0;
  }

  /**
   * A lead created by code that predates POCs (or by the previous API during a
   * deploy) has a contact but no link. Give it one, as primary, so every lead
   * that has a person shows that person. Idempotent: the unique (lead, contact)
   * index makes a concurrent second call a no-op.
   */
  async ensureLegacyLink(leadId: string, contactId: string): Promise<void> {
    const client = this.prisma.client;
    if ((await client.leadContact.count({ where: { leadId } })) > 0) return;
    await client.leadContact.createMany({
      data: [
        {
          organizationId: this.tenantContext.requireOrganizationId(),
          leadId,
          contactId,
          isPrimary: true,
        },
      ],
      skipDuplicates: true,
    });
  }

  /** A live (not merged, not deleted) person with this E.164 number. */
  async findPersonByMobile(tx: PrismaTransaction, mobile: string) {
    return tx.contact.findFirst({
      where: { mobile, deletedAt: null, mergedIntoId: null },
      select: CONTACT_FIELDS,
      orderBy: { createdAt: 'asc' },
    });
  }

  async createPerson(
    tx: PrismaTransaction,
    input: PersonFields & {
      firstName: string;
      companyName?: string | null;
      accountId?: string | null;
      actorId: string | null;
    },
  ) {
    return tx.contact.create({
      data: {
        organizationId: this.tenantContext.requireOrganizationId(),
        firstName: input.firstName,
        lastName: input.lastName ?? null,
        designation: input.designation ?? null,
        department: input.department ?? null,
        mobile: input.mobile ?? null,
        whatsapp: input.whatsapp ?? null,
        email: input.email ?? null,
        companyName: input.companyName ?? null,
        accountId: input.accountId ?? null,
        createdBy: input.actorId,
        updatedBy: input.actorId,
      },
      select: CONTACT_FIELDS,
    });
  }

  async updatePerson(
    tx: PrismaTransaction,
    contactId: string,
    data: PersonFields & { accountId?: string },
    actorId: string,
  ) {
    await tx.contact.updateMany({
      where: { id: contactId },
      data: { ...data, updatedBy: actorId },
    });
  }

  async createLink(
    tx: PrismaTransaction,
    input: {
      leadId: string;
      contactId: string;
      isPrimary: boolean;
      notes?: string | null;
      actorId: string | null;
    },
  ) {
    return tx.leadContact.create({
      data: {
        organizationId: this.tenantContext.requireOrganizationId(),
        leadId: input.leadId,
        contactId: input.contactId,
        isPrimary: input.isPrimary,
        notes: input.notes ?? null,
        createdBy: input.actorId,
        updatedBy: input.actorId,
      },
      include: LINK_INCLUDE,
    });
  }

  async updateLink(
    tx: PrismaTransaction,
    linkId: string,
    data: {
      notes?: string | null;
      inactiveAt?: Date | null;
      inactiveBy?: string | null;
      isPrimary?: boolean;
    },
    actorId: string | null,
  ) {
    await tx.leadContact.updateMany({
      where: { id: linkId },
      data: { ...data, updatedBy: actorId },
    });
  }

  /**
   * Makes `linkId` the only primary on the lead. Clear first, then set: with
   * the partial unique index, setting first would collide with the old one.
   */
  async setPrimary(tx: PrismaTransaction, leadId: string, linkId: string, actorId: string | null) {
    await tx.leadContact.updateMany({
      where: { leadId, isPrimary: true, NOT: { id: linkId } },
      data: { isPrimary: false, updatedBy: actorId },
    });
    await tx.leadContact.updateMany({
      where: { id: linkId, leadId, inactiveAt: null },
      data: { isPrimary: true, updatedBy: actorId },
    });
  }

  /** The longest-standing active person, to promote when the primary leaves. */
  async oldestActive(tx: PrismaTransaction, leadId: string, exceptLinkId: string) {
    return tx.leadContact.findFirst({
      where: { leadId, inactiveAt: null, NOT: { id: exceptLinkId } },
      orderBy: { createdAt: 'asc' },
      include: LINK_INCLUDE,
    });
  }

  /**
   * Active people on this lead -- and, when the lead belongs to a company, at
   * that company -- who share a phone number or email with the input. The
   * DUPLICATE_CONTACT warning is built from these.
   */
  async findLookalikes(
    tx: PrismaTransaction,
    input: {
      leadId: string;
      accountId: string | null;
      phones: string[];
      email: string | null;
      exceptContactId?: string | undefined;
    },
  ) {
    const or: Record<string, unknown>[] = [];
    if (input.phones.length > 0) {
      or.push({ mobile: { in: input.phones } }, { whatsapp: { in: input.phones } });
    }
    if (input.email) or.push({ email: input.email });
    if (or.length === 0) return [];

    const scope: Record<string, unknown>[] = [
      { leadLinks: { some: { leadId: input.leadId, inactiveAt: null } } },
    ];
    if (input.accountId) scope.push({ accountId: input.accountId });

    return tx.contact.findMany({
      where: {
        deletedAt: null,
        mergedIntoId: null,
        ...(input.exceptContactId ? { NOT: { id: input.exceptContactId } } : {}),
        AND: [{ OR: scope }, { OR: or }],
      },
      select: CONTACT_FIELDS,
      take: 5,
    });
  }

  /** Is this person an active POC on this lead? For follow-ups and call logs. */
  async activeLinkForContact(leadId: string, contactId: string, tx?: PrismaTransaction) {
    return (tx ?? this.prisma.client).leadContact.findFirst({
      where: { leadId, contactId },
      include: LINK_INCLUDE,
    });
  }
}

/** Re-exported so the service can name the transaction type without importing Prisma. */
export type { PrismaTransaction };
