import { Injectable } from '@nestjs/common';
import { PERMISSIONS } from '@leadflow/api-types';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { LeadsRepository } from '../leads/leads.repository';
import { ProductKpiRepository } from './product-kpi.repository';
import {
  averageDaysToClose,
  averageWonValue,
  demandShare,
  demandTrend,
  forecastAccuracy,
  rateIsReliable,
  toNumber,
  winRate,
  type Trend,
} from './product-kpi';

/**
 * Product intelligence.
 *
 * Assembles a small, fixed number of database aggregates into the figures the
 * dashboard shows. The aggregates are grouped by product IN THE DATABASE, so a
 * catalogue of two hundred costs the same number of round trips as one of two.
 *
 * Visibility is the caller's existing lead visibility, not a second rule: a rep
 * who can only see their own leads sees product figures computed over their own
 * leads. Product KPIs are lead data reshaped, so they inherit the same
 * boundary rather than inventing one.
 */
@Injectable()
export class ProductKpiService {
  constructor(
    private readonly repository: ProductKpiRepository,
    private readonly leads: LeadsRepository,
  ) {}

  /**
   * The caller's lead restriction.
   *
   * Mirrors the reports module: anyone without team- or all-visibility sees
   * only what is assigned to them.
   */
  private restrictionFor(principal: TenantPrincipal): string | undefined {
    const canSeeEverything =
      principal.permissions.includes(PERMISSIONS.LEAD_VIEW_ALL) ||
      principal.permissions.includes(PERMISSIONS.LEAD_VIEW_TEAM);

    return canSeeEverything ? undefined : principal.userId;
  }

  /**
   * Every product with at least one lead, with its full KPI row.
   *
   * The primary management view. Products with no leads are deliberately
   * absent: a catalogue entry nobody has enquired about has no demand data,
   * and a row of dashes per unused product buries the ones that matter. The
   * catalogue screen lists those.
   */
  async performance(principal: TenantPrincipal, range?: { from: Date; to: Date }) {
    const restrict = this.restrictionFor(principal);

    const [totals, open, outcomes, durations, mapped, unmapped] = await Promise.all([
      this.repository.totalsByProduct(restrict),
      this.repository.openByProduct(restrict),
      this.repository.outcomesByProduct(restrict),
      this.repository.wonDurations(restrict),
      this.repository.mappedCount(restrict),
      this.repository.unmappedCount(restrict),
    ]);

    const productIds = totals
      .map((row) => row.productId)
      .filter((id): id is string => id !== null);

    const [names, trends] = await Promise.all([
      this.repository.namesFor(productIds),
      range ? this.trendMap(range, restrict) : Promise.resolve(new Map<string, Trend>()),
    ]);

    const nameById = new Map(names.map((product) => [product.id, product]));
    const openById = new Map(open.map((row) => [row.productId, row]));

    // Won and lost arrive in one grouped result; split them once here rather
    // than filtering the array inside every product's calculation.
    const wonById = new Map<string, { count: number; won: number | null; estimated: number | null }>();
    const lostById = new Map<string, { count: number; estimated: number | null }>();

    for (const row of outcomes) {
      if (row.productId === null) continue;
      if (row.status === 'WON') {
        wonById.set(row.productId, {
          count: row._count._all,
          won: toNumber(row._sum.wonValue),
          estimated: toNumber(row._sum.estimatedValue),
        });
      } else {
        lostById.set(row.productId, {
          count: row._count._all,
          estimated: toNumber(row._sum.estimatedValue),
        });
      }
    }

    const durationsById = new Map<string, { createdAt: Date; wonAt: Date | null }[]>();
    for (const row of durations) {
      if (row.productId === null) continue;
      const bucket = durationsById.get(row.productId) ?? [];
      bucket.push({ createdAt: row.createdAt, wonAt: row.wonAt });
      durationsById.set(row.productId, bucket);
    }

    const items = totals
      .filter((row): row is typeof row & { productId: string } => row.productId !== null)
      .map((row) => {
        const product = nameById.get(row.productId);
        const won = wonById.get(row.productId) ?? { count: 0, won: null, estimated: null };
        const lost = lostById.get(row.productId) ?? { count: 0, estimated: null };
        const openRow = openById.get(row.productId);

        const rate = winRate(won.count, lost.count);

        return {
          productId: row.productId,
          name: product?.name ?? 'Unknown product',
          sku: product?.sku ?? null,
          category: product?.category ?? null,
          active: product?.active ?? false,

          totalLeads: row._count._all,
          demandShare: demandShare(row._count._all, mapped),

          openLeads: openRow?._count._all ?? 0,
          openPipeline: toNumber(openRow?._sum.estimatedValue),

          wonLeads: won.count,
          wonValue: won.won,
          lostLeads: lost.count,
          lostValue: lost.estimated,

          winRate: rate,
          /*
           * Whether the rate is worth showing as a percentage. One win out of
           * one is "100%", and the client shows the counts instead.
           */
          winRateReliable: rateIsReliable(won.count, lost.count),

          averageWonValue: averageWonValue(won.won, won.count),
          averageDaysToClose: averageDaysToClose(durationsById.get(row.productId) ?? []),

          // Scored only on deals that closed won — an open estimate has not
          // been tested yet.
          forecast: forecastAccuracy(won.estimated, won.won),

          trend: trends.get(row.productId) ?? null,
        };
      })
      .sort((a, b) => b.totalLeads - a.totalLeads);

    return {
      items,
      totals: {
        productsWithDemand: items.length,
        leadsWithProduct: mapped,
        /*
         * Published deliberately. Every figure above covers only the leads
         * that HAVE a product, and without this number a dashboard built on
         * 10% of the data looks like it covers all of it.
         */
        leadsWithoutProduct: unmapped,
      },
    };
  }

