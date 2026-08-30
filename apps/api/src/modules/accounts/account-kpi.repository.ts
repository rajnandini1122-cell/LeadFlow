import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Customer and product-by-customer-type aggregation.
 *
 * Everything here is `groupBy`, `aggregate` or `count`. Nothing loads a
 * customer's history into Node to add it up — spec §27, and the reason it
 * matters is that the organizations these figures are most useful to are the
 * ones with the most history.
 *
 * The query count is FIXED, never proportional to the number of accounts or
 * products. Where a name is needed for an id, the ids that actually appeared
 * are collected and resolved in one further `findMany`.
 */
@Injectable()
export class AccountKpiRepository {
  constructor(private readonly prisma: PrismaService) {}

  private live() {
    return { deletedAt: null, mergedIntoId: null };
  }

  async statusCounts() {
    return this.prisma.client.account.groupBy({
      by: ['status'],
      where: this.live(),
      _count: { _all: true },
    });
  }

  /** New customers in a window, by the date they FIRST bought. */
  async newCustomers(from: Date, to: Date): Promise<number> {
    return this.prisma.client.account.count({
      where: { ...this.live(), firstWonAt: { gte: from, lt: to } },
    });
  }

  /**
   * Won-deal counts and values per account, in one grouped pass.
   *
   * The basis for every repeat-business figure: an account appearing with
   * `_count > 1` has bought more than once. Doing this per account would be one
   * query per customer.
   */
  async winsByAccount(range?: { from: Date; to: Date }) {
    return this.prisma.client.lead.groupBy({
      by: ['accountId'],
      where: {
        deletedAt: null,
        status: 'WON',
        accountId: { not: null },
        ...(range ? { wonAt: { gte: range.from, lt: range.to } } : {}),
      },
      _count: { _all: true },
      _sum: { wonValue: true },
    });
  }

  /**
   * Acquisition trend: how many accounts first bought in each bucket.
   *
   * Reads first_won_at for accounts inside the window and buckets them in the
   * service, where the tenant timezone is known. Bounded by the window and
   * selecting ONE column — Prisma cannot date_trunc without `$queryRaw`, which
   * the tenant extension cannot narrow and which is therefore banned.
   */
  async firstWonDates(from: Date, to: Date) {
    return this.prisma.client.account.findMany({
      where: { ...this.live(), firstWonAt: { gte: from, lt: to } },
      select: { firstWonAt: true },
      orderBy: { firstWonAt: 'asc' },
    });
  }

  /** Top customers by won value. Ordered and limited in the database. */
  async topCustomers(limit: number, range?: { from: Date; to: Date }) {
    const grouped = await this.prisma.client.lead.groupBy({
      by: ['accountId'],
      where: {
        deletedAt: null,
        status: 'WON',
        accountId: { not: null },
        ...(range ? { wonAt: { gte: range.from, lt: range.to } } : {}),
      },
      _count: { _all: true },
      _sum: { wonValue: true },
      orderBy: { _sum: { wonValue: 'desc' } },
      take: limit,
    });

    const ids = grouped
      .map((row) => row.accountId)
      .filter((id): id is string => id !== null);

    const accounts = ids.length
      ? await this.prisma.client.account.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, status: true, firstWonAt: true, lastWonAt: true },
        })
      : [];

    return { grouped, accounts };
  }

  /**
   * Product demand split by whether the enquiry came from an existing customer.
   *
   * Grouped on (productId, accountId) so each lead is counted EXACTLY ONCE, and
   * classified in the service against the set of accounts that had already
   * bought. Grouping on a joined status column is not expressible in Prisma
   * without raw SQL.
   *
   * Leads with an account but no product are excluded here; leads with no
   * account at all are counted as `unknown` rather than being attributed to
   * either side, because attributing them would inflate new-business demand
   * with every row the backfill has not reached.
   */
  async demandByProductAndAccount(range?: { from: Date; to: Date }) {
    return this.prisma.client.lead.groupBy({
      by: ['productId', 'accountId'],
      where: {
        deletedAt: null,
        productId: { not: null },
        ...(range ? { createdAt: { gte: range.from, lt: range.to } } : {}),
      },
      _count: { _all: true },
    });
  }

  /**
   * Accounts that had already bought BEFORE a given moment.
   *
   * This is what makes "existing customer demand" honest. A customer who first
   * bought last week was a PROSPECT when they enquired three months ago, and
   * classifying by today's status would rewrite history — every early enquiry
   * from a company that later became a customer would be counted as
   * existing-customer demand, and new-business demand would look like it had
   * collapsed.
   *
   * Returns first-won dates so the service can classify each lead against the
   * state of the world when that lead was created.
   */
  async accountFirstWonDates() {
    return this.prisma.client.account.findMany({
      where: { ...this.live(), firstWonAt: { not: null } },
      select: { id: true, firstWonAt: true },
    });
  }

  /** Product names for the ids that actually appeared. One query. */
  async productsByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return this.prisma.client.product.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, sku: true, category: true, active: true },
    });
  }

  /** Leads with no product at all — the coverage figure for everything above. */
  async leadsWithoutProduct(range?: { from: Date; to: Date }): Promise<number> {
    return this.prisma.client.lead.count({
      where: {
        deletedAt: null,
        productId: null,
        ...(range ? { createdAt: { gte: range.from, lt: range.to } } : {}),
      },
    });
  }

  /** Leads with no account — the coverage figure for the prospect/customer split. */
  async leadsWithoutAccount(range?: { from: Date; to: Date }): Promise<number> {
    return this.prisma.client.lead.count({
      where: {
        deletedAt: null,
        accountId: null,
        ...(range ? { createdAt: { gte: range.from, lt: range.to } } : {}),
      },
    });
  }

  /** Total won value across the tenant, for the repeat-revenue share. */
  async wonValueTotal(range?: { from: Date; to: Date }) {
    return this.prisma.client.lead.aggregate({
      where: {
        deletedAt: null,
        status: 'WON',
        ...(range ? { wonAt: { gte: range.from, lt: range.to } } : {}),
      },
      _count: { _all: true },
      _sum: { wonValue: true },
    });
  }

  /**
   * Every won deal's account and date, ordered, so repeat revenue can be
   * separated from acquisition revenue.
   *
   * "Repeat" means every win after a customer's first, which needs the ORDER of
   * an account's wins — not expressible as a Prisma aggregate. Two columns per
   * won deal only, and won deals are the smallest slice of the lead table.
   */
  async wonDealsForRepeatAnalysis(range?: { from: Date; to: Date }) {
    return this.prisma.client.lead.findMany({
      where: {
        deletedAt: null,
        status: 'WON',
        accountId: { not: null },
        ...(range ? { wonAt: { gte: range.from, lt: range.to } } : {}),
      },
      select: { accountId: true, wonAt: true, wonValue: true },
      orderBy: { wonAt: 'asc' },
    });
  }
}
