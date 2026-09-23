import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { TenantContextService } from '../common/tenancy/tenant-context.service';
import type { FollowUpStatus } from '../generated/prisma/enums';

/**
 * Data access for the follow-up sweep.
 *
 * Split into two clearly separated halves, and the separation is the security
 * boundary:
 *
 *   FINDING WORK is genuinely cross-tenant. A sweep has to ask "which
 *   organizations have follow-ups that have come due" before it can know which
 *   tenant to enter. That one query runs under `runAsSystem` with a stated
 *   reason, reads TWO COLUMNS, and returns nothing but organization ids. The
 *   schema anticipated this: `@@index([status, scheduledAt])` on follow_ups is
 *   deliberately not organization-first, for exactly this query.
 *
 *   DOING WORK is per-tenant, always. Every method below the divider runs
 *   inside `runWithTenant`, so the extension narrows it exactly as it narrows
 *   an HTTP request. No business read or write in this file escapes tenant
 *   scope.
 */
@Injectable()
export class FollowUpSweepRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  // === cross-tenant: finding work ============================================

  /**
   * Which organizations currently have follow-ups needing attention.
   *
   * The ONLY cross-tenant query in the worker. It returns organization ids and
   * nothing else — no names, no customers, no values — so even a bug here
   * cannot leak business data. Everything after this point is tenant-scoped.
   */
  async organizationsWithDueWork(before: Date, limit = 500): Promise<string[]> {
    const rows = await this.tenantContext.runAsSystem(
      'follow-up sweep: find which tenants have work that has come due',
      async () =>
        this.prisma.client.followUp.findMany({
          where: {
            status: { in: ['UPCOMING', 'DUE', 'OVERDUE'] },
            scheduledAt: { lte: before },
          },
          select: { organizationId: true },
          distinct: ['organizationId'],
          take: limit,
        }),
    );

    return rows.map((row) => row.organizationId);
  }

  // === tenant-scoped: doing work =============================================

  /**
   * Open follow-ups at or past their moment, for THIS organization.
   *
   * Bounded. A tenant with ten thousand neglected follow-ups gets the oldest
   * batch this run and the rest next run, rather than one query that times out
   * and leaves every tenant unprocessed.
   */
  async dueFollowUps(before: Date, limit = 200) {
    return this.prisma.client.followUp.findMany({
      where: {
        status: { in: ['UPCOMING', 'DUE', 'OVERDUE'] },
        scheduledAt: { lte: before },
      },
      select: {
        id: true,
        status: true,
        scheduledAt: true,
        assignedUserId: true,
        title: true,
        type: true,
        reminderSentAt: true,
        overdueNotifiedAt: true,
        escalatedAt: true,
        leadId: true,
        accountId: true,
        lead: { select: { leadNumber: true, firstName: true, lastName: true, companyName: true } },
        account: { select: { name: true } },
      },
      orderBy: { scheduledAt: 'asc' },
      take: limit,
    });
  }

  /** Follow-ups approaching their time, for the advance reminder. */
  async upcomingFollowUps(from: Date, to: Date, limit = 200) {
    return this.prisma.client.followUp.findMany({
      where: {
        status: 'UPCOMING',
        reminderSentAt: null,
        scheduledAt: { gt: from, lte: to },
      },
      select: {
        id: true,
        scheduledAt: true,
        assignedUserId: true,
        title: true,
        type: true,
        reminderSentAt: true,
        leadId: true,
        accountId: true,
        lead: { select: { leadNumber: true, firstName: true, lastName: true, companyName: true } },
        account: { select: { name: true } },
      },
      orderBy: { scheduledAt: 'asc' },
      take: limit,
    });
  }

  /**
   * Advances a follow-up's status, but only from the state the sweep saw.
   *
   * The `status` predicate is what makes this safe under concurrency: if a rep
   * completed the follow-up between the read and the write, zero rows update
   * and nothing is clobbered. Without it a sweep could resurrect a completed
   * follow-up into OVERDUE.
   */
  async advanceStatus(input: {
    id: string;
    from: FollowUpStatus;
    to: FollowUpStatus;
  }): Promise<number> {
    const result = await this.prisma.client.followUp.updateMany({
      where: { id: input.id, status: input.from },
      data: { status: input.to },
    });
    return result.count;
  }

  /**
   * Stamps an idempotency marker, but only if it is still unset.
   *
   * Returns 0 when another worker got there first, which is how two concurrent
   * sweeps agree on who sends the notification. The marker is claimed BEFORE
   * the notification is written, so the worst case is a marker with no
   * notification — a missed reminder, recoverable — rather than a notification
   * with no marker, which would repeat forever.
   */
  async claimMarker(
    id: string,
    marker: 'reminderSentAt' | 'overdueNotifiedAt' | 'escalatedAt',
  ): Promise<number> {
    const result = await this.prisma.client.followUp.updateMany({
      where: { id, [marker]: null },
      data: { [marker]: new Date() },
    });
    return result.count;
  }

  /** This tenant's escalation configuration. */
  async settings() {
    return this.prisma.client.organizationSettings.findFirst({
      select: {
        followupReminderMinutes: true,
        followupOverdueMinutes: true,
        escalateToManager: true,
      },
    });
  }
}
