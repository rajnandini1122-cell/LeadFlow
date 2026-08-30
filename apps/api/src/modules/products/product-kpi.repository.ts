import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Product KPI aggregation.
 *
 * Every figure is computed BY THE DATABASE, grouped by product, in a fixed
 * number of queries regardless of how many products a tenant has. The pattern
 * this deliberately avoids is one query per product: a catalogue of 200 turns
 * into 200 round trips, and the page gets slower the more successful the
 * customer is.
 *
 * `Lead` and `Product` are both in TENANT_SCOPED_MODELS, so nothing here
 * mentions organizationId — the extension narrows every query and fails closed.
 *
 * Soft-deleted leads are excluded everywhere. A deleted lead is not demand.
 */
@Injectable()
export class ProductKpiRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The caller's visibility, as a lead filter.
   *
   * Comes from the existing lead-visibility helper, never from a query
   * parameter — there is no second authorization implementation here. A rep
   * with own-only visibility sees product figures for their own leads.
   */
  private scope(restrictToUserId?: string): Record<string, unknown> {
    return {
      deletedAt: null,
      ...(restrictToUserId ? { assignedToId: restrictToUserId } : {}),
    };
  }

  /**
   * Counts and money per product, for every product with at least one lead.
   *
   * One groupBy, not one query per product.
   */
  async totalsByProduct(restrictToUserId?: string) {
    return this.prisma.client.lead.groupBy({
      by: ['productId'],
      where: { ...this.scope(restrictToUserId), productId: { not: null } },
      _count: { _all: true },
      _sum: { estimatedValue: true },
    });
  }

  /** Open pipeline per product. WON and LOST are not pipeline. */
  async openByProduct(restrictToUserId?: string) {
    return this.prisma.client.lead.groupBy({
      by: ['productId'],
      where: {
        ...this.scope(restrictToUserId),
        productId: { not: null },
        status: { notIn: ['WON', 'LOST'] },
      },
      _count: { _all: true },
      _sum: { estimatedValue: true },
    });
  }

  /**
   * Won and lost per product, in one pass.
   *
   * Grouped by status as well as product so a single query answers both, and
   * win rate can be derived without a third.
   */
  async outcomesByProduct(restrictToUserId?: string) {
    return this.prisma.client.lead.groupBy({
      by: ['productId', 'status'],
      where: {
        ...this.scope(restrictToUserId),
        productId: { not: null },
        status: { in: ['WON', 'LOST'] },
      },
      _count: { _all: true },
      // Both, because forecast accuracy compares them.
      _sum: { wonValue: true, estimatedValue: true },
    });
  }

  /** Every product's lead count by stage, for the pipeline breakdown. */
  async stagesByProduct(restrictToUserId?: string) {
    return this.prisma.client.lead.groupBy({
      by: ['productId', 'status'],
      where: { ...this.scope(restrictToUserId), productId: { not: null } },
      _count: { _all: true },
    });
  }

  /**
   * Won leads with the two timestamps needed for days-to-close.
   *
   * The one place rows are read rather than aggregated: Prisma cannot average
   * a computed interval, and doing it in SQL would mean $queryRaw, which is
   * banned because the tenant extension cannot see it. Bounded to won leads
   * with both timestamps, which is a small fraction of any dataset, and only
   * two columns are selected.
   */
  async wonDurations(restrictToUserId?: string) {
    return this.prisma.client.lead.findMany({
      where: {
        ...this.scope(restrictToUserId),
        productId: { not: null },
        status: 'WON',
        wonAt: { not: null },
      },
      select: { productId: true, createdAt: true, wonAt: true },
    });
  }

  /**
   * Leads per product created inside a window.
   *
   * Used twice per trend: once for the current period and once for the one
   * before it, so the comparison basis is explicit rather than implied.
   */
  async countsInWindow(from: Date, to: Date, restrictToUserId?: string) {
    return this.prisma.client.lead.groupBy({
      by: ['productId'],
      where: {
        ...this.scope(restrictToUserId),
        productId: { not: null },
        createdAt: { gte: from, lt: to },
      },
      _count: { _all: true },
    });
  }

  /**
   * Leads per product per day, for the trend chart.
   *
   * Grouped in the database by product and creation instant; the service
   * buckets them into days in the ORGANIZATION's timezone. Bucketing in SQL
   * would need a timezone-aware date_trunc through $queryRaw, which the tenant
   * extension cannot narrow.
   */
  async createdAtsInWindow(from: Date, to: Date, restrictToUserId?: string) {
    return this.prisma.client.lead.findMany({
      where: {
        ...this.scope(restrictToUserId),
        productId: { not: null },
        createdAt: { gte: from, lt: to },
      },
      select: { productId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Product x lead source. Unknown source is a real bucket, not a gap. */
  async byProductAndSource(restrictToUserId?: string) {
    return this.prisma.client.lead.groupBy({
      by: ['productId', 'source'],
      where: { ...this.scope(restrictToUserId), productId: { not: null } },
      _count: { _all: true },
    });
  }

  /** Product x assignee, with outcome so win rate per agent is derivable. */
  async byProductAndAgent(restrictToUserId?: string) {
    return this.prisma.client.lead.groupBy({
      by: ['productId', 'assignedToId', 'status'],
      where: { ...this.scope(restrictToUserId), productId: { not: null } },
      _count: { _all: true },
      _sum: { estimatedValue: true, wonValue: true },
    });
  }

  /** Why deals are lost, per product. */
  async lostReasonsByProduct(restrictToUserId?: string) {
    return this.prisma.client.lead.groupBy({
      by: ['productId', 'lostReason'],
      where: { ...this.scope(restrictToUserId), productId: { not: null }, status: 'LOST' },
      _count: { _all: true },
      _sum: { estimatedValue: true },
    });
  }

  /** Leads with no product at all — the backlog the mapping screen works through. */
  async unmappedCount(restrictToUserId?: string): Promise<number> {
    return this.prisma.client.lead.count({
      where: { ...this.scope(restrictToUserId), productId: null },
    });
  }

  /** Total leads that DO have a product, for demand share. */
  async mappedCount(restrictToUserId?: string): Promise<number> {
    return this.prisma.client.lead.count({
      where: { ...this.scope(restrictToUserId), productId: { not: null } },
    });
  }

  /** Names for the ids the aggregates return, in one query. */
  async namesFor(productIds: string[]) {
    if (productIds.length === 0) return [];
    return this.prisma.client.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, sku: true, category: true, active: true },
    });
  }

  /** Assignee names for the agent breakdown, in one query. */
  async agentNamesFor(userIds: string[]) {
    if (userIds.length === 0) return [];
    return this.prisma.client.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, fullName: true },
    });
  }
}
