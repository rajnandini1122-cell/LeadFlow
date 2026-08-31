import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AccountStatus, OpportunityKind } from '../../generated/prisma/enums';

/**
 * Data access for the retention engine.
 *
 * The whole design constraint is in spec §29: do NOT load every customer, then
 * every lead, then compute in JavaScript. The action queue is the query most
 * likely to become expensive, so it is built as a FIXED number of grouped
 * passes — one page of accounts, then one aggregate per fact across exactly
 * those accounts — rather than a query per customer.
 *
 * Every model here is tenant-scoped by the Prisma extension, so an account id
 * from another organization matches nothing rather than leaking a row.
 */
@Injectable()
export class RetentionRepository {
  constructor(private readonly prisma: PrismaService) {}

  private live() {
    return { deletedAt: null, mergedIntoId: null };
  }

  /**
   * The candidate page for the action queue.
   *
   * Ordered by least-recently-active, because the customer nobody has touched
   * is the one most likely to be forgotten — which is the entire point of the
   * queue. Bounded, and the total is reported so the screen can say how much it
   * is not showing.
   */
  async candidateAccounts(filters: {
    status?: string | undefined;
    limit: number;
    offset: number;
  }) {
    /*
     * Former customers are excluded by default: someone has already decided
     * that relationship is over, and putting them back in a work queue would
     * override a human judgement.
     *
     * Built as ONE shape rather than a union of two — Prisma's Exact<>
     * constraint rejects `{ status } | { status: { in } }` because it cannot
     * prove the absent key is genuinely absent.
     */
    const statuses: AccountStatus[] = filters.status
      ? [filters.status as AccountStatus]
      : ['CUSTOMER', 'DORMANT'];

    const where = { ...this.live(), status: { in: statuses } };

    const [items, total] = await Promise.all([
      this.prisma.client.account.findMany({
        where,
        select: {
          id: true,
          name: true,
          status: true,
          lastWonAt: true,
          lastActivityAt: true,
          firstWonAt: true,
          owner: { select: { id: true, fullName: true } },
        },
        orderBy: [{ lastActivityAt: { sort: 'asc', nulls: 'last' } }],
        take: filters.limit,
        skip: filters.offset,
      }),
      this.prisma.client.account.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Won and open counts for a set of accounts, in two grouped passes.
   *
   * `groupBy` over `accountId IN (…)` rather than a count per account: a page
   * of 50 customers would otherwise be 100 round trips.
   */
  async leadCountsFor(accountIds: string[]) {
    if (accountIds.length === 0) return { won: [], open: [] };

    const [won, open] = await Promise.all([
      this.prisma.client.lead.groupBy({
        by: ['accountId'],
        where: { accountId: { in: accountIds }, status: 'WON', deletedAt: null },
        _count: { _all: true },
        _sum: { wonValue: true },
      }),
      this.prisma.client.lead.groupBy({
        by: ['accountId'],
        where: {
          accountId: { in: accountIds },
          status: { notIn: ['WON', 'LOST'] },
          deletedAt: null,
        },
        _count: { _all: true },
      }),
    ]);

    return { won, open };
  }

  /** Open follow-ups per account, and the soonest one. One grouped pass. */
  async followUpStateFor(accountIds: string[]) {
    if (accountIds.length === 0) return [];

    return this.prisma.client.followUp.groupBy({
      by: ['accountId'],
      where: {
        accountId: { in: accountIds },
        status: { in: ['UPCOMING', 'DUE', 'OVERDUE'] },
      },
      _count: { _all: true },
      _min: { scheduledAt: true },
    });
  }

  /**
   * The product each account has won most, for the repeat suggestion.
   *
   * One grouped pass over won leads, then one lookup for the names that
   * actually appeared. The caller picks the top per account in memory over a
   * result set bounded by the page — not by the catalogue.
   */
  async topWonProductFor(accountIds: string[]) {
    if (accountIds.length === 0) return { rows: [], products: [] };

    const rows = await this.prisma.client.lead.groupBy({
      by: ['accountId', 'productId'],
      where: {
        accountId: { in: accountIds },
        status: 'WON',
        productId: { not: null },
        deletedAt: null,
      },
      _count: { _all: true },
      _max: { wonAt: true },
    });

    const productIds = [
      ...new Set(rows.map((row) => row.productId).filter((id): id is string => id !== null)),
    ];

    const products = productIds.length
      ? await this.prisma.client.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, name: true, sku: true, active: true },
        })
      : [];

    return { rows, products };
  }

  /**
   * How many ACTIVE products each account has never enquired about.
   *
   * Two passes: the size of the live catalogue, and the distinct products each
   * account has touched. The difference is arithmetic — no per-account
   * catalogue scan.
   */
  async expansionGapsFor(accountIds: string[]): Promise<{
    catalogueSize: number;
    enquiredByAccount: Map<string, number>;
  }> {
    const catalogueSize = await this.prisma.client.product.count({ where: { active: true } });

    if (accountIds.length === 0 || catalogueSize === 0) {
      return { catalogueSize, enquiredByAccount: new Map() };
    }

    const rows = await this.prisma.client.lead.findMany({
      where: { accountId: { in: accountIds }, productId: { not: null }, deletedAt: null },
      select: { accountId: true, productId: true },
      distinct: ['accountId', 'productId'],
    });

    const enquiredByAccount = new Map<string, number>();
    for (const row of rows) {
      if (!row.accountId) continue;
      enquiredByAccount.set(row.accountId, (enquiredByAccount.get(row.accountId) ?? 0) + 1);
    }

    return { catalogueSize, enquiredByAccount };
  }

  // --- repeat business -------------------------------------------------------

