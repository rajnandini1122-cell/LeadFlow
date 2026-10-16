import { Injectable } from '@nestjs/common';
import type { FollowUpStatus, FollowUpType } from '../../generated/prisma/enums';
import { PrismaService, type PrismaTransaction } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';

/** Statuses that still represent work owed. */
export const OPEN_STATUSES: FollowUpStatus[] = ['UPCOMING', 'DUE', 'OVERDUE'];

/**
 * The status a newly created follow-up starts in.
 *
 * A follow-up whose moment has already passed is DUE from the first instant,
 * not UPCOMING. That happens for real: the website pipeline measures the SLA
 * from when the ENQUIRY arrived, so a sweep that ran late must produce a row
 * that is honestly already due rather than one whose clock was quietly
 * restarted.
 *
 * Extracted because it was written inline in one creator and then omitted by
 * two more — a late-converted enquiry started UPCOMING and appeared in neither
 * the due nor the overdue view, which is invisible work.
 */
export function initialFollowUpStatus(scheduledAt: Date, now = new Date()): FollowUpStatus {
  return scheduledAt.getTime() <= now.getTime() ? 'DUE' : 'UPCOMING';
}

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
    /**
     * Null for a SYSTEM write. `created_by` is nullable with no foreign key,
     * so the automated pipeline records that nobody scheduled this by hand.
     */
    actorId: string | null;
    /**
     * Supplied when this belongs to a caller's transaction.
     *
     * The automated pipeline needs the follow-up and the lead's
     * `nextFollowUpAt` to commit together: a lead promising a next action that
     * has no row behind it is the inconsistency the whole follow-up model
     * exists to rule out.
     */
    tx?: PrismaTransaction | undefined;
  }) {
    const organizationId = this.tenantContext.requireOrganizationId();

    return (input.tx ?? this.prisma.client).followUp.create({
      data: {
        organizationId,
        leadId: input.leadId ?? null,
        accountId: input.accountId ?? null,
        assignedUserId: input.assignedUserId,
        scheduledAt: input.scheduledAt,
        type: input.type,
        title: input.title ?? null,
        notes: input.notes ?? null,
        status: initialFollowUpStatus(input.scheduledAt),
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

  /**
   * Sets a lead's next action, keeping the QUEUE and the MIRROR in step.
   *
   * THE BUG THIS EXISTS TO END. `leads.next_follow_up_at` is documented as a
   * denormalised mirror of the earliest OPEN follow-up, and
   * `syncLeadNextFollowUp` is what maintains it. Four paths wrote that column
   * directly and created no follow-up row at all — manual lead create, CSV
   * import, editing the next-action date, and logging an activity with a next
   * date. Every lead made that way showed "Next action: 20 Nov" beside
   * "Follow-ups: 0 open", which is the inconsistency this file's own comment on
   * `create` already warned about.
   *
   * ONE TRANSACTION, because the two facts must not be able to disagree: the
   * open follow-up is replaced (or created) and the mirror is recomputed from
   * what is actually there, never from what the caller passed.
   *
   * Returns null when the lead has NO OWNER. `follow_ups.assigned_user_id` is
   * NOT NULL with a real foreign key, so there is no such thing as an
   * unassigned follow-up — and inventing an assignee would silently hand
   * somebody else's work to whoever imported a file. In that case the mirror is
   * set on its own and the caller is told, so the UI can say "unassigned"
   * rather than implying something is missing.
   */
  async setNextForLead(input: {
    leadId: string;
    scheduledAt: Date;
    /** Null when the lead is unassigned — see the note above. */
    assignedUserId: string | null;
    type?: FollowUpType | undefined;
    title?: string | undefined;
    notes?: string | undefined;
    /** Recorded on whichever open follow-up this displaces. */
    reason?: string | undefined;
    actorId: string | null;
    tx?: PrismaTransaction | undefined;
  }): Promise<{ followUpId: string | null; nextFollowUpAt: Date }> {
    const organizationId = this.tenantContext.requireOrganizationId();

    const run = async (tx: PrismaTransaction) => {
      if (input.assignedUserId === null) {
        /*
         * No owner, so no queue row is possible. The mirror still carries the
         * date, because "this lead needs action by then" is true whether or not
         * anybody has been given it yet.
         */
        await tx.lead.updateMany({
          where: { id: input.leadId },
          data: { nextFollowUpAt: input.scheduledAt },
        });

        return { followUpId: null, nextFollowUpAt: input.scheduledAt };
      }

      /*
       * Every open follow-up is superseded, not just the earliest.
       *
       * A lead should have one next action. Rescheduling only the earliest
       * would leave a second, later row open, and the mirror would then point
       * at a date the user did not choose.
       */
      const open = await tx.followUp.findMany({
        where: { leadId: input.leadId, status: { in: OPEN_STATUSES } },
        select: { id: true, type: true, title: true },
        orderBy: { scheduledAt: 'asc' },
      });

      const created = await tx.followUp.create({
        data: {
          organizationId,
          leadId: input.leadId,
          assignedUserId: input.assignedUserId,
          scheduledAt: input.scheduledAt,
          // The displaced follow-up's type and title carry over unless the
          // caller names new ones, so rescheduling a "Meeting" does not
          // silently turn it into a "Call".
          type: input.type ?? open[0]?.type ?? 'CALL',
          // A retry set in the past is due immediately, like any other.
          status: initialFollowUpStatus(input.scheduledAt),
          ...(input.title ?? open[0]?.title
            ? { title: input.title ?? (open[0]?.title as string) }
            : {}),
          ...(input.notes ? { notes: input.notes } : {}),
          createdBy: input.actorId,
        },
        select: { id: true },
      });

      if (open.length > 0) {
        await tx.followUp.updateMany({
          where: { id: { in: open.map((row) => row.id) } },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelledReason: input.reason ?? 'Rescheduled',
            // Points at the replacement, so the trail from the missed attempt
            // to the retry is followable on the record itself.
            rescheduledToId: created.id,
          },
        });
      }

      // Recomputed from the rows, never from the argument: if anything above
      // did not land, the mirror says so instead of lying.
      const earliest = await tx.followUp.findFirst({
        where: { leadId: input.leadId, status: { in: OPEN_STATUSES } },
        orderBy: { scheduledAt: 'asc' },
        select: { scheduledAt: true },
      });

      await tx.lead.updateMany({
        where: { id: input.leadId },
        data: { nextFollowUpAt: earliest?.scheduledAt ?? null },
      });

      return {
        followUpId: created.id,
        nextFollowUpAt: earliest?.scheduledAt ?? input.scheduledAt,
      };
    };

    return input.tx ? run(input.tx) : this.prisma.client.$transaction(run);
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