  /**
   * Demand this period against the one before it.
   *
   * The previous window is the same LENGTH immediately before, so a 30-day
   * range compares against the 30 days before it. Comparing against a calendar
   * month of different length would move the number for reasons nobody
   * changed.
   */
  private async trendMap(
    range: { from: Date; to: Date },
    restrict?: string,
  ): Promise<Map<string, Trend>> {
    const span = range.to.getTime() - range.from.getTime();
    const previousFrom = new Date(range.from.getTime() - span);

    const [current, previous] = await Promise.all([
      this.repository.countsInWindow(range.from, range.to, restrict),
      this.repository.countsInWindow(previousFrom, range.from, restrict),
    ]);

    const previousById = new Map(
      previous
        .filter((row) => row.productId !== null)
        .map((row) => [row.productId as string, row._count._all]),
    );

    const trends = new Map<string, Trend>();

    for (const row of current) {
      if (row.productId === null) continue;
      trends.set(row.productId, demandTrend(row._count._all, previousById.get(row.productId) ?? 0));
    }

    // A product with demand BEFORE and none now is falling, and would be
    // invisible if only the current period were walked.
    for (const [productId, count] of previousById) {
      if (!trends.has(productId)) trends.set(productId, demandTrend(0, count));
    }

    return trends;
  }

  /** The organization's timezone, so day buckets fall where the team expects. */
  async organizationTimezone(): Promise<string> {
    return this.leads.organizationTimezone();
  }

  /** Leads per product per day, for the chart. */
  async demandTrendSeries(
    principal: TenantPrincipal,
    range: { from: Date; to: Date; timezone: string },
  ) {
    const restrict = this.restrictionFor(principal);
    const rows = await this.repository.createdAtsInWindow(range.from, range.to, restrict);

    const productIds = [
      ...new Set(rows.map((row) => row.productId).filter((id): id is string => id !== null)),
    ];
    const names = await this.repository.namesFor(productIds);
    const nameById = new Map(names.map((product) => [product.id, product.name]));

    /*
     * Bucketed in the ORGANIZATION's timezone.
     *
     * A server in UTC bucketing for a team in Chicago rolls the day over at
     * 6pm the previous evening, which moves enquiries between days without
     * anyone touching them.
     */
    const buckets = new Map<string, Map<string, number>>();

    for (const row of rows) {
      if (row.productId === null) continue;
      const day = dayIn(row.createdAt, range.timezone);
      const perProduct = buckets.get(row.productId) ?? new Map<string, number>();
      perProduct.set(day, (perProduct.get(day) ?? 0) + 1);
      buckets.set(row.productId, perProduct);
    }

    return {
      series: [...buckets.entries()].map(([productId, days]) => ({
        productId,
        name: nameById.get(productId) ?? 'Unknown product',
        points: [...days.entries()]
          .map(([date, count]) => ({ date, count }))
          .sort((a, b) => a.date.localeCompare(b.date)),
      })),
    };
  }

  /** Product x lead source. An unrecorded source is its own bucket. */
  async bySource(principal: TenantPrincipal) {
    const restrict = this.restrictionFor(principal);
    const rows = await this.repository.byProductAndSource(restrict);

    const productIds = [
      ...new Set(rows.map((row) => row.productId).filter((id): id is string => id !== null)),
    ];
    const names = await this.repository.namesFor(productIds);
    const nameById = new Map(names.map((product) => [product.id, product.name]));

    const byProduct = new Map<string, Map<string, number>>();
    const sources = new Set<string>();

    for (const row of rows) {
      if (row.productId === null) continue;
      // Null source is real data — a lead somebody never categorised — and
      // dropping it would make the row totals disagree with the lead count.
      const source = row.source ?? 'Unknown';
      sources.add(source);

      const perProduct = byProduct.get(row.productId) ?? new Map<string, number>();
      perProduct.set(source, (perProduct.get(source) ?? 0) + row._count._all);
      byProduct.set(row.productId, perProduct);
    }

    return {
      sources: [...sources].sort(),
      items: [...byProduct.entries()].map(([productId, counts]) => ({
        productId,
        name: nameById.get(productId) ?? 'Unknown product',
        counts: Object.fromEntries(counts),
        total: [...counts.values()].reduce((sum, value) => sum + value, 0),
      })),
    };
  }

