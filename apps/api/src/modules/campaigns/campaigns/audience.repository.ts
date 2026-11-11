import { Injectable } from '@nestjs/common';
import type { EmailRecipientFilter } from '@leadflow/api-types';
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

  async candidates(filter: EmailRecipientFilter): Promise<AudienceCandidate[]> {
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
