import { Injectable } from '@nestjs/common';
import type { ActivityType, FollowUpStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Reporting aggregation.
 *
 * Every figure is computed by the database over the whole tenant dataset.
 * Nothing here returns a list of leads for the caller to count — that pattern
 * is what produced numbers that were silently wrong past the first page, and
 * wrong in the flattering direction, since a truncated list always understates
 * overdue work.
 *
 * `Lead`, `LeadActivity` and `FollowUp` are all registered in
 * TENANT_SCOPED_MODELS, so none of these queries mentions organizationId. The
 * extension narrows them, and fails closed if the context is missing.
 */
@Injectable()
export class ReportsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The lead filter implied by the caller's visibility.
   *
   * `restrictToUserId` comes from the existing lead-visibility helper, never
   * from a query parameter — there is deliberately no second authorization
   * implementation here.
   */
  private leadScope(restrictToUserId?: string): Record<string, unknown> {
    return {
      deletedAt: null,
      ...(restrictToUserId ? { assignedToId: restrictToUserId } : {}),
    };
  }

  private followUpScope(restrictToUserId?: string): Record<string, unknown> {
    return restrictToUserId ? { assignedUserId: restrictToUserId } : {};
  }

  /** Activities are scoped through their lead, so visibility stays consistent. */
  private activityScope(restrictToUserId?: string): Record<string, unknown> {
    return {
      lead: {
        deletedAt: null,
        ...(restrictToUserId ? { assignedToId: restrictToUserId } : {}),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Snapshot — as of now, regardless of the selected range
  // ---------------------------------------------------------------------------

  async snapshot(restrictToUserId?: string) {
    const scope = this.leadScope(restrictToUserId);

    const [total, active] = await Promise.all([
      this.prisma.client.lead.count({ where: scope }),
      this.prisma.client.lead.aggregate({
        where: { ...scope, status: { notIn: ['WON', 'LOST'] } },
        _count: { _all: true },
        _sum: { estimatedValue: true },
      }),
    ]);

    return {
      totalLeads: total,
      activeLeads: active._count._all,
      pipelineValue: active._sum.estimatedValue,
    };
  }

  // ---------------------------------------------------------------------------
  // Leads within a range
  // ---------------------------------------------------------------------------

  /** Leads CREATED in the range, grouped by their current status. */
  async createdByStatus(from: Date, to: Date, restrictToUserId?: string) {
    return this.prisma.client.lead.groupBy({
      by: ['status'],
      where: { ...this.leadScope(restrictToUserId), createdAt: { gte: from, lt: to } },
      _count: { _all: true },
      _sum: { estimatedValue: true },
      orderBy: { status: 'asc' },
    });
  }

  /** Leads CREATED in the range, grouped by where they came from. */
  async createdBySource(from: Date, to: Date, restrictToUserId?: string) {
    return this.prisma.client.lead.groupBy({
      by: ['source'],
      where: { ...this.leadScope(restrictToUserId), createdAt: { gte: from, lt: to } },
      _count: { _all: true },
      orderBy: { _count: { source: 'desc' } },
      take: 25,
    });
  }

  /** Deals WON in the range, by close date, with what they actually closed at. */
  async wonInRange(from: Date, to: Date, restrictToUserId?: string) {
    return this.prisma.client.lead.aggregate({
      where: { ...this.leadScope(restrictToUserId), wonAt: { gte: from, lt: to } },
      _count: { _all: true },
      // Both sums: wonValue is the revenue, estimatedValue is the fallback for
      // deals closed before wonValue existed. Reporting zero for those would
      // erase historical revenue.
      _sum: { wonValue: true, estimatedValue: true },
    });
  }

  async lostInRange(from: Date, to: Date, restrictToUserId?: string): Promise<number> {
    return this.prisma.client.lead.count({
      where: { ...this.leadScope(restrictToUserId), lostAt: { gte: from, lt: to } },
    });
  }

  async lostReasons(from: Date, to: Date, restrictToUserId?: string) {
    return this.prisma.client.lead.groupBy({
      by: ['lostReason'],
      where: {
        ...this.leadScope(restrictToUserId),
        lostAt: { gte: from, lt: to },
        lostReason: { not: null },
      },
      _count: { _all: true },
      orderBy: { _count: { lostReason: 'desc' } },
      take: 25,
    });
  }

  /**
   * Leads ARCHIVED in the range.
   *
   * Deliberately does not use `leadScope`, which excludes archived rows by
   * definition — this is the one query that wants them.
   */
  async archivedInRange(from: Date, to: Date, restrictToUserId?: string): Promise<number> {
    return this.prisma.client.lead.count({
      where: {
        deletedAt: { gte: from, lt: to },
        ...(restrictToUserId ? { assignedToId: restrictToUserId } : {}),
      },
    });
  }

  async createdInRange(from: Date, to: Date, restrictToUserId?: string): Promise<number> {
    return this.prisma.client.lead.count({
      where: { ...this.leadScope(restrictToUserId), createdAt: { gte: from, lt: to } },
    });
  }

  // ---------------------------------------------------------------------------
  // Follow-ups
  // ---------------------------------------------------------------------------

  /** Open follow-ups whose moment has passed. A snapshot, not a range. */
  async overdueFollowUps(now: Date, restrictToUserId?: string): Promise<number> {
    return this.prisma.client.followUp.count({
      where: {
        ...this.followUpScope(restrictToUserId),
        status: { in: OPEN },
        scheduledAt: { lt: now },
      },
    });
  }

  /** Open follow-ups scheduled between two instants. */
  async openFollowUpsBetween(
    from: Date,
    to: Date,
    restrictToUserId?: string,
  ): Promise<number> {
    return this.prisma.client.followUp.count({
      where: {
        ...this.followUpScope(restrictToUserId),
        status: { in: OPEN },
        scheduledAt: { gte: from, lt: to },
      },
    });
  }

  async completedFollowUps(from: Date, to: Date, restrictToUserId?: string): Promise<number> {
    return this.prisma.client.followUp.count({
      where: { ...this.followUpScope(restrictToUserId), completedAt: { gte: from, lt: to } },
    });
  }

  /**
   * Follow-ups SCHEDULED in the range, grouped by their current state.
   *
   * The completion rate is derived from this rather than from two independent
   * counts, so numerator and denominator always describe the same set of rows.
   */
  async scheduledByStatus(from: Date, to: Date, restrictToUserId?: string) {
    return this.prisma.client.followUp.groupBy({
      by: ['status'],
      where: { ...this.followUpScope(restrictToUserId), scheduledAt: { gte: from, lt: to } },
      _count: { _all: true },
      orderBy: { status: 'asc' },
    });
  }

  // ---------------------------------------------------------------------------
  // Activities
  // ---------------------------------------------------------------------------

  async activitiesByType(from: Date, to: Date, restrictToUserId?: string) {
    return this.prisma.client.leadActivity.groupBy({
      by: ['activityType'],
      where: { ...this.activityScope(restrictToUserId), createdAt: { gte: from, lt: to } },
      _count: { _all: true },
      orderBy: { activityType: 'asc' },
    });
  }

  /**
   * How many DISTINCT leads were touched in the range.
   *
   * groupBy returns one row per lead, so the count is the number of rows. A
   * plain count would report five calls to one customer as five customers
   * contacted, which is the opposite of what a manager is asking.
   */
  async leadsTouched(
    from: Date,
    to: Date,
    types: ActivityType[],
    restrictToUserId?: string,
  ): Promise<number> {
    const rows = await this.prisma.client.leadActivity.groupBy({
      by: ['leadId'],
      where: {
        ...this.activityScope(restrictToUserId),
        activityType: { in: types },
        createdAt: { gte: from, lt: to },
      },
      _count: { _all: true },
    });

    return rows.length;
  }

  // ---------------------------------------------------------------------------
  // Team performance — one query per metric, never one per member
  // ---------------------------------------------------------------------------

  async members() {
    return this.prisma.client.organizationUser.findMany({
      where: { status: { in: ['ACTIVE', 'INVITED', 'SUSPENDED'] } },
      select: {
        userId: true,
        status: true,
        user: { select: { id: true, fullName: true, email: true } },
        role: { select: { key: true } },
      },
    });
  }

  /** Currently active leads per assignee, with their pipeline value. */
  async activeByAssignee() {
    return this.prisma.client.lead.groupBy({
      by: ['assignedToId'],
      where: { deletedAt: null, status: { notIn: ['WON', 'LOST'] } },
      _count: { _all: true },
      _sum: { estimatedValue: true },
    });
  }

  async assignedInRange(from: Date, to: Date) {
    return this.prisma.client.lead.groupBy({
      by: ['assignedToId'],
      where: { deletedAt: null, createdAt: { gte: from, lt: to } },
      _count: { _all: true },
    });
  }

  async createdByUserInRange(from: Date, to: Date) {
    return this.prisma.client.lead.groupBy({
      by: ['createdBy'],
      where: { deletedAt: null, createdAt: { gte: from, lt: to } },
      _count: { _all: true },
    });
  }

  async closedByAssignee(from: Date, to: Date, outcome: 'won' | 'lost') {
    return this.prisma.client.lead.groupBy({
      by: ['assignedToId'],
      where: {
        deletedAt: null,
        ...(outcome === 'won'
          ? { wonAt: { gte: from, lt: to } }
          : { lostAt: { gte: from, lt: to } }),
      },
      _count: { _all: true },
      _sum: { wonValue: true, estimatedValue: true },
    });
  }

  async followUpsByAssignee(filter: {
    from?: Date | undefined;
    to?: Date | undefined;
    statuses?: FollowUpStatus[] | undefined;
    scheduledBefore?: Date | undefined;
    completed?: boolean | undefined;
  }) {
    const where: Record<string, unknown> = {};

    if (filter.statuses) where['status'] = { in: filter.statuses };
    if (filter.completed && filter.from && filter.to) {
      where['completedAt'] = { gte: filter.from, lt: filter.to };
    } else if (filter.scheduledBefore) {
      where['scheduledAt'] = { lt: filter.scheduledBefore };
    } else if (filter.from && filter.to) {
      where['scheduledAt'] = { gte: filter.from, lt: filter.to };
    }

    return this.prisma.client.followUp.groupBy({
      by: ['assignedUserId'],
      where,
      _count: { _all: true },
    });
  }

  /** Most recent activity per user, for the "recent activity" column. */
  async lastActivityByUser(from: Date, to: Date) {
    return this.prisma.client.leadActivity.groupBy({
      by: ['performedById'],
      where: { createdAt: { gte: from, lt: to }, performedById: { not: null } },
      _max: { createdAt: true },
      _count: { _all: true },
    });
  }
}

const OPEN: FollowUpStatus[] = ['UPCOMING', 'DUE', 'OVERDUE'];

export { OPEN as OPEN_FOLLOW_UP_STATUSES };
