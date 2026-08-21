import { Injectable } from '@nestjs/common';
import type { FollowUpStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Dashboard aggregation.
 *
 * Every figure here is computed by the database over the WHOLE dataset. The
 * previous implementation fetched one page of leads and counted them in the
 * browser, which meant the numbers were silently wrong the moment an
 * organization passed that page size — and wrong in the flattering direction,
 * since a truncated list always understates overdue work.
 *
 * `Lead` and `FollowUp` are tenant-scoped models, so none of these queries
 * mentions organizationId; the extension narrows them.
 */
@Injectable()
export class DashboardRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Owner restriction from the caller's permissions, never from the request. */
  private scope(restrictToUserId?: string): Record<string, unknown> {
    return restrictToUserId ? { assignedToId: restrictToUserId } : {};
  }

  /** Open leads grouped by stage, with the pipeline value of each stage. */
  async pipelineByStage(restrictToUserId?: string) {
    return this.prisma.client.lead.groupBy({
      by: ['status'],
      where: {
        deletedAt: null,
        status: { notIn: ['WON', 'LOST'] },
        ...this.scope(restrictToUserId),
      },
      _count: { _all: true },
      _sum: { estimatedValue: true },
      orderBy: { status: 'asc' },
    });
  }

  /** Closed leads grouped by outcome, with the value they closed at. */
  async outcomes(restrictToUserId?: string) {
    return this.prisma.client.lead.groupBy({
      by: ['status'],
      where: {
        deletedAt: null,
        status: { in: ['WON', 'LOST'] },
        ...this.scope(restrictToUserId),
      },
      _count: { _all: true },
      // wonValue is what the deal actually closed at; estimatedValue is what it
      // was hoped to be. Reporting the estimate as revenue would overstate it.
      _sum: { wonValue: true, estimatedValue: true },
      orderBy: { status: 'asc' },
    });
  }

  async countCreatedSince(since: Date, restrictToUserId?: string): Promise<number> {
    return this.prisma.client.lead.count({
      where: { deletedAt: null, createdAt: { gte: since }, ...this.scope(restrictToUserId) },
    });
  }

  /**
   * How many follow-ups fall in one bucket window.
   *
   * Counted against the FollowUp table rather than `leads.next_follow_up_at`,
   * so the dashboard and the follow-up screen can never disagree about what is
   * overdue.
   */
  async countFollowUps(
    window: { statuses: FollowUpStatus[]; from?: Date | undefined; to?: Date | undefined },
    restrictToUserId?: string,
  ): Promise<number> {
    return this.prisma.client.followUp.count({
      where: {
        status: { in: window.statuses },
        ...(window.from || window.to
          ? {
              scheduledAt: {
                ...(window.from ? { gte: window.from } : {}),
                ...(window.to ? { lt: window.to } : {}),
              },
            }
          : {}),
        ...(restrictToUserId ? { assignedUserId: restrictToUserId } : {}),
      },
    });
  }

  /**
   * The leads a person should act on next: earliest due first, oldest overdue
   * at the very top.
   */
  async nextActions(before: Date, limit: number, restrictToUserId?: string) {
    return this.prisma.client.lead.findMany({
      where: {
        deletedAt: null,
        status: { notIn: ['WON', 'LOST'] },
        nextFollowUpAt: { not: null, lt: before },
        ...this.scope(restrictToUserId),
      },
      orderBy: { nextFollowUpAt: 'asc' },
      take: limit,
      include: { assignedTo: { select: { id: true, fullName: true } } },
    });
  }

  async recentLeads(limit: number, restrictToUserId?: string) {
    return this.prisma.client.lead.findMany({
      where: { deletedAt: null, ...this.scope(restrictToUserId) },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { assignedTo: { select: { id: true, fullName: true } } },
    });
  }

  async contactCount(): Promise<number> {
    return this.prisma.client.contact.count({ where: { deletedAt: null, mergedIntoId: null } });
  }
}
