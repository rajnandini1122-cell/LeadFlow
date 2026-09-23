import { Injectable } from '@nestjs/common';
import type { LeadPriority, LeadStatus } from '@leadflow/api-types';
import type { ActivityType } from '../../generated/prisma/enums';
import { sideEffectsFor } from './lead-status';
import { PrismaService, type PrismaTransaction } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
import { AppConfig } from '../../common/config/config.module';

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
    private readonly config: AppConfig,
  ) {}

  /**
   * The WHERE clause shared by list() and count().
   *
   * Extracted so the two cannot drift: a total computed from different filters
   * than the page is worse than no total at all.
   */
  private listWhere(filters: {
    status?: LeadStatus | undefined;
    assignedToId?: string | undefined;
    productId?: string | undefined;
    accountId?: string | undefined;
    search?: string | undefined;
    restrictToUserId?: string | undefined;
  }): Record<string, unknown> {
    const where: Record<string, unknown> = { deletedAt: null };
    if (filters.status) where['status'] = filters.status;
    if (filters.assignedToId) where['assignedToId'] = filters.assignedToId;
    if (filters.productId) where['productId'] = filters.productId;
    if (filters.accountId) where['accountId'] = filters.accountId;
    if (filters.restrictToUserId) where['assignedToId'] = filters.restrictToUserId;

    if (filters.search) {
      where['OR'] = [
        { firstName: { contains: filters.search, mode: 'insensitive' } },
        { lastName: { contains: filters.search, mode: 'insensitive' } },
        { companyName: { contains: filters.search, mode: 'insensitive' } },
        { mobile: { contains: filters.search } },
      ];
    }

    return where;
  }

  async countMatching(filters: {
    status?: LeadStatus | undefined;
    assignedToId?: string | undefined;
    search?: string | undefined;
    restrictToUserId?: string | undefined;
  }): Promise<number> {
    return this.prisma.client.lead.count({ where: this.listWhere(filters) });
  }

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
    const where = this.listWhere(filters);

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
        // Name and SKU only. The detail page shows what the product IS, not
        // the whole catalogue row.
        product: { select: { id: true, name: true, sku: true, active: true } },
        // Name and status only. Whether this is an existing customer is the
        // single most useful thing to know when opening a lead.
        account: { select: { id: true, name: true, status: true } },
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
  async nextLeadNumber(tx?: PrismaTransaction): Promise<string> {
    const latest = await (tx ?? this.prisma.client).lead.findFirst({
      orderBy: { leadNumber: 'desc' },
      select: { leadNumber: true },
    });

    const current = latest ? Number(latest.leadNumber.replace(/\D/g, '')) : 0;
    return `LD-${String(current + 1).padStart(5, '0')}`;
  }

  /**
   * Serialises lead numbering for ONE tenant, for the life of a transaction.
   *
   * Read-then-write numbering is racy by construction: two transactions read
   * LD-00019 and both try to write LD-00020. The interactive path survives that
   * by catching the unique violation and retrying, which is fine when a person
   * is waiting for a response — but inside the automated pipeline's single
   * transaction a raised constraint aborts EVERYTHING, including the lead, the
   * follow-up and the intake status, and the retry would have nothing left to
   * retry into.
   *
   * An advisory lock is the narrow fix: it serialises numbering without locking
   * any row, so concurrent conversions queue for the number and nothing else.
   * It is transaction-scoped, so it is released on commit or rollback with
   * nothing to clean up, and it is keyed per organization, so one tenant's
   * traffic never waits on another's.
   *
   * The two-argument form takes a namespace and a key. The namespace is a
   * constant private to lead numbering, so this can never collide with an
   * advisory lock taken elsewhere for something else.
   */
  async lockLeadNumbering(tx: PrismaTransaction): Promise<void> {
    const organizationId = this.tenantContext.requireOrganizationId();

    /*
     * $executeRaw, not $queryRaw, and that is not a style choice.
     *
     * pg_advisory_xact_lock returns `void`, and the driver adapter cannot
     * deserialize a void column — $queryRaw fails at the point of reading a
     * result there is no type for. $executeRaw is for statements whose result
     * is not read, which is exactly what taking a lock is.
     */
    // eslint-disable-next-line no-restricted-syntax -- Prisma cannot express an advisory lock; organizationId is bound explicitly and covered by test/tenant-isolation.e2e-spec.ts
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(${LEAD_NUMBER_LOCK_NAMESPACE}::int, hashtext(${organizationId}::text))
    `;
  }

  /**
   * Creates the lead and its opening timeline entries in one transaction.
   *
   * Returns the id rather than the row: the caller re-reads through findById so
   * a created lead has exactly the same shape as every other lead read.
   *
   * A caller may supply its own transaction, and the automated intake pipeline
   * does. That pipeline has to commit the lead, its activities, the first
   * follow-up and the intake's PROCESSED status together or not at all — a
   * lead whose follow-up was rolled back is exactly the "lead left behind"
   * this product exists to prevent. Opening a nested transaction here would
   * defeat that, so when one is passed it is used as-is.
   */
  async createWithActivity(input: {
    leadNumber: string;
    firstName: string;
    lastName?: string | undefined;
    /**
     * Null where the lead has no phone number.
     *
     * The column has always been nullable and the duplicate index is
     * `WHERE mobile IS NOT NULL`, so this is the state the schema was designed
     * for rather than a relaxation of it.
     */
    mobile: string | null;
    email?: string | undefined;
    companyName?: string | undefined;
    city?: string | undefined;
    source?: string | undefined;
    productId?: string | undefined;
    /** Verified to belong to this tenant by the service before it reaches here. */
    accountId?: string | undefined;
    productInterest?: string | undefined;
    estimatedValue?: number | undefined;
    status: LeadStatus;
    priority: LeadPriority;
    assignedToId?: string | undefined;
    nextFollowUpAt: Date | null;
    contactId?: string | undefined;
    /**
     * True when the caller passed `allowDuplicate`.
     *
     * Recorded on the row so the partial unique index lets it through. Without
     * it the index refuses what the API just agreed to.
     */
    duplicateAcknowledged?: boolean | undefined;
    /**
     * Null for a SYSTEM write.
     *
     * `created_by` and `updated_by` are nullable columns with no foreign key,
     * so null records honestly that nobody typed this lead. `assigned_by` and
     * the activity's `performed_by` DO have foreign keys to users, which is
     * the concrete reason a synthetic actor id cannot be used here: it would
     * not resolve to a row, and the insert would fail.
     */
    actorId: string | null;
    /** Supplied when this write belongs to a caller's larger transaction. */
    tx?: PrismaTransaction | undefined;
  }) {
    const organizationId = this.tenantContext.requireOrganizationId();

    const run = async (tx: PrismaTransaction) => {
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
          productId: input.productId ?? null,
          accountId: input.accountId ?? null,
          productInterest: input.productInterest ?? null,
          estimatedValue: input.estimatedValue ?? null,
          status: input.status,
          priority: input.priority,
          assignedToId: input.assignedToId ?? null,
          assignedById: input.assignedToId ? input.actorId : null,
          nextFollowUpAt: input.nextFollowUpAt,
          contactId: input.contactId ?? null,
          duplicateAcknowledgedAt: input.duplicateAcknowledged ? new Date() : null,
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
    };

    return input.tx ? run(input.tx) : this.prisma.client.$transaction(run);
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
    // The configured deployment default, not a constant: an organization
    // with no country is a row that predates the column, and guessing 'US'
    // for an India-first product read every local number as American.
    return organization?.country ?? this.config.get('DEFAULT_COUNTRY');
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
  /**
   * Whether a product id belongs to THIS organization.
   *
   * The tenant extension scopes queries; a foreign key does not. Without this
   * check, Org A could set productId to Org B's product — the insert would
   * succeed, the FK is satisfied, and Org B's catalogue entry would start
   * accumulating Org A's leads in its KPIs. Nothing would look wrong until the
   * numbers were compared.
   *
   * Goes through the scoped client, so a foreign id simply is not found.
   */
  async productExists(productId: string): Promise<boolean> {
    const product = await this.prisma.client.product.findFirst({
      where: { id: productId },
      select: { id: true },
    });
    return product !== null;
  }

  /**
   * Whether an account id belongs to THIS organization.
   *
   * Read through the tenant-scoped client, so an id from another organization
   * simply does not resolve. See assertAccountExists in the service for why
   * this check has to exist at all.
   */
  async accountExists(accountId: string): Promise<boolean> {
    const account = await this.prisma.client.account.findFirst({
      where: { id: accountId, deletedAt: null },
      select: { id: true },
    });
    return account !== null;
  }

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
  /**
   * Applies a lead mutation, its mandatory timeline entry, and — when the lead
   * stops being live work — the cancellation of its open follow-ups, as ONE
   * transaction.
   *
   * These were four separate writes. Any of them could fail after the others
   * had committed, leaving a lead whose timeline does not explain its own
   * state, or a won deal still carrying overdue follow-ups.
   *
   * Cancelling rather than deleting is deliberate: what the team had planned to
   * do next is part of the relationship history, and a manager reviewing a lost
   * deal wants to see the attempts that were still scheduled when it died.
   *
   * Returns the number of lead rows changed, so the caller can tell "not found"
   * from "nothing to do".
   */
  async applyLifecycleChange(input: {
    leadId: string;
    data: Record<string, unknown>;
    /** True when the lead is becoming WON, LOST or archived. */
    closesLead: boolean;
    /**
     * True only for WON.
     *
     * Promotes the lead's account to CUSTOMER inside this same transaction. It
     * belongs here rather than in a service because the promotion must be
     * ATOMIC with the win: a separate call could fail after the win committed,
     * leaving a paying customer recorded as a prospect and absent from every
     * retention figure, with nothing to indicate it had happened.
     */
    winsLead?: boolean | undefined;
    activityType: ActivityType;
    description: string;
    actorId: string;
    cancelReason?: string | undefined;
  }): Promise<{ leadsChanged: number; followUpsCancelled: number }> {
    const organizationId = this.tenantContext.requireOrganizationId();

    return this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.lead.updateMany({
        where: { id: input.leadId, deletedAt: null },
        data: input.data,
      });

      if (updated.count === 0) return { leadsChanged: 0, followUpsCancelled: 0 };

      let followUpsCancelled = 0;

      if (input.closesLead) {
        const cancelled = await tx.followUp.updateMany({
          where: {
            leadId: input.leadId,
            status: { in: ['UPCOMING', 'DUE', 'OVERDUE'] },
          },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelledReason: input.cancelReason ?? 'Lead closed',
          },
        });
        followUpsCancelled = cancelled.count;
      }

      /*
       * Winning a deal PROMOTES the customer that is already there. It never
       * creates one.
       *
       * Before accounts existed, "customer" was a company name typed onto a
       * lead, so a repeat customer's second win produced a second record that
       * looked exactly like a new customer — double-counting acquisition and
       * making retention impossible to measure. Here the account is found, and
       * a lead with none does nothing at all: inventing a company from a
       * free-text field is precisely the mistake this feature exists to undo.
       */
      if (input.winsLead) {
        const lead = await tx.lead.findFirst({
          where: { id: input.leadId },
          select: { accountId: true, wonAt: true },
        });

        if (lead?.accountId) {
          const account = await tx.account.findFirst({
            where: { id: lead.accountId },
            select: { firstWonAt: true },
          });

          if (account) {
            const wonAt = lead.wonAt ?? new Date();

            await tx.account.updateMany({
              where: { id: lead.accountId },
              data: {
                // DORMANT and FORMER_CUSTOMER are promoted back too: someone
                // who buys again is a customer again.
                status: 'CUSTOMER',
                // Set once, never overwritten. Moving it forward on every
                // repeat purchase would make a five-year customer look like
                // this month's new business.
                ...(account.firstWonAt ? {} : { firstWonAt: wonAt }),
                lastWonAt: wonAt,
                lastActivityAt: wonAt,
                updatedBy: input.actorId,
              },
            });
          }
        }
      }

      // In the same transaction, so a lead can never end up in a state its own
      // timeline does not account for.
      await tx.leadActivity.create({
        data: {
          organizationId,
          leadId: input.leadId,
          activityType: input.activityType,
          description:
            followUpsCancelled > 0
              ? `${input.description} — ${followUpsCancelled} open follow-${
                  followUpsCancelled === 1 ? 'up' : 'ups'
                } cancelled`
              : input.description,
          performedById: input.actorId,
        },
      });

      return { leadsChanged: updated.count, followUpsCancelled };
    });
  }

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

    const closesLead = input.status === 'WON' || input.status === 'LOST';

    await this.applyLifecycleChange({
      leadId: input.leadId,
      data: {
        status: input.status,
        wonAt: effects.wonAt,
        lostAt: effects.lostAt,
        lostReason: effects.lostReason,
        wonValue: effects.wonValue ?? null,
        // A closed lead has no next action; the CHECK constraint allows null
        // only for a terminal status, so this must move with the status.
        ...(closesLead ? { nextFollowUpAt: null } : {}),
        updatedBy: input.actorId,
      },
      closesLead,
      winsLead: input.status === 'WON',
      activityType:
        input.status === 'WON' ? 'LEAD_WON' : input.status === 'LOST' ? 'LEAD_LOST' : 'STATUS_CHANGED',
      description:
        input.status === 'LOST' && input.lostReason
          ? `Marked lost: ${input.lostReason}`
          : `Status changed to ${input.status}`,
      actorId: input.actorId,
      cancelReason: `Lead marked ${input.status}`,
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

/**
 * The advisory-lock namespace for lead numbering.
 *
 * Advisory locks share one global space per database, so an arbitrary integer
 * could collide with a lock taken for a completely unrelated reason and produce
 * a deadlock nobody could explain. A named constant used in exactly one place
 * makes that impossible to do by accident.
 */
const LEAD_NUMBER_LOCK_NAMESPACE = 8317;
