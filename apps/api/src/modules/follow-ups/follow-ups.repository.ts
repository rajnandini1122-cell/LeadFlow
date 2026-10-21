import { Injectable } from '@nestjs/common';
import type { ActivityType, FollowUpStatus, FollowUpType } from '../../generated/prisma/enums';
import { PrismaService, type PrismaTransaction } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
import { AUDIT_ACTIONS } from '../../common/audit/audit.repository';

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

/** What a follow-up write needs to know about the lead it holds locked. */
export interface LockedLead {
  id: string;
  status: string;
  assignedToId: string | null;
  nextFollowUpAt: Date | null;
}

/**
 * Takes the lead's row lock for the rest of the transaction.
 *
 * THE RACE THIS CLOSES. Every follow-up write on a lead reads the open rows,
 * then acts on what it read. Two agents — or one agent and a retried request —
 * each read the same open follow-up, each created a replacement, and each
 * cancelled the original. The lead was left with two open follow-ups, and a
 * late "no answer" could overwrite a COMPLETED row as CANCELLED, erasing the
 * record that the call happened. Holding the lead's row lock makes the second
 * writer wait and then read what the first one committed.
 *
 * Same idiom as `lockActiveTeam`: a no-op UPDATE through the tenant-scoped
 * client acquires the row-level lock, because raw `SELECT ... FOR UPDATE`
 * bypasses tenant scoping and is banned. `updatedAt` is written back with the
 * value it already has, so nothing a user can see changes.
 *
 * Null when the lead is absent, archived or another tenant's.
 */
export async function lockLeadForFollowUps(
  tx: PrismaTransaction,
  leadId: string,
): Promise<LockedLead | null> {
  const lead = await tx.lead.findFirst({
    where: { id: leadId, deletedAt: null },
    select: { id: true, updatedAt: true },
  });
  if (!lead) return null;

  const locked = await tx.lead.updateMany({
    where: { id: leadId, deletedAt: null },
    data: { updatedAt: lead.updatedAt },
  });
  if (locked.count === 0) return null;

  // Re-read UNDER the lock: the values above may predate a write that
  // committed while this transaction was waiting for it.
  return tx.lead.findFirst({
    where: { id: leadId },
    select: { id: true, status: true, assignedToId: true, nextFollowUpAt: true },
  });
}

/**
 * Row lock on ONE follow-up, for an account-level follow-up.
 *
 * A lead follow-up serialises on the lead. An account follow-up has no lead,
 * so its own row is the thing two writers must queue on. Same no-op UPDATE
 * idiom as `lockLeadForFollowUps`. False when the row is not visible.
 */
export async function lockFollowUpRow(tx: PrismaTransaction, followUpId: string): Promise<boolean> {
  const row = await tx.followUp.findFirst({
    where: { id: followUpId },
    select: { updatedAt: true },
  });
  if (!row) return false;

  const locked = await tx.followUp.updateMany({
    where: { id: followUpId },
    data: { updatedAt: row.updatedAt },
  });
  return locked.count > 0;
}

/**
 * How far back a replay of an account follow-up action is looked for.
 *
 * A replay is a double click or a client retry: seconds, at most minutes. The
 * bound also keeps the lookup on the (action, created_at) index — audit_logs
 * has no index on entity_id, and an unbounded search would scan every such
 * entry the tenant ever wrote.
 */
const ACCOUNT_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The timeline entry an earlier request with this Idempotency-Key wrote, if any.
 *
 * The key lives in that entry's metadata, so the replay check and the original
 * write are the same row: there is no separate idempotency table to fall out of
 * step with the timeline. Must be called with the lead locked, which is what
 * makes check-then-write safe — a concurrent duplicate waits for the lock and
 * then finds the entry the first request committed.
 */
