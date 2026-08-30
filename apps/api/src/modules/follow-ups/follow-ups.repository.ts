import { Injectable } from '@nestjs/common';
import type { FollowUpStatus, FollowUpType } from '../../generated/prisma/enums';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';

/** Statuses that still represent work owed. */
export const OPEN_STATUSES: FollowUpStatus[] = ['UPCOMING', 'DUE', 'OVERDUE'];

/**
 * Follow-up data access.
 *
 * `FollowUp` is registered in TENANT_SCOPED_MODELS, so every read here is
 * automatically narrowed to the caller's organization and none of these queries
 * mentions organizationId. Writes name it explicitly because Prisma's generated
 * types cannot see the runtime extension.
 */
@Injectable()
export class FollowUpsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private readonly include = {
    lead: {
      select: {
        id: true,
        leadNumber: true,
        firstName: true,
        lastName: true,
        companyName: true,
        mobile: true,
        status: true,
        priority: true,
        estimatedValue: true,
      },
    },
    /// A follow-up hangs off EITHER a lead or an account, never both, so one
    /// of these two is always null. The CHECK constraint guarantees exactly
    /// one is present.
    account: { select: { id: true, name: true, status: true } },
    assignedUser: { select: { id: true, fullName: true } },
  };

  async findById(id: string, restrictToUserId?: string) {
    return this.prisma.client.followUp.findFirst({
      where: { id, ...(restrictToUserId ? { assignedUserId: restrictToUserId } : {}) },
      include: this.include,
    });
  }

  /**
   * Follow-ups matching a bucket.
   *
   * `restrictToUserId` comes from the caller's permissions, not from the query
   * string, so a rep cannot widen their own view by asking for someone else's.
   */
  async list(filters: {
    statuses: FollowUpStatus[];
    restrictToUserId?: string | undefined;
    assignedUserId?: string | undefined;
    from?: Date | undefined;
    to?: Date | undefined;
    limit: number;
  }) {
    const where: Record<string, unknown> = { status: { in: filters.statuses } };

    if (filters.assignedUserId) where['assignedUserId'] = filters.assignedUserId;
    // Applied last so it always wins over a caller-supplied filter.
    if (filters.restrictToUserId) where['assignedUserId'] = filters.restrictToUserId;

    if (filters.from || filters.to) {
      where['scheduledAt'] = {
        ...(filters.from ? { gte: filters.from } : {}),
        ...(filters.to ? { lt: filters.to } : {}),
      };
    }

    return this.prisma.client.followUp.findMany({
      where,
      include: this.include,
      orderBy: { scheduledAt: 'asc' },
      take: filters.limit,
    });
  }

  async listForLead(leadId: string) {
    return this.prisma.client.followUp.findMany({
      where: { leadId },
      include: this.include,
      orderBy: { scheduledAt: 'desc' },
    });
  }

  /**
   * Follow-ups owed on an account itself.
   *
   * Deliberately does NOT roll up the account's leads. Customer 360 shows those
   * under their own opportunities, and merging the two here would make it
   * impossible to tell "we owe this customer a call" from "we owe this deal a
   * call" — which is the whole reason account-level follow-ups exist.
   */
  async listForAccount(accountId: string) {
    return this.prisma.client.followUp.findMany({
      where: { accountId },
      include: this.include,
      orderBy: { scheduledAt: 'desc' },
    });
  }

  async create(input: {
    /** Exactly one of leadId and accountId. The CHECK constraint enforces it. */
    leadId?: string | null | undefined;
    accountId?: string | null | undefined;
    assignedUserId: string;
    scheduledAt: Date;
    type: FollowUpType;
    title?: string | undefined;
    notes?: string | undefined;
    actorId: string;
  }) {
    const organizationId = this.tenantContext.requireOrganizationId();

    return this.prisma.client.followUp.create({
      data: {
        organizationId,
        leadId: input.leadId ?? null,
        accountId: input.accountId ?? null,
        assignedUserId: input.assignedUserId,
        scheduledAt: input.scheduledAt,
        type: input.type,
        title: input.title ?? null,
        notes: input.notes ?? null,
        status: input.scheduledAt.getTime() <= Date.now() ? 'DUE' : 'UPCOMING',
        createdBy: input.actorId,
      },
      include: this.include,
    });
  }

  /**
   * Closes a follow-up, but only if it is still open.
   *
   * The status predicate is what makes completion idempotent: a double-submit
   * or a retried request updates zero rows the second time, so the caller can
   * be told the truth rather than silently recording two completions.
   */
  async close(input: {
    id: string;
    status: 'COMPLETED' | 'CANCELLED';
    outcome?: string | undefined;
    notes?: string | undefined;
    reason?: string | undefined;
    actorId: string;
  }): Promise<number> {
    const result = await this.prisma.client.followUp.updateMany({
      where: { id: input.id, status: { in: OPEN_STATUSES } },
      data:
        input.status === 'COMPLETED'
          ? {
              status: 'COMPLETED',
              completedAt: new Date(),
              completedBy: input.actorId,
              outcome: input.outcome ?? null,
              ...(input.notes ? { notes: input.notes } : {}),
            }
          : {
              status: 'CANCELLED',
              cancelledAt: new Date(),
              cancelledReason: input.reason ?? null,
            },
    });

    return result.count;
  }

  /**
   * Cancels a follow-up and creates its replacement atomically.
   *
   * The order matters and used to be wrong. The replacement was created FIRST
   * and the original closed afterwards, so a lost race — two people
   * rescheduling the same follow-up, or a double-submitted form — left the
   * replacement behind as an orphan while the request reported failure. The
   * lead then carried two open follow-ups where one was intended.
   *
   * Closing first, conditionally on the row still being open, means exactly one
   * caller can proceed. A loser closes zero rows, the transaction is rolled
   * back before anything is created, and nothing survives it.
   *
   * Returns null when the follow-up was already completed or cancelled.
   */
  async cancelAndReplace(input: {
    originalId: string;
    /** Carried from the original, so a replacement keeps the same parent. */
    leadId?: string | null | undefined;
    accountId?: string | null | undefined;
    assignedUserId: string;
    scheduledAt: Date;
    type: FollowUpType;
    title?: string | undefined;
    reason?: string | undefined;
    actorId: string;
  }) {
    const organizationId = this.tenantContext.requireOrganizationId();

    return this.prisma.client.$transaction(async (tx) => {
      const closed = await tx.followUp.updateMany({
        where: { id: input.originalId, status: { in: OPEN_STATUSES } },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledReason: input.reason ?? 'Rescheduled',
        },
      });

      // Somebody else got there first. Nothing has been created yet, so there
      // is nothing to clean up.
      if (closed.count === 0) return null;

      const replacement = await tx.followUp.create({
        data: {
          organizationId,
          leadId: input.leadId ?? null,
          accountId: input.accountId ?? null,
          assignedUserId: input.assignedUserId,
          scheduledAt: input.scheduledAt,
          type: input.type,
          title: input.title ?? null,
          notes: input.reason ?? null,
          status: input.scheduledAt.getTime() <= Date.now() ? 'DUE' : 'UPCOMING',
          createdBy: input.actorId,
        },
        include: this.include,
      });

      await tx.followUp.updateMany({
        where: { id: input.originalId },
        data: { rescheduledToId: replacement.id },
      });

      // The chain of attempts is the signal a manager reads, so the timeline
      // entry commits with the reschedule rather than after it.
      //
      // Only for a lead: LeadActivity requires a lead, and an account-level
      // follow-up has none. Its history is the follow-up chain itself, which
      // rescheduledToId already records.
      if (input.leadId) {
        await tx.leadActivity.create({
          data: {
            organizationId,
            leadId: input.leadId,
            activityType: 'FOLLOW_UP_RESCHEDULED',
            description: `Rescheduled to ${input.scheduledAt.toISOString()}`,
            performedById: input.actorId,
          },
        });
      }

      return replacement;
    });
  }

  async linkReschedule(originalId: string, replacementId: string): Promise<void> {
    await this.prisma.client.followUp.updateMany({
      where: { id: originalId },
      data: { rescheduledToId: replacementId },
    });
  }

  /**
   * Re-derives `leads.next_follow_up_at` from the earliest OPEN follow-up.
   *
   * That column is a denormalised mirror, and the CHECK constraint guaranteeing
   * every active lead has a next action reads it — so it must be recomputed on
   * every create, complete, reschedule and cancel. Letting it drift would
   * either block a legitimate write or, worse, leave a lead that looks covered
   * while nothing is actually scheduled.
   *
   * Returns the new value so callers can tell whether the lead now has none.
   */
  async syncLeadNextFollowUp(leadId: string): Promise<Date | null> {
    const earliest = await this.prisma.client.followUp.findFirst({
      where: { leadId, status: { in: OPEN_STATUSES } },
      orderBy: { scheduledAt: 'asc' },
      select: { scheduledAt: true },
    });

    const next = earliest?.scheduledAt ?? null;

    // updateMany, not update: it carries the tenant scope.
    await this.prisma.client.lead.updateMany({
      where: { id: leadId },
      data: { nextFollowUpAt: next },
    });

    return next;
  }

  /** Bucket counts for the dashboard, computed in one round trip. */
  async countByStatus(restrictToUserId?: string) {
    return this.prisma.client.followUp.groupBy({
      by: ['status'],
      where: restrictToUserId ? { assignedUserId: restrictToUserId } : {},
      _count: { _all: true },
    });
  }
}
