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

  async create(input: {
    leadId: string;
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
        leadId: input.leadId,
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
