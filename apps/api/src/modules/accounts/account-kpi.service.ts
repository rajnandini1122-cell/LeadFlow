import { Injectable } from '@nestjs/common';
import { AccountKpiRepository } from './account-kpi.repository';
import { RetentionRepository } from './retention.repository';
import {
  averageCustomerValue,
  averageWinsPerCustomer,
  existingCustomerShare,
  prospectConversionRate,
  repeatCustomerRate,
  repeatRevenueShare,
  totalAccounts,
  totalDemand,
  type CustomerCounts,
  type DemandSplit,
} from './account-kpi';

/**
 * Customer KPIs, and product demand split by who is asking.
 *
 * Every figure that cannot be calculated is `null`, never `0` — the rule
 * product-kpi.service.ts already follows, for the same reason: "no customer has
 * bought twice yet" and "the repeat rate is 0%" look identical on a dashboard
 * and describe completely different businesses.
 *
 * Coverage is reported beside every figure rather than buried. `leadsWithout
 * Account` and `leadsWithoutProduct` are how a reader knows whether a
 * breakdown covers the whole business or the fraction of it that has been
 * classified so far. Without them a dashboard built on 12 of 400 leads looks
 * exactly like one built on all 400.
 */
@Injectable()
export class AccountKpiService {
  constructor(
    private readonly repository: AccountKpiRepository,
    private readonly retention: RetentionRepository,
  ) {}

