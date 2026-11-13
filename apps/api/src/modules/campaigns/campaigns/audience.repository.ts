import { Injectable } from '@nestjs/common';
import type { EmailAudienceOptions, EmailRecipientFilter } from '@leadflow/api-types';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type {
  LeadPriority,
  LeadQualification,
  LeadStatus,
  Prisma,
} from '../../../generated/prisma/client';

/** The most addresses one campaign may reach. A larger audience is several campaigns. */
export const MAX_AUDIENCE = 5000;

export interface AudienceCandidate {
  email: string | null;
  leadId: string | null;
  contactId: string | null;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  city: string | null;
}

const insensitiveIn = (values: string[]) => ({
  in: values.map((v) => v.trim()).filter(Boolean),
  mode: 'insensitive' as const,
});

/**
 * Who a campaign filter matches, read through the tenant-scoped client: a
 * filter can only ever reach this organization's own leads and contacts,
 * whatever ids it names.
 */
@Injectable()
export class AudienceRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * A custom list: exactly these addresses, in the order given. Each is linked
   * to this organization's own lead (or else contact) with that address, so
   * the email still lands in that lead's history; an address nobody here has
   * is sent to as-is, with no lead. Matching runs through the tenant-scoped
   * client, so another organization's leads are never linked.
   */
  private async customCandidates(emails: string[]): Promise<AudienceCandidate[]> {
    const list = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))].slice(
      0,
      MAX_AUDIENCE + 1,
    );
    if (list.length === 0) return [];
    const [leads, contacts] = await Promise.all([
      this.prisma.client.lead.findMany({
        where: {
          deletedAt: null,
          deactivatedAt: null,
          email: { in: list, mode: 'insensitive' },
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          companyName: true,
          city: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.client.contact.findMany({
        where: { deletedAt: null, mergedIntoId: null, email: { in: list, mode: 'insensitive' } },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          companyName: true,
          city: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const byLead = new Map<string, (typeof leads)[number]>();
    for (const l of leads) {
      const key = (l.email ?? '').toLowerCase();
      if (key && !byLead.has(key)) byLead.set(key, l);
    }
    const byContact = new Map<string, (typeof contacts)[number]>();
    for (const c of contacts) {
      const key = (c.email ?? '').toLowerCase();
      if (key && !byContact.has(key)) byContact.set(key, c);
    }
    return list.map((email): AudienceCandidate => {
      const lead = byLead.get(email);
      if (lead) {
        return {
          email,
          leadId: lead.id,
          contactId: null,
          firstName: lead.firstName,
          lastName: lead.lastName,
          company: lead.companyName,
          city: lead.city,
        };
      }
      const contact = byContact.get(email);
      return {
        email,
        leadId: null,
        contactId: contact?.id ?? null,
        firstName: contact?.firstName ?? null,
        lastName: contact?.lastName ?? null,
        company: contact?.companyName ?? null,
        city: contact?.city ?? null,
      };
    });
  }

  /** Cities (with how many leads that have an email) and contact history, for filter checkboxes. */
  async options(): Promise<EmailAudienceOptions> {
    const base: Prisma.LeadWhereInput = {
      deletedAt: null,
      deactivatedAt: null,
      email: { not: null },
    };
    const [byCity, never, total] = await Promise.all([
      this.prisma.client.lead.groupBy({
        by: ['city'],
        where: { ...base, city: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.client.lead.count({ where: { ...base, lastContactedAt: null } }),
      this.prisma.client.lead.count({ where: base }),
    ]);
    // Same city typed differently ("Pune", "pune ") counts as one.
    const merged = new Map<string, { name: string; count: number }>();
    for (const row of byCity) {
      const name = (row.city ?? '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const entry = merged.get(key) ?? { name, count: 0 };
      entry.count += row._count._all;
      merged.set(key, entry);
    }
    return {
      cities: [...merged.values()]
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
        .slice(0, 300),
      contacted: { never, contacted: total - never },
    };
  }

  async candidates(filter: EmailRecipientFilter): Promise<AudienceCandidate[]> {
    if (filter.source === 'CUSTOM') return this.customCandidates(filter.customEmails ?? []);
    const where: Prisma.LeadWhereInput = {
      deletedAt: null,
      deactivatedAt: null,
      email: { not: null },
    };
    if (filter.statuses?.length) where.status = { in: filter.statuses as LeadStatus[] };
    if (filter.priorities?.length) where.priority = { in: filter.priorities as LeadPriority[] };
    if (filter.qualifications?.length) {
      where.qualification = { in: filter.qualifications as LeadQualification[] };
    }
    if (filter.sources?.length) where.source = insensitiveIn(filter.sources);
    if (filter.cities?.length) where.city = insensitiveIn(filter.cities);
    const contacted = new Set(filter.contacted ?? []);
    if (contacted.size === 1) {
      where.lastContactedAt = contacted.has('NEVER') ? null : { not: null };
    }
    if (filter.states?.length) where.state = insensitiveIn(filter.states);
    if (filter.countries?.length)
      where.country = { in: filter.countries.map((c) => c.toUpperCase()) };
    if (filter.productIds?.length) where.productId = { in: filter.productIds };
    if (filter.assignedToIds?.length) where.assignedToId = { in: filter.assignedToIds };
    if (filter.industries?.length) where.account = { industry: insensitiveIn(filter.industries) };

    const leads = await this.prisma.client.lead.findMany({
      where,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        companyName: true,
        city: true,
        contactLinks: {
          select: {
            contact: {
              select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                companyName: true,
                city: true,
                deletedAt: true,
                mergedIntoId: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: MAX_AUDIENCE + 1,
    });

    const out: AudienceCandidate[] = [];
    for (const lead of leads) {
      out.push({
        email: lead.email,
        leadId: lead.id,
        contactId: null,
        firstName: lead.firstName,
        lastName: lead.lastName,
        company: lead.companyName,
        city: lead.city,
      });
      if (!filter.includeContacts) continue;
      for (const link of lead.contactLinks as { contact: ContactRow }[]) {
        const contact = link.contact;
        if (contact.deletedAt || contact.mergedIntoId || !contact.email) continue;
        out.push({
          email: contact.email,
          leadId: lead.id,
          contactId: contact.id,
          firstName: contact.firstName,
          lastName: contact.lastName,
          company: contact.companyName ?? lead.companyName,
          city: contact.city ?? lead.city,
        });
      }
    }
    return out;
  }
}

interface ContactRow {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  city: string | null;
  deletedAt: Date | null;
  mergedIntoId: string | null;
}