export async function findReplay(
  tx: PrismaTransaction,
  input: { leadId: string; activityType: ActivityType; key: string | null | undefined },
): Promise<Record<string, unknown> | null> {
  if (!input.key) return null;

  const entry = await tx.leadActivity.findFirst({
    where: {
      leadId: input.leadId,
      activityType: input.activityType,
      metadata: { path: ['idempotencyKey'], equals: input.key },
    },
    select: { metadata: true },
  });

  return entry ? ((entry.metadata ?? {}) as Record<string, unknown>) : null;
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

  async findById(id: string, restrictToUserId?: string, tx?: PrismaTransaction) {
    return (tx ?? this.prisma.client).followUp.findFirst({
      where: { id, ...(restrictToUserId ? { assignedUserId: restrictToUserId } : {}) },
      include: this.include,
    });
  }

  /**
   * Runs `work` in ONE transaction, holding the lead's row lock when there is a
   * lead.
   *
   * What lets a service compose several follow-up writes — close, change the
   * stage, schedule the next, re-derive the mirror, write the timeline — into a
   * single commit. They used to be five separate writes: a failure partway left
   * a completed follow-up with no next action, and the CHECK constraint then
   * refused the mirror update as a 500 after the completion had already landed.
   *
   * `lead` is null for an account-level follow-up (no lead to lock) and when the
   * lead has gone, which the caller reports as not-found.
   */
  async inLeadTransaction<T>(
    leadId: string | null,
    work: (tx: PrismaTransaction, lead: LockedLead | null) => Promise<T>,
  ): Promise<T> {
    return this.prisma.client.$transaction(async (tx) => {
      const lead = leadId ? await lockLeadForFollowUps(tx, leadId) : null;
      return work(tx, lead);
    });
  }

  /**
   * Appends a timeline entry inside the caller's transaction, and keeps
   * `last_activity_at` honest in the same commit.
   *
   * `idempotencyKey` is stored in the entry's metadata. That is what a replay
   * of the same request is matched against — see `findReplay`.
   */
  async recordLeadActivity(
    tx: PrismaTransaction,
    input: {
      leadId: string;
      activityType: ActivityType;
      description: string;
      actorId: string | null;
      idempotencyKey?: string | null | undefined;
      /** What a replay needs to answer with the original result. */
      result?: Record<string, string | null> | undefined;
    },
  ): Promise<void> {
    const organizationId = this.tenantContext.requireOrganizationId();
    const metadata =
      input.idempotencyKey || input.result
        ? {
            ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
            ...(input.result ?? {}),
          }
        : undefined;

    await tx.leadActivity.create({
      data: {
        organizationId,
        leadId: input.leadId,
        activityType: input.activityType,
        description: input.description,
        performedById: input.actorId,
        ...(metadata ? { metadata } : {}),
      },
    });

    await tx.lead.updateMany({
      where: { id: input.leadId },
      data: { lastActivityAt: new Date() },
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
    tx?: PrismaTransaction | undefined;
  }): Promise<number> {
    const result = await (input.tx ?? this.prisma.client).followUp.updateMany({
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
    /** A replay with the same key returns the first replacement. */
    idempotencyKey?: string | null | undefined;
  }) {
    const organizationId = this.tenantContext.requireOrganizationId();

    return this.prisma.client.$transaction(async (tx) => {
      /*
       * Lock first, so this serialises with every other write that could
       * touch the same work — for a lead, every follow-up write on that lead (a
       * "no answer" racing this reschedule included); for an account follow-up,
       * the follow-up row itself. Then look for a replay of this request.
       */
      let replay: Record<string, unknown> | null;
      if (input.leadId) {
        await lockLeadForFollowUps(tx, input.leadId);
        replay = await findReplay(tx, {
          leadId: input.leadId,
          activityType: 'FOLLOW_UP_RESCHEDULED',
          key: input.idempotencyKey,
        });
      } else {
        await lockFollowUpRow(tx, input.originalId);
        replay = await this.findAccountReplay(tx, {
          followUpId: input.originalId,
          action: AUDIT_ACTIONS.ACCOUNT_FOLLOW_UP_RESCHEDULED,
          key: input.idempotencyKey,
        });
      }

      const replacementId = replay?.['replacementId'];
      if (typeof replacementId === 'string') {
        // The same request, again. Answer with what it produced the first
        // time instead of reporting the original as already cancelled.
        return tx.followUp.findFirst({ where: { id: replacementId }, include: this.include });
      }

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
      // A lead follow-up is recorded on the lead's timeline. An account-level
      // follow-up has no timeline, so its record — and the key a retry is
      // matched against — goes in the audit log, in this same commit.
      if (!input.leadId) {
        await this.recordAccountFollowUpAction(tx, {
          followUpId: input.originalId,
          action: AUDIT_ACTIONS.ACCOUNT_FOLLOW_UP_RESCHEDULED,
          actorId: input.actorId,
          idempotencyKey: input.idempotencyKey,
          result: { replacementId: replacement.id, scheduledAt: input.scheduledAt.toISOString() },
        });
      }

      if (input.leadId) {
        await this.recordLeadActivity(tx, {
          leadId: input.leadId,
          activityType: 'FOLLOW_UP_RESCHEDULED',
          description: `Rescheduled to ${input.scheduledAt.toISOString()}`,
          actorId: input.actorId,
          idempotencyKey: input.idempotencyKey,
          result: { replacementId: replacement.id },
        });

        // The mirror moves in the SAME commit. It used to be re-derived after
        // the transaction, so a failure between the two left the lead screen
        // promising the old date while the queue held the new one.
        await this.syncLeadNextFollowUp(input.leadId, tx);
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
  /**
   * The audit entry an earlier request with this key wrote for an ACCOUNT
   * follow-up, if any. Call with the follow-up row locked.
   *
   * `audit_logs` is not tenant-scoped by the Prisma extension, so the
   * organization is filtered here explicitly.
   */
  async findAccountReplay(
    tx: PrismaTransaction,
    input: { followUpId: string; action: string; key: string | null | undefined },
  ): Promise<Record<string, unknown> | null> {
    if (!input.key) return null;

    const entry = await tx.auditLog.findFirst({
      where: {
        organizationId: this.tenantContext.requireOrganizationId(),
        action: input.action,
        entityType: 'FollowUp',
        entityId: input.followUpId,
        createdAt: { gte: new Date(Date.now() - ACCOUNT_REPLAY_WINDOW_MS) },
        after: { path: ['idempotencyKey'], equals: input.key },
      },
      select: { after: true },
    });

    return entry ? ((entry.after ?? {}) as Record<string, unknown>) : null;
  }

  /**
   * Records an account follow-up being completed or rescheduled, in the
   * caller's transaction.
   *
   * Written whether or not a key was supplied: an account follow-up has no
   * lead timeline, so without this the action left no record of who did it.
   */
  async recordAccountFollowUpAction(
    tx: PrismaTransaction,
    input: {
      followUpId: string;
      action: string;
      actorId: string;
      idempotencyKey?: string | null | undefined;
      result: Record<string, string | null>;
    },
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        organizationId: this.tenantContext.requireOrganizationId(),
        actorUserId: input.actorId,
        action: input.action,
        entityType: 'FollowUp',
        entityId: input.followUpId,
        after: {
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
          ...input.result,
        },
      },
    });
  }

  /** The lead's current next-action mirror, as committed. */
  async leadNextFollowUpAt(leadId: string, tx?: PrismaTransaction): Promise<Date | null> {
    const lead = await (tx ?? this.prisma.client).lead.findFirst({
      where: { id: leadId },
      select: { nextFollowUpAt: true },
    });
    return lead?.nextFollowUpAt ?? null;
  }

  async syncLeadNextFollowUp(leadId: string, tx?: PrismaTransaction): Promise<Date | null> {
    const client = tx ?? this.prisma.client;
    const earliest = await client.followUp.findFirst({
      where: { leadId, status: { in: OPEN_STATUSES } },
      orderBy: { scheduledAt: 'asc' },
      select: { scheduledAt: true },
    });

    const next = earliest?.scheduledAt ?? null;

    // updateMany, not update: it carries the tenant scope.
    await client.lead.updateMany({
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
      // Serialise with every other follow-up write on this lead. Re-taking it
      // inside a caller's transaction that already holds it is a no-op.
      await lockLeadForFollowUps(tx, input.leadId);

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
          // Still-open only. Without this predicate a row completed between
          // the read above and this write was overwritten as CANCELLED, which
          // erased the record that the call had actually happened.
          where: { id: { in: open.map((row) => row.id) }, status: { in: OPEN_STATUSES } },
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