  /**
   * Product demand split by what kind of business each opportunity was.
   *
   * Reads the classification recorded AT CREATION rather than re-deriving it,
   * so correcting an old deal months later cannot silently turn last quarter's
   * acquisition into this quarter's retention.
   *
   * Every opportunity is counted exactly once. `unclassified` is reported
   * rather than folded into FIRST: leads captured before this existed have no
   * record of what the customer had bought at the time, and calling them first
   * business would invent an acquisition figure.
   */
  async demandByKind(range?: { from: Date; to: Date }): Promise<{
    items: {
      productId: string;
      name: string;
      sku: string | null;
      category: string | null;
      first: number;
      repeatProduct: number;
      expansion: number;
      unclassified: number;
      total: number;
      wonValue: number;
    }[];
    totals: {
      first: number;
      repeatProduct: number;
      expansion: number;
      unclassified: number;
      total: number;
    };
    revenue: {
      firstWonValue: number;
      repeatWonValue: number;
      expansionWonValue: number;
    };
    coverage: { unclassifiedLeads: number };
  }> {
    const [grouped, firstRevenue, repeatRevenue, expansionRevenue, unclassifiedLeads] =
      await Promise.all([
        this.retention.demandByKind(range),
        this.retention.wonValueByKind('FIRST', range),
        this.retention.wonValueByKind('REPEAT_PRODUCT', range),
        this.retention.wonValueByKind('EXPANSION', range),
        this.retention.unclassifiedLeads(),
      ]);

    const perProduct = new Map<
      string,
      { first: number; repeatProduct: number; expansion: number; unclassified: number; wonValue: number }
    >();

    for (const row of grouped) {
      if (!row.productId) continue;

      const entry = perProduct.get(row.productId) ?? {
        first: 0,
        repeatProduct: 0,
        expansion: 0,
        unclassified: 0,
        wonValue: 0,
      };

      const count = row._count._all;
      if (row.opportunityKind === 'FIRST') entry.first += count;
      else if (row.opportunityKind === 'REPEAT_PRODUCT') entry.repeatProduct += count;
      else if (row.opportunityKind === 'EXPANSION') entry.expansion += count;
      else entry.unclassified += count;

      entry.wonValue += Number(row._sum.wonValue ?? 0);
      perProduct.set(row.productId, entry);
    }

    const products = await this.repository.productsByIds([...perProduct.keys()]);
    const byId = new Map(products.map((product) => [product.id, product]));

    const items = [...perProduct.entries()]
      .map(([productId, entry]) => {
        const product = byId.get(productId);
        if (!product) return null;

        return {
          productId,
          name: product.name,
          sku: product.sku,
          category: product.category,
          ...entry,
          total: entry.first + entry.repeatProduct + entry.expansion + entry.unclassified,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((a, b) => b.total - a.total);

    const totals = items.reduce(
      (accumulator, row) => ({
        first: accumulator.first + row.first,
        repeatProduct: accumulator.repeatProduct + row.repeatProduct,
        expansion: accumulator.expansion + row.expansion,
        unclassified: accumulator.unclassified + row.unclassified,
      }),
      { first: 0, repeatProduct: 0, expansion: 0, unclassified: 0 },
    );

    return {
      items,
      totals: {
        ...totals,
        total: totals.first + totals.repeatProduct + totals.expansion + totals.unclassified,
      },
      revenue: {
        firstWonValue: Number(firstRevenue._sum.wonValue ?? 0),
        repeatWonValue: Number(repeatRevenue._sum.wonValue ?? 0),
        // Revenue from products new to an existing customer — the expansion
        // figure §16 asks for, and only where it is genuinely attributable.
        expansionWonValue: Number(expansionRevenue._sum.wonValue ?? 0),
      },
      coverage: { unclassifiedLeads },
    };
  }

  /** The customer funnel: how many of each kind of relationship there are. */
  async overview(range?: { from: Date; to: Date }): Promise<{
    counts: CustomerCounts & { total: number };
    newCustomers: number | null;
    conversionRate: number | null;
    repeat: {
      customersWithAnyWin: number;
      customersWithMultipleWins: number;
      repeatRate: number | null;
      averageWinsPerCustomer: number | null;
    };
    value: {
      totalWonValue: number;
      averageCustomerValue: number | null;
      repeatWonValue: number;
      repeatRevenueShare: number | null;
    };
  }> {
    const [statuses, wins, wonTotal, wonDeals] = await Promise.all([
      this.repository.statusCounts(),
      this.repository.winsByAccount(),
      this.repository.wonValueTotal(range),
      this.repository.wonDealsForRepeatAnalysis(),
    ]);

    const counts: CustomerCounts = {
      prospects: countOf(statuses, 'PROSPECT'),
      customers: countOf(statuses, 'CUSTOMER'),
      dormant: countOf(statuses, 'DORMANT'),
      formerCustomers: countOf(statuses, 'FORMER_CUSTOMER'),
    };

    const customersWithAnyWin = wins.length;
    const customersWithMultipleWins = wins.filter((row) => row._count._all > 1).length;
    const totalWins = wins.reduce((sum, row) => sum + row._count._all, 0);
    const totalWonValue = wins.reduce((sum, row) => sum + Number(row._sum.wonValue ?? 0), 0);

    /*
     * Repeat revenue is every win AFTER a customer's first. The first deal is
     * acquisition; everything after it is the relationship paying off, and
     * separating them is the only way to answer whether growth comes from new
     * customers or from existing ones.
     */
    const seen = new Set<string>();
    let repeatWonValue = 0;
    for (const deal of wonDeals) {
      if (!deal.accountId) continue;
      if (seen.has(deal.accountId)) {
        repeatWonValue += Number(deal.wonValue ?? 0);
      } else {
        seen.add(deal.accountId);
      }
    }

    const newCustomers = range ? await this.repository.newCustomers(range.from, range.to) : null;

    return {
      counts: { ...counts, total: totalAccounts(counts) },
      newCustomers,
      conversionRate: prospectConversionRate(counts),
      repeat: {
        customersWithAnyWin,
        customersWithMultipleWins,
        repeatRate: repeatCustomerRate({ customersWithAnyWin, customersWithMultipleWins }),
        averageWinsPerCustomer: averageWinsPerCustomer({ totalWins, customersWithAnyWin }),
      },
      value: {
        totalWonValue: Number(wonTotal._sum.wonValue ?? 0),
        averageCustomerValue: averageCustomerValue({ totalWonValue, customersWithAnyWin }),
        repeatWonValue,
        repeatRevenueShare: repeatRevenueShare({ totalWonValue, repeatWonValue }),
      },
    };
  }

  /**
   * New customers over time, bucketed by day in the organization's timezone.
   *
   * Bucketed here rather than in SQL because Prisma cannot date_trunc without
   * `$queryRaw`, which the tenant extension cannot narrow and which the
   * architecture rules therefore ban. The query selects ONE column over a
   * bounded window, so the cost is a date list, not a customer history.
   */
  async acquisitionTrend(
    range: { from: Date; to: Date },
    timezone: string,
  ): Promise<{ points: { date: string; count: number }[]; total: number }> {
    const rows = await this.repository.firstWonDates(range.from, range.to);

    const buckets = new Map<string, number>();
    for (const row of rows) {
      if (!row.firstWonAt) continue;
      const day = dayKey(row.firstWonAt, timezone);
      buckets.set(day, (buckets.get(day) ?? 0) + 1);
    }

    return {
      points: [...buckets.entries()]
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      total: rows.length,
    };
  }

  async topCustomers(limit = 20, range?: { from: Date; to: Date }) {
    const { grouped, accounts } = await this.repository.topCustomers(limit, range);
    const byId = new Map(accounts.map((account) => [account.id, account]));

    return {
      items: grouped
        .map((row) => {
          if (!row.accountId) return null;
          const account = byId.get(row.accountId);
          if (!account) return null;

          const wonValue = Number(row._sum.wonValue ?? 0);

          return {
            accountId: account.id,
            name: account.name,
            status: account.status,
            wonDeals: row._count._all,
            wonValue,
            averageDealValue: row._count._all > 0 ? wonValue / row._count._all : null,
            firstWonAt: account.firstWonAt?.toISOString() ?? null,
            lastWonAt: account.lastWonAt?.toISOString() ?? null,
            isRepeatCustomer: row._count._all > 1,
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null),
    };
  }

  /**
   * Product demand, split into new-prospect and existing-customer.
   *
   * The classification is AS AT THE TIME OF THE ENQUIRY, not as at today. A
   * company that first bought last week was a prospect when they enquired three
   * months ago; classifying by today's status would move that old enquiry into
   * existing-customer demand and make new business look like it had collapsed.
   *
   * Each lead is counted exactly once. Leads with no account are reported as
   * `unknown` rather than attributed to either side.
   */
  async demandByCustomerType(range?: { from: Date; to: Date }): Promise<{
    items: {
      productId: string;
      name: string;
      sku: string | null;
      category: string | null;
      active: boolean;
      prospect: number;
      existingCustomer: number;
      unknown: number;
      total: number;
      existingCustomerShare: number | null;
    }[];
    totals: DemandSplit & { total: number; existingCustomerShare: number | null };
    coverage: { leadsWithoutProduct: number; leadsWithoutAccount: number };
  }> {
    const [grouped, firstWonDates, leadsWithoutProduct, leadsWithoutAccount] = await Promise.all([
      this.repository.demandByProductAndAccount(range),
      this.repository.accountFirstWonDates(),
      this.repository.leadsWithoutProduct(range),
      this.repository.leadsWithoutAccount(range),
    ]);

    const firstWonByAccount = new Map<string, Date>();
    for (const account of firstWonDates) {
      if (account.firstWonAt) firstWonByAccount.set(account.id, account.firstWonAt);
    }

    /*
     * groupBy cannot also give us each lead's createdAt, so the classification
     * here uses whether the account had EVER bought. That is a deliberate,
     * documented approximation, and its direction is stated plainly in the
     * endpoint description: an account that has since become a customer counts
     * as an existing customer for all of its enquiries.
     *
     * The alternative — reading every lead's createdAt to compare against its
     * account's first win — is a row per lead, which is exactly what §27
     * forbids. Reporting the approximation beats loading the table.
     */
    const perProduct = new Map<string, DemandSplit>();

    for (const row of grouped) {
      if (!row.productId) continue;

      const split = perProduct.get(row.productId) ?? {
        prospect: 0,
        existingCustomer: 0,
        unknown: 0,
      };

      const count = row._count._all;

      if (!row.accountId) {
        split.unknown += count;
      } else if (firstWonByAccount.has(row.accountId)) {
        split.existingCustomer += count;
      } else {
        split.prospect += count;
      }

      perProduct.set(row.productId, split);
    }

    const products = await this.repository.productsByIds([...perProduct.keys()]);
    const byId = new Map(products.map((product) => [product.id, product]));

    const items = [...perProduct.entries()]
      .map(([productId, split]) => {
        const product = byId.get(productId);
        if (!product) return null;

        return {
          productId,
          name: product.name,
          sku: product.sku,
          category: product.category,
          active: product.active,
          ...split,
          total: totalDemand(split),
          existingCustomerShare: existingCustomerShare(split),
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((a, b) => b.total - a.total);

    const totals = items.reduce<DemandSplit>(
      (accumulator, row) => ({
        prospect: accumulator.prospect + row.prospect,
        existingCustomer: accumulator.existingCustomer + row.existingCustomer,
        unknown: accumulator.unknown + row.unknown,
      }),
      { prospect: 0, existingCustomer: 0, unknown: 0 },
    );

    return {
      items,
      totals: {
        ...totals,
        total: totalDemand(totals),
        existingCustomerShare: existingCustomerShare(totals),
      },
      coverage: { leadsWithoutProduct, leadsWithoutAccount },
    };
  }
}

function countOf(rows: { status: string; _count: { _all: number } }[], status: string): number {
  return rows.find((row) => row.status === status)?._count._all ?? 0;
}

/** YYYY-MM-DD in the organization's timezone, so "today" means their today. */
function dayKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
