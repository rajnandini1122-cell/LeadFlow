import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Data access for the account backfill.
 *
 * Every model here is tenant-scoped, so an id from another organization matches
 * nothing rather than leaking a row — which matters more than usual on this
 * screen, because it is the one place where records are deliberately re-parented
 * in bulk.
 */
@Injectable()
export class AccountMappingRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** How far the backfill has got. Two counts, no rows loaded. */
  async progress(): Promise<{ mapped: number; unmapped: number; total: number }> {
    const [mapped, unmapped] = await Promise.all([
      this.prisma.client.lead.count({ where: { deletedAt: null, accountId: { not: null } } }),
      this.prisma.client.lead.count({ where: { deletedAt: null, accountId: null } }),
    ]);

    return { mapped, unmapped, total: mapped + unmapped };
  }

  /**
   * Leads with no account, newest first.
   *
   * `companyName` is the evidence a person reads to decide, so it is selected
   * even though nothing groups on it in SQL — the grouping happens in
   * account-identity.ts where the normalisation rules are readable.
   */
  async unmappedLeads(filters: { search?: string | undefined; limit: number }) {
    const where = {
      deletedAt: null,
      accountId: null,
      ...(filters.search
        ? {
            OR: [
              { companyName: { contains: filters.search, mode: 'insensitive' as const } },
              { firstName: { contains: filters.search, mode: 'insensitive' as const } },
              { lastName: { contains: filters.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.client.lead.findMany({
        where,
        select: {
          id: true,
          leadNumber: true,
          firstName: true,
          lastName: true,
          companyName: true,
          email: true,
          mobile: true,
          city: true,
          status: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: filters.limit,
      }),
      this.prisma.client.lead.count({ where }),
    ]);

    return { items, total };
  }

  /** Contacts with no account. Same rules, same evidence. */
  async unmappedContacts(filters: { search?: string | undefined; limit: number }) {
    const where = {
      deletedAt: null,
      mergedIntoId: null,
      accountId: null,
      ...(filters.search
        ? { companyName: { contains: filters.search, mode: 'insensitive' as const } }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.client.contact.findMany({
        where,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          companyName: true,
          email: true,
          mobile: true,
          city: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: filters.limit,
      }),
      this.prisma.client.contact.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Unmapped leads that HAVE a company name, for grouping.
   *
   * Leads with no company name are excluded here and reported separately: there
   * is nothing to group them by, and silently dropping them would make the
   * backfill look complete while a pile of records still had no account.
   */
  async unmappedWithCompanyName(limit: number) {
    return this.prisma.client.lead.findMany({
      where: { deletedAt: null, accountId: null, companyName: { not: null } },
      select: {
        id: true,
        leadNumber: true,
        companyName: true,
        email: true,
        mobile: true,
        city: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async unmappedWithoutCompanyNameCount(): Promise<number> {
    return this.prisma.client.lead.count({
      where: { deletedAt: null, accountId: null, companyName: null },
    });
  }

  /**
   * Attaches leads to an account.
   *
   * `updateMany` with both the ids and the account in a scoped query: a lead id
   * from another tenant matches nothing, so the count comes back lower and the
   * caller is told how many actually moved rather than being lied to.
   *
   * Only touches leads that currently have NO account. Re-parenting one that is
   * already attached is a different operation with different consequences, and
   * it must not happen as a side effect of a bulk classify.
   */
  async assignLeadsToAccount(input: {
    accountId: string;
    leadIds: string[];
    actorId: string;
  }): Promise<number> {
    const result = await this.prisma.client.lead.updateMany({
      where: { id: { in: input.leadIds }, accountId: null, deletedAt: null },
      data: { accountId: input.accountId, updatedBy: input.actorId },
    });
    return result.count;
  }

  async assignContactsToAccount(input: {
    accountId: string;
    contactIds: string[];
    actorId: string;
  }): Promise<number> {
    const result = await this.prisma.client.contact.updateMany({
      where: { id: { in: input.contactIds }, accountId: null, deletedAt: null },
      data: { accountId: input.accountId, updatedBy: input.actorId },
    });
    return result.count;
  }

  /** Confirms an account id belongs to this tenant before anything is re-parented. */
  async accountExists(accountId: string): Promise<boolean> {
    const account = await this.prisma.client.account.findFirst({
      where: { id: accountId, deletedAt: null },
      select: { id: true },
    });
    return account !== null;
  }

  /** Live accounts reduced to the fields the matcher compares. */
  async matchCandidates(limit = 5000) {
    return this.prisma.client.account.findMany({
      where: { deletedAt: null, mergedIntoId: null },
      select: { id: true, name: true, normalizedName: true, domain: true, phone: true, status: true },
      take: limit,
    });
  }

  async leadCompanyName(leadId: string) {
    return this.prisma.client.lead.findFirst({
      where: { id: leadId, deletedAt: null },
      select: { id: true, companyName: true, email: true, mobile: true, accountId: true },
    });
  }
}