  /** Product x assigned agent, with win rate per pairing. */
  async byAgent(principal: TenantPrincipal) {
    const restrict = this.restrictionFor(principal);
    const rows = await this.repository.byProductAndAgent(restrict);

    const productIds = [
      ...new Set(rows.map((row) => row.productId).filter((id): id is string => id !== null)),
    ];
    const userIds = [
      ...new Set(rows.map((row) => row.assignedToId).filter((id): id is string => id !== null)),
    ];

    const [names, agents] = await Promise.all([
      this.repository.namesFor(productIds),
      this.repository.agentNamesFor(userIds),
    ]);

    const nameById = new Map(names.map((product) => [product.id, product.name]));
    const agentById = new Map(agents.map((agent) => [agent.id, agent.fullName]));

    const combined = new Map<
      string,
      {
        productId: string;
        agentId: string | null;
        leads: number;
        openPipeline: number;
        won: number;
        wonValue: number;
        lost: number;
      }
    >();

    for (const row of rows) {
      if (row.productId === null) continue;
      const key = `${row.productId}:${row.assignedToId ?? 'unassigned'}`;
      const entry = combined.get(key) ?? {
        productId: row.productId,
        agentId: row.assignedToId,
        leads: 0,
        openPipeline: 0,
        won: 0,
        wonValue: 0,
        lost: 0,
      };

      entry.leads += row._count._all;

      if (row.status === 'WON') {
        entry.won += row._count._all;
        entry.wonValue += toNumber(row._sum.wonValue) ?? 0;
      } else if (row.status === 'LOST') {
        entry.lost += row._count._all;
      } else {
        entry.openPipeline += toNumber(row._sum.estimatedValue) ?? 0;
      }

      combined.set(key, entry);
    }

    return {
      items: [...combined.values()].map((entry) => ({
        productId: entry.productId,
        productName: nameById.get(entry.productId) ?? 'Unknown product',
        agentId: entry.agentId,
        agentName: entry.agentId
          ? (agentById.get(entry.agentId) ?? 'Unknown user')
          : 'Unassigned',
        leads: entry.leads,
        openPipeline: entry.openPipeline,
        wonDeals: entry.won,
        wonValue: entry.wonValue,
        winRate: winRate(entry.won, entry.lost),
        winRateReliable: rateIsReliable(entry.won, entry.lost),
      })),
    };
  }

  /** Why deals are lost, per product. */
  async lossAnalysis(principal: TenantPrincipal) {
    const restrict = this.restrictionFor(principal);
    const rows = await this.repository.lostReasonsByProduct(restrict);

    const productIds = [
      ...new Set(rows.map((row) => row.productId).filter((id): id is string => id !== null)),
    ];
    const names = await this.repository.namesFor(productIds);
    const nameById = new Map(names.map((product) => [product.id, product.name]));

    const byProduct = new Map<
      string,
      { reasons: { reason: string; count: number; value: number | null }[]; lost: number; value: number }
    >();

    for (const row of rows) {
      if (row.productId === null) continue;
      const entry = byProduct.get(row.productId) ?? { reasons: [], lost: 0, value: 0 };

      entry.reasons.push({
        // "Not recorded" is honest; an empty label would look like a bug.
        reason: row.lostReason ?? 'Not recorded',
        count: row._count._all,
        value: toNumber(row._sum.estimatedValue),
      });
      entry.lost += row._count._all;
      entry.value += toNumber(row._sum.estimatedValue) ?? 0;

      byProduct.set(row.productId, entry);
    }

    return {
      items: [...byProduct.entries()]
        .map(([productId, entry]) => ({
          productId,
          name: nameById.get(productId) ?? 'Unknown product',
          lostLeads: entry.lost,
          lostValue: entry.value,
          reasons: entry.reasons.sort((a, b) => b.count - a.count),
        }))
        .sort((a, b) => b.lostLeads - a.lostLeads),
    };
  }

  /** How much history still has no product. */
  async mappingProgress(principal: TenantPrincipal) {
    const restrict = this.restrictionFor(principal);
    const [mapped, unmapped] = await Promise.all([
      this.repository.mappedCount(restrict),
      this.repository.unmappedCount(restrict),
    ]);

    const total = mapped + unmapped;

    return {
      mapped,
      unmapped,
      total,
      // Null rather than 100% for an organization with no leads at all.
      percentMapped: total === 0 ? null : Math.round((mapped / total) * 1000) / 10,
    };
  }
}

/** The calendar day an instant falls on, in a given timezone. */
function dayIn(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '01';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