  /**
   * What this customer has bought, per product, for the repeat picker.
   *
   * The previous won VALUE is returned so the screen can offer it as context —
   * never copied into the new opportunity without the salesperson confirming
   * it, because an estimate is a forecast and last quarter's price is not.
   */
  async wonProductHistory(accountId: string) {
    const rows = await this.prisma.client.lead.groupBy({
      by: ['productId'],
      where: { accountId, status: 'WON', productId: { not: null }, deletedAt: null },
      _count: { _all: true },
      _max: { wonAt: true },
      _sum: { wonValue: true },
    });

    const productIds = rows
      .map((row) => row.productId)
      .filter((id): id is string => id !== null);

    const products = productIds.length
      ? await this.prisma.client.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, name: true, sku: true, active: true },
        })
      : [];

    // The most recent won value per product, which is the figure worth showing
    // as context. A sum across three deals is not "what they paid last time".
    const latest = productIds.length
      ? await this.prisma.client.lead.findMany({
          where: { accountId, status: 'WON', productId: { in: productIds }, deletedAt: null },
          select: { productId: true, wonValue: true, wonAt: true },
          orderBy: { wonAt: 'desc' },
          take: 100,
        })
      : [];

    return { rows, products, latest };
  }

  /** Won opportunities for this account, and whether a given product is among them. */
  async winHistoryFor(accountId: string, productId: string | null) {
    const [accountWonCount, productWon] = await Promise.all([
      this.prisma.client.lead.count({
        where: { accountId, status: 'WON', deletedAt: null },
      }),
      productId
        ? this.prisma.client.lead.count({
            where: { accountId, productId, status: 'WON', deletedAt: null },
          })
        : Promise.resolve(0),
    ]);

    return { accountWonCount, productWonBefore: productWon > 0 };
  }

  /**
   * Confirms a contact belongs to THIS account.
   *
   * Not merely to this tenant. Filing ABC Foods' repeat order under a contact
   * at XYZ passes every tenant check — same organization, real contact — and
   * puts the enquiry against the wrong human being, where nobody looking at
   * either customer would see it.
   */
  async contactBelongsToAccount(contactId: string, accountId: string): Promise<boolean> {
    const contact = await this.prisma.client.contact.findFirst({
      where: { id: contactId, accountId, deletedAt: null },
      select: { id: true },
    });
    return contact !== null;
  }

  /** The account's own details, for pre-filling the repeat opportunity. */
  async accountForRepeat(accountId: string) {
    return this.prisma.client.account.findFirst({
      where: { id: accountId, deletedAt: null, mergedIntoId: null },
      select: {
        id: true,
        name: true,
        status: true,
        phone: true,
        email: true,
        city: true,
        ownerId: true,
        firstWonAt: true,
      },
    });
  }

  /** A contact to attach when the caller did not name one. */
  async defaultContactFor(accountId: string) {
    return this.prisma.client.contact.findFirst({
      where: { accountId, deletedAt: null, mergedIntoId: null },
      select: { id: true, firstName: true, lastName: true, mobile: true, email: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  // --- KPI -------------------------------------------------------------------

  /** Opportunity counts by kind, per product. One grouped pass. */
  async demandByKind(range?: { from: Date; to: Date }) {
    return this.prisma.client.lead.groupBy({
      by: ['productId', 'opportunityKind'],
      where: {
        deletedAt: null,
        productId: { not: null },
        ...(range ? { createdAt: { gte: range.from, lt: range.to } } : {}),
      },
      _count: { _all: true },
      _sum: { wonValue: true },
    });
  }

  /** Tenant-wide counts by kind, for the retention summary. */
  async countsByKind(range?: { from: Date; to: Date }) {
    return this.prisma.client.lead.groupBy({
      by: ['opportunityKind'],
      where: {
        deletedAt: null,
        ...(range ? { createdAt: { gte: range.from, lt: range.to } } : {}),
      },
      _count: { _all: true },
      _sum: { wonValue: true },
    });
  }

  /** Won value for one kind of business, for expansion revenue. */
  async wonValueByKind(kind: OpportunityKind, range?: { from: Date; to: Date }) {
    return this.prisma.client.lead.aggregate({
      where: {
        deletedAt: null,
        status: 'WON',
        opportunityKind: kind,
        ...(range ? { wonAt: { gte: range.from, lt: range.to } } : {}),
      },
      _count: { _all: true },
      _sum: { wonValue: true },
    });
  }

  /** How many leads carry no classification at all — the coverage figure. */
  async unclassifiedLeads(): Promise<number> {
    return this.prisma.client.lead.count({
      where: { deletedAt: null, opportunityKind: null },
    });
  }

  /**
   * Records what kind of business an opportunity was.
   *
   * Written once, immediately after creation, and never revised. `updateMany`
   * so the tenant extension narrows it.
   */
  async classify(leadId: string, kind: OpportunityKind | null): Promise<void> {
    if (!kind) return;

    await this.prisma.client.lead.updateMany({
      where: { id: leadId },
      data: { opportunityKind: kind },
    });
  }

  /** A follow-up, and the account it hangs off. Tenant-scoped. */
  async accountFollowUp(followUpId: string) {
    return this.prisma.client.followUp.findFirst({
      where: { id: followUpId },
      select: { id: true, accountId: true, leadId: true, title: true, notes: true },
    });
  }

  async repeatWindowDays(): Promise<{ dormantAfterDays: number }> {
    const settings = await this.prisma.client.organizationSettings.findFirst({
      select: { accountDormantAfterDays: true },
    });
    return { dormantAfterDays: settings?.accountDormantAfterDays ?? 180 };
  }
}
