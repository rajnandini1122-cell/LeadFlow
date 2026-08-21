import { Injectable } from '@nestjs/common';
import type { LeadPriority, LeadStatus } from '@leadflow/api-types';
import type { ActivityType } from '../../generated/prisma/enums';
import { sideEffectsFor } from './lead-status';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';

/**
 * Lead data access.
 *
 * READS are auto-scoped by the Prisma tenant extension, so none of them mention
 * organizationId. That is the whole point: the scope applies whether or not the
 * author remembered it.
 *
 * WRITES name the tenant explicitly, because Prisma generated types cannot see
 * the runtime extension and correctly refuse a create without it. The value
 * still comes from the server-side context, never the client, and the extension
 * remains the backstop if it were ever wrong.
 *
 * Creating a lead is implemented; editing, reassignment and status-transition
 * rules remain Phase 2.
 */
@Injectable()
export class LeadsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async list(filters: {
    status?: LeadStatus | undefined;
    assignedToId?: string | undefined;
    search?: string | undefined;
    cursor?: string | undefined;
    limit: number;
    /**
     * Owner restriction derived from the caller's permissions. Applied AFTER
     * the caller-supplied assignedToId filter so a rep cannot widen their own
     * visibility by passing someone else's id in the query string.
     */
    restrictToUserId?: string | undefined;
  }) {
    const where: Record<string, unknown> = { deletedAt: null };
    if (filters.status) where['status'] = filters.status;
    if (filters.assignedToId) where['assignedToId'] = filters.assignedToId;
    if (filters.restrictToUserId) where['assignedToId'] = filters.restrictToUserId;

    if (filters.search) {
      where['OR'] = [
        { firstName: { contains: filters.search, mode: 'insensitive' } },
        { lastName: { contains: filters.search, mode: 'insensitive' } },
        { companyName: { contains: filters.search, mode: 'insensitive' } },
        { mobile: { contains: filters.search } },
      ];
    }

    // Fetch one extra row to determine hasMore without a second count query.
    return this.prisma.client.lead.findMany({
      where,
      take: filters.limit + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
      orderBy: { createdAt: 'desc' },
      include: {
        assignedTo: { select: { id: true, fullName: true } },
      },
    });
  }

  /**
   * findFirst, not findUnique.
   *
   * Both are tenant-scoped by the extension, but findFirst returns null for a
   * foreign id whereas findUniqueOrThrow would raise a distinguishable error.
   * Null lets the service produce a plain 404 that leaks nothing.
   */
  async findById(id: string, restrictToUserId?: string) {
    return this.prisma.client.lead.findFirst({
      where: {
        id,
        deletedAt: null,
        ...(restrictToUserId ? { assignedToId: restrictToUserId } : {}),
      },
      include: {
        assignedTo: { select: { id: true, fullName: true } },
        assignedBy: { select: { id: true, fullName: true } },
      },
    });
  }

  async listActivities(leadId: string, limit: number) {
    return this.prisma.client.leadActivity.findMany({
      where: { leadId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { performedBy: { select: { id: true, fullName: true } } },
    });
  }

  async countByStatus() {
    return this.prisma.client.lead.groupBy({
      by: ['status'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
  }

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------

  /**
   * Finds an existing lead with the same mobile in THIS organization.
   *
   * Mobile is the primary duplicate key (spec §23). LOST and soft-deleted rows
   * are excluded, matching the partial unique index — a genuinely lost enquiry
   * may legitimately come back as a fresh one later.
   */
  async findActiveByMobile(mobile: string) {
    return this.prisma.client.lead.findFirst({
      where: { mobile, deletedAt: null, status: { not: 'LOST' } },
      select: {
        id: true,
        leadNumber: true,
        firstName: true,
        lastName: true,
        companyName: true,
        status: true,
      },
    });
  }

  /**
   * Next lead number for this organization, e.g. LD-00020.
   *
   * Read-then-write is inherently racy: two concurrent creates can compute the
   * same number. The unique index on (organization_id, lead_number) turns that
   * race into a constraint violation the service retries, rather than two leads
   * silently sharing a number.
   */
  async nextLeadNumber(): Promise<string> {
    const latest = await this.prisma.client.lead.findFirst({
      orderBy: { leadNumber: 'desc' },
      select: { leadNumber: true },
    });

    const current = latest ? Number(latest.leadNumber.replace(/\D/g, '')) : 0;
    return `LD-${String(current + 1).padStart(5, '0')}`;
  }

  /**
   * Creates the lead and its opening timeline entries in one transaction.
   *
   * Returns the id rather than the row: the caller re-reads through findById so
   * a created lead has exactly the same shape as every other lead read.
   */
  async createWithActivity(input: {
    leadNumber: string;
    firstName: string;
    lastName?: string | undefined;
    mobile: string;
    email?: string | undefined;
    companyName?: string | undefined;
    city?: string | undefined;
    source?: string | undefined;
    productInterest?: string | undefined;
    estimatedValue?: number | undefined;
    status: LeadStatus;
    priority: LeadPriority;
    assignedToId?: string | undefined;
    nextFollowUpAt: Date | null;
    actorId: string;
  }) {
    const organizationId = this.tenantContext.requireOrganizationId();

    return this.prisma.client.$transaction(async (tx) => {
      const created = await tx.lead.create({
        data: {
          organizationId,
          leadNumber: input.leadNumber,
          firstName: input.firstName,
          lastName: input.lastName ?? null,
          mobile: input.mobile,
          email: input.email ?? null,
          companyName: input.companyName ?? null,
          city: input.city ?? null,
          source: input.source ?? null,
          productInterest: input.productInterest ?? null,
          estimatedValue: input.estimatedValue ?? null,
          status: input.status,
          priority: input.priority,
          assignedToId: input.assignedToId ?? null,
          assignedById: input.assignedToId ? input.actorId : null,
          nextFollowUpAt: input.nextFollowUpAt,
          lastActivityAt: new Date(),
          createdBy: input.actorId,
          updatedBy: input.actorId,
        },
        select: { id: true },
      });

      await tx.leadActivity.create({
        data: {
          organizationId,
          leadId: created.id,
          activityType: 'LEAD_CREATED',
          description: input.source ? `Lead captured from ${input.source}` : 'Lead created',
          performedById: input.actorId,
        },
      });

      if (input.assignedToId) {
        await tx.leadActivity.create({
          data: {
            organizationId,
            leadId: created.id,
            activityType: 'LEAD_ASSIGNED',
            description: 'Assigned for first contact',
            performedById: input.actorId,
          },
        });
      }

      // Re-read through findById so the caller always gets the same shape as
      // every other lead read, including the assignedTo relation.
      return created.id;
    });
  }

  /**
   * The current organization's dialling country, for phone normalisation.
   *
   * Organization is tenant-scoped by the extension, so findFirst returns this
   * tenant and no other.
   */
  async organizationCountry(): Promise<string> {
    const organization = await this.prisma.client.organization.findFirst({
      select: { country: true },
    });
    return organization?.country ?? 'US';
  }

  /**
   * Confirms a user is an ACTIVE member of the current organization.
   *
   * Necessary because leads.assigned_to references the GLOBAL users table:
   * nothing in the schema prevents assigning another organization's user, and
   * the tenant extension cannot help because the id is valid, just foreign.
   * This query goes through organizationUser, which IS tenant-scoped.
   */
  async isActiveMember(userId: string): Promise<boolean> {
    const count = await this.prisma.client.organizationUser.count({
      where: { userId, status: 'ACTIVE' },
    });
    return count > 0;
  }

  /**
   * Members of this organization who can own a lead.
   *
   * Goes through organizationUser — which IS tenant-scoped — rather than
   * querying the global `user` table directly.
   */
  async assignableUsers() {
    const memberships = await this.prisma.client.organizationUser.findMany({
      where: { status: 'ACTIVE' },
      include: { user: { select: { id: true, fullName: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return memberships.map((membership) => membership.user);
  }
  // ---------------------------------------------------------------------------
  // Update, assignment and archive
  // ---------------------------------------------------------------------------

  /** The tenant timezone, which is what "today" means for follow-up buckets. */
  async organizationTimezone(): Promise<string> {
    const organization = await this.prisma.client.organization.findFirst({
      select: { timezone: true },
    });
    return organization?.timezone ?? 'UTC';
  }

  /**
   * Applies a partial update.
   *
   * updateMany, not update: it carries the tenant scope, so a foreign id
   * touches zero rows rather than raising a record-not-found that would
   * confirm the id exists.
   */
  async applyUpdate(leadId: string, data: Record<string, unknown>): Promise<number> {
    const result = await this.prisma.client.lead.updateMany({
      where: { id: leadId, deletedAt: null },
      data,
    });
    return result.count;
  }

  /** Appends one timeline entry. The timeline is append-only by design. */
  async recordActivity(input: {
    leadId: string;
    activityType: ActivityType;
    description?: string | undefined;
    performedById?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<void> {
    const organizationId = this.tenantContext.requireOrganizationId();

    await this.prisma.client.leadActivity.create({
      data: {
        organizationId,
        leadId: input.leadId,
        activityType: input.activityType,
        description: input.description ?? null,
        performedById: input.performedById ?? null,
        ...(input.metadata ? { metadata: input.metadata as never } : {}),
      },
    });

    // Keeps "last touched" honest without a second query at read time.
    await this.prisma.client.lead.updateMany({
      where: { id: input.leadId },
      data: { lastActivityAt: new Date() },
    });
  }

  /** Status change plus its side effects, written together. */
  async applyStatusChange(input: {
    leadId: string;
    status: LeadStatus;
    lostReason?: string | undefined;
    wonValue?: number | undefined;
    actorId: string;
  }): Promise<void> {
    const effects = sideEffectsFor(input.status, {
      lostReason: input.lostReason,
      wonValue: input.wonValue,
    });

    await this.prisma.client.lead.updateMany({
      where: { id: input.leadId },
      data: {
        status: input.status,
        wonAt: effects.wonAt,
        lostAt: effects.lostAt,
        lostReason: effects.lostReason,
        wonValue: effects.wonValue ?? null,
        updatedBy: input.actorId,
      },
    });

    await this.recordActivity({
      leadId: input.leadId,
      activityType:
        input.status === 'WON' ? 'LEAD_WON' : input.status === 'LOST' ? 'LEAD_LOST' : 'STATUS_CHANGED',
      description:
        input.status === 'LOST' && input.lostReason
          ? `Marked lost: ${input.lostReason}`
          : `Status changed to ${input.status}`,
      performedById: input.actorId,
    });
  }

  /**
   * Soft-deletes.
   *
   * Never a hard delete: lead_activities cascade from it, so removing the row
   * would erase the entire history of the relationship — including calls that
   * were made and quotations that were sent.
   */
  async archive(leadId: string, actorId: string): Promise<number> {
    const result = await this.prisma.client.lead.updateMany({
      where: { id: leadId, deletedAt: null },
      data: { deletedAt: new Date(), updatedBy: actorId },
    });
    return result.count;
  }

  /** Paginated timeline. Cursor-based, because a timeline only grows. */
  async pageActivities(leadId: string, limit: number, cursor?: string) {
    return this.prisma.client.leadActivity.findMany({
      where: { leadId },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { performedBy: { select: { id: true, fullName: true } } },
    });
  }
}
