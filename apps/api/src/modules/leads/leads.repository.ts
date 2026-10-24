import { Injectable } from '@nestjs/common';
import type { LeadPriority, LeadStatus } from '@leadflow/api-types';
import { AWAITING_RESPONSE_OUTCOMES, PERMISSIONS } from '@leadflow/api-types';
import type { ActivityType } from '../../generated/prisma/enums';
import type { Prisma } from '../../generated/prisma/client';
import { sideEffectsFor } from './lead-status';
import { PrismaService, type PrismaTransaction } from '../../common/prisma/prisma.service';
import { initialFollowUpStatus } from '../follow-ups/follow-ups.repository';
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
/**
 * Everything the lead list and its total can be narrowed by.
 *
 * ONE type, used by `listWhere`, `list` and `countMatching` alike. They
 * previously declared three different inline shapes and the two narrow ones
 * omitted several real filters; the values still arrived through a spread, so
 * the compiler never objected and the omission was invisible. A filter added to
 * the page but not the count produces "showing 25 of 812" over a list of
 * fourteen, which is the kind of wrong that gets reported as a data bug.
 */
/**
 * What the creation entry on the timeline says.
 *
 * The duplicate clause is appended rather than replacing the source, because
 * both facts matter to whoever reads the record later: where the lead came
 * from, and that somebody deliberately allowed it alongside an existing one.
 */
function creationDescription(source?: string, duplicateOfLeadNumber?: string): string {
  const base = source ? `Lead captured from ${source}` : 'Lead created';

  return duplicateOfLeadNumber
    ? `${base} — created deliberately alongside existing lead ${duplicateOfLeadNumber}`
    : base;
}

export interface LeadListFilters {
  status?: LeadStatus | undefined;
  assignedToId?: string | undefined;
  /** Only leads with no owner — the ones no follow-up queue can show. */
  unassigned?: boolean | undefined;
  productId?: string | undefined;
  accountId?: string | undefined;
  search?: string | undefined;
  /**
   * Owner restriction derived from the caller's permissions. Applied AFTER the
   * caller-supplied assignedToId filter so a rep cannot widen their own
   * visibility by passing someone else's id in the query string.
   */
  restrictToUserId?: string | undefined;
  /** Every lead from one CSV import, for correcting a bad run. */
  importBatchId?: string | undefined;
  /**
   * Which lifecycle states to include. Defaults to ACTIVE only.
   *
   * Not a boolean, because there are three useful answers and a boolean gives
   * two: the working pipeline, the records somebody took out of service, and —
   * for the import-correction screen — everything from one batch whatever state
   * it is in.
   */
  lifecycle?: 'ACTIVE' | 'INACTIVE' | 'ALL' | undefined;
  /**
   * Leads nobody has worked yet: still NEW and never reached. The "New leads"
   * tile on the sales workspace — distinct from status NEW alone, which also
   * matches a lead three calls deep where nobody has answered.
   */
  fresh?: boolean | undefined;
  /** Waiting on the CUSTOMER: last outcome was "awaiting response", or a quotation is out. */
  awaiting?: boolean | undefined;
  /** Exactly this last outcome (a CALL_OUTCOMES code). */
  lastOutcome?: string | undefined;
}

/**
 * What a summary row carries beyond the lead's own columns: the open follow-up
 * that is its next action, and its latest timeline entry.
 *
 * Each is `take: 1` per lead, which Prisma resolves in ONE extra query for the
 * whole page (not one per row), so a 25-row list stays three round trips.
 */
export const LEAD_SUMMARY_INCLUDE = {
  assignedTo: { select: { id: true, fullName: true } },
  followUps: {
    where: { status: { in: ['UPCOMING', 'DUE', 'OVERDUE'] } },
    orderBy: { scheduledAt: 'asc' },
    take: 1,
    select: {
      id: true,
      type: true,
      title: true,
      scheduledAt: true,
      assignedUser: { select: { id: true, fullName: true } },
    },
  },
  activities: {
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: { activityType: true, description: true, createdAt: true },
  },
} satisfies Prisma.LeadInclude;

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
  private listWhere(filters: LeadListFilters): Record<string, unknown> {
    const where: Record<string, unknown> = { deletedAt: null };

    /*
     * Deactivated leads are OUT of the default list, every count and every
     * dashboard that goes through here.
     *
     * That is the whole point of the state: a wrongly imported lead must stop
     * distorting the forecast. `INACTIVE` is the explicit filter that makes
     * those rows reachable again, and `ALL` exists for the import-correction
     * screen, which has to show what it is about to act on regardless of state.
     */
    if (filters.lifecycle === 'INACTIVE') where['deactivatedAt'] = { not: null };
    else if (filters.lifecycle !== 'ALL') where['deactivatedAt'] = null;

    if (filters.importBatchId) where['importBatchId'] = filters.importBatchId;
    if (filters.status) where['status'] = filters.status;
    if (filters.assignedToId) where['assignedToId'] = filters.assignedToId;
    // An AND clause rather than `assignedToId = null`, so the owner restriction
    // below INTERSECTS with it instead of overwriting it. A rep who may see only
    // their own leads gets an empty list here — never their own leads mislabelled
    // as unassigned.
    const and: Record<string, unknown>[] = [];
    if (filters.unassigned) and.push({ assignedToId: null });
    if (filters.fresh) and.push({ status: 'NEW', lastContactedAt: null });
    if (filters.awaiting) {
      and.push({
        status: { notIn: ['WON', 'LOST'] },
        OR: [{ lastOutcome: { in: [...AWAITING_RESPONSE_OUTCOMES] } }, { status: 'QUOTATION_SENT' }],
      });
    }
    if (filters.lastOutcome) and.push({ lastOutcome: filters.lastOutcome });
    if (and.length > 0) where['AND'] = and;
    if (filters.productId) where['productId'] = filters.productId;
    if (filters.accountId) where['accountId'] = filters.accountId;
    if (filters.restrictToUserId) where['assignedToId'] = filters.restrictToUserId;

    if (filters.search) {
      where['OR'] = [
        { firstName: { contains: filters.search, mode: 'insensitive' } },
        { lastName: { contains: filters.search, mode: 'insensitive' } },
        { companyName: { contains: filters.search, mode: 'insensitive' } },
        { mobile: { contains: filters.search } },
        // Email was missing, so searching for a customer by the address they
        // wrote from found nothing — on exactly the leads that have no phone
        // number and are hardest to find any other way.
        { email: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    return where;
  }

  async countMatching(filters: LeadListFilters): Promise<number> {
    return this.prisma.client.lead.count({ where: this.listWhere(filters) });
  }

  async list(filters: LeadListFilters & { cursor?: string | undefined; limit: number }) {
    const where = this.listWhere(filters);

    // Fetch one extra row to determine hasMore without a second count query.
    return this.prisma.client.lead.findMany({
      where,
      take: filters.limit + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
      orderBy: { createdAt: 'desc' },
      include: LEAD_SUMMARY_INCLUDE,
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

  /**
   * The lead for its DETAIL page: findById plus the next action and latest
   * timeline entry the summary carries.
   *
   * Separate from findById on purpose. findById is also every mutation's
   * visibility check, and those must not pay for two extra subqueries.
   */
  async findDetailById(id: string, restrictToUserId?: string) {
    return this.prisma.client.lead.findFirst({
      where: {
        id,
        deletedAt: null,
        ...(restrictToUserId ? { assignedToId: restrictToUserId } : {}),
      },
      include: {
        ...LEAD_SUMMARY_INCLUDE,
        assignedBy: { select: { id: true, fullName: true } },
        product: { select: { id: true, name: true, sku: true, active: true } },
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
      where: {
        mobile,
        deletedAt: null,
        // Mirrors `leads_org_mobile_uniq` / `leads_org_email_uniq`, which gained
        // this clause in 20261013090000: a deactivated lead RELEASES its mobile
        // and email so the corrected record can be created. Without it here the
        // pre-check would refuse a lead the database would accept, blocking the
        // deactivate-then-recreate workflow with its own guard.
        deactivatedAt: null,
        status: { not: 'LOST' },
      },
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
   * Just enough of a lead to decide a lifecycle change.
   *
   * Deliberately NOT `findById`, which applies the assignee visibility filter
   * and returns the whole detail projection. Deactivation is an administrative
   * correction aimed at records that may be assigned to somebody else or to
   * nobody, so a visibility filter here would make the feature unable to reach
   * the rows it exists for. Tenant isolation is untouched — this read runs in
   * the tenant context like every other.
   *
   * Soft-deleted rows are excluded: an archived lead is already out of service
   * and is not the thing deactivation is for.
   */
  async findLifecycleState(id: string) {
    return this.prisma.client.lead.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        leadNumber: true,
        status: true,
        mobile: true,
        email: true,
        deactivatedAt: true,
        deactivationReason: true,
      },
    });
  }

  /**
   * The same question, asked of the email address.
   *
   * Secondary to mobile but a real duplicate key since
   * `leads_org_email_uniq` — an enquiry carrying an address and no number used
   * to have no key at all. Case-insensitive, because that index is keyed on
   * lower(email) and stored addresses are not uniformly normalised: comparing
   * raw strings would miss the duplicate it exists to catch.
   *
   * Acknowledged duplicates are excluded here as well as in the predicate, so
   * a deliberately created second lead is not reported as an accident.
   */
  async findActiveByEmail(email: string) {
    return this.prisma.client.lead.findFirst({
      where: {
        email: { equals: email, mode: 'insensitive' },
        deletedAt: null,
        // Mirrors `leads_org_mobile_uniq` / `leads_org_email_uniq`, which gained
        // this clause in 20261013090000: a deactivated lead RELEASES its mobile
        // and email so the corrected record can be created. Without it here the
        // pre-check would refuse a lead the database would accept, blocking the
        // deactivate-then-recreate workflow with its own guard.
        deactivatedAt: null,
        status: { not: 'LOST' },
        duplicateAcknowledgedAt: null,
      },
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
   * Read-then-write, and therefore only correct while the caller holds the
   * tenant's numbering lock — which is why the only caller is
   * `createWithActivity`, immediately after taking it. Called without that
   * lock, two concurrent creates read the same maximum and choose the same
   * number.
   *
   * Kept separate from the insert rather than inlined so the allocation rule
   * — read the highest, add one, pad to five digits — is stated once and can
   * be read on its own. The lock is what makes it safe; this is what makes
   * it correct.
   */
  private async nextLeadNumber(tx: PrismaTransaction): Promise<string> {
    const latest = await tx.lead.findFirst({
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
   * LD-00019 and both try to write LD-00020. This lock is what makes the
   * allocation below it correct, and it is taken by `createWithActivity` on
   * EVERY path — a person creating a lead by hand, a CSV import, and the
   * automated website-intake pipeline.
   *
   * That universality is the point. While only the automated path took it, a
   * manual create running at the same moment could still pick the same
   * number: the automated transaction then lost the unique violation and
   * rolled back, leaving its enquiry retryable but its work wasted. A lock
   * only one participant respects is not a lock.
   *
   * An advisory lock rather than a row lock: it serialises numbering without
   * locking any lead, so concurrent creates queue for the number and nothing
   * else. It is transaction-scoped, so it is released on commit or rollback
   * with nothing to clean up — a failed create cannot strand the allocator —
   * and keyed per organization, so one tenant's traffic never waits on
   * another's.
   *
   * Re-entrant within a transaction: taking it twice is counted, not
   * deadlocked, and both are released at the end. A caller that already
   * holds it for its own reasons therefore costs nothing.
   *
   * The two-argument form takes a namespace and a key. The namespace is a
   * constant private to lead numbering, so this can never collide with an
   * advisory lock taken elsewhere for something else.
   */
  private async lockLeadNumbering(tx: PrismaTransaction): Promise<void> {
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
   *
   * THE LEAD NUMBER IS ALLOCATED HERE, not by the caller.
   *
   * This is the single place every lead is written — by hand, by CSV import,
   * or by the intake pipeline — so it is the only place the tenant's
   * numbering lock can be taken on behalf of all of them. A caller that
   * computed its own number would be allocating outside the lock however
   * carefully it was written, which is exactly the race this closes.
   */
  async createWithActivity(input: {
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
    /**
     * The rest of the postal address.
     *
     * `city` above predates these and is unchanged. Together they are what a
     * CSV with an "Address Line 1" column can finally be mapped onto — before
     * this the importer had nowhere to put it, so it was dropped.
     */
    addressLine1?: string | undefined;
    addressLine2?: string | undefined;
    state?: string | undefined;
    postalCode?: string | undefined;
    /** ISO 3166-1 alpha-2. Upper-cased by the caller. */
    country?: string | undefined;
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
     * What this lead knowingly duplicates, e.g. "LD-00042".
     *
     * Written onto the creation activity, because `duplicate_acknowledged_at`
     * records only THAT a second lead was allowed — not which record it is a
     * second copy of, which is the first thing anybody reviewing two live leads
     * for one customer asks. The timeline is append-only and lives on the lead
     * itself, so the answer survives the import batch row being deleted.
     */
    duplicateOfLeadNumber?: string | undefined;
    /**
     * The import run that created this lead, when one did.
     *
     * Carried on the row so "every lead from that badly mapped file" is one
     * query rather than a manual hunt. Null for a lead a person typed in.
     */
    importBatchId?: string | undefined;
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
    /**
     * What to call the first follow-up. Defaults to 'First contact'.
     *
     * The website pipeline passes its own wording because the row means
     * something more specific there — a first RESPONSE, against an SLA
     * measured from when the enquiry arrived.
     */
    followUpTitle?: string | undefined;
    /** Supplied when this write belongs to a caller's larger transaction. */
    tx?: PrismaTransaction | undefined;
  }) {
    const organizationId = this.tenantContext.requireOrganizationId();

    const run = async (tx: PrismaTransaction) => {
      /*
       * Lock, then allocate, then insert — all on the SAME transaction.
       *
       * Every read here takes `tx`. A pooled read inside a transaction that
       * already holds a connection deadlocks the moment the pool is empty,
       * which on a single-connection database is immediately; this project
       * has hit that more than once.
       */
      await this.lockLeadNumbering(tx);
      const leadNumber = await this.nextLeadNumber(tx);

      const created = await tx.lead.create({
        data: {
          organizationId,
          leadNumber,
          firstName: input.firstName,
          lastName: input.lastName ?? null,
          mobile: input.mobile,
          email: input.email ?? null,
          companyName: input.companyName ?? null,
          city: input.city ?? null,
          addressLine1: input.addressLine1 ?? null,
          addressLine2: input.addressLine2 ?? null,
          state: input.state ?? null,
          postalCode: input.postalCode ?? null,
          country: input.country ?? null,
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
          importBatchId: input.importBatchId ?? null,
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
          description: creationDescription(input.source, input.duplicateOfLeadNumber),
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

        /*
         * The next action becomes a REAL follow-up, in this same transaction.
         *
         * Before this, create set `next_follow_up_at` and nothing else — so
         * every manually created and every imported lead showed a next-action
         * date beside "Follow-ups: 0 open", and the work never appeared in
         * anybody's queue. The column is a MIRROR of the earliest open
         * follow-up; a lead promising an action with no row behind it is the
         * inconsistency this model exists to rule out.
         *
         * Guarded by `assignedToId` because `follow_ups.assigned_user_id` is
         * NOT NULL with a foreign key: an unassigned follow-up cannot exist.
         * For an unassigned lead the mirror alone is the honest answer — "this
         * needs doing by then, and nobody owns it yet" — and inventing an
         * assignee would hand the work to whoever imported a file.
         *
         * The intake pipeline already did this correctly and is unchanged;
         * these are the three paths that did not.
         */
        if (input.nextFollowUpAt) {
          await tx.followUp.create({
            data: {
              organizationId,
              leadId: created.id,
              assignedUserId: input.assignedToId,
              scheduledAt: input.nextFollowUpAt,
              type: 'CALL',
              /*
               * DUE from the first instant when the date has already passed.
               *
               * The website pipeline measures its SLA from when the enquiry
               * ARRIVED, so a sweep that ran late converts with a schedule in
               * the past — and a row left UPCOMING would appear in neither the
               * due nor the overdue view.
               */
              status: initialFollowUpStatus(input.nextFollowUpAt),
              title: input.followUpTitle ?? 'First contact',
              createdBy: input.actorId,
            },
          });
        }
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
   * Whether an active member can see leads they do not own (team or all).
   *
   * A follow-up assigned to someone lands in THEIR queue; if they can only see
   * their own leads, they could not open the lead or log the call. Used to
   * refuse handing somebody work they cannot do.
   */
  async memberSeesOthersLeads(userId: string): Promise<boolean> {
    const count = await this.prisma.client.organizationUser.count({
      where: {
        userId,
        status: 'ACTIVE',
        role: {
          permissions: {
            some: { permission: { key: { in: [PERMISSIONS.LEAD_VIEW_ALL, PERMISSIONS.LEAD_VIEW_TEAM] } } },
          },
        },
      },
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
    /** Supplied when this is one step of a caller's larger atomic operation. */
    tx?: PrismaTransaction | undefined;
  }): Promise<{ leadsChanged: number; followUpsCancelled: number }> {
    const organizationId = this.tenantContext.requireOrganizationId();

    const run = async (tx: PrismaTransaction) => {
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
    };

    return input.tx ? run(input.tx) : this.prisma.client.$transaction(run);
  }

  async applyUpdate(leadId: string, data: Record<string, unknown>): Promise<number> {
    const result = await this.prisma.client.lead.updateMany({
      where: { id: leadId, deletedAt: null },
      data,
    });
    return result.count;
  }

  /**
   * Changes the owner AND moves the owed work with the lead, in one commit.
   *
   * THE DEFECT THIS FIXES. Reassignment set `assigned_to` and nothing else, so
   * the open follow-up kept the previous owner. The new owner's queue never
   * showed the lead, and the previous owner kept being reminded about a lead
   * their visibility no longer let them open. An unassigned lead — which can
   * only carry the date mirror, because a follow-up row needs an owner — stayed
   * out of every queue for good even after somebody was given it.
   *
   * WHAT MOVES. Open follow-ups owed by the PREVIOUS owner move to the new one.
   * A follow-up a manager scheduled for themselves on this lead stays theirs —
   * that is a commitment the manager made, not the lead's owner.
   *
   * WHAT IS CREATED. When nothing is open afterwards but the lead is live and
   * carries a next-action date, a follow-up is created for the new owner AT
   * THAT DATE. No date is invented: it is the one the lead already promised,
   * finally given a row so it reaches a queue.
   *
   * The lead's row is updated first, which takes its row lock — the same lock
   * every follow-up write holds — so a "no answer" logged mid-reassignment
   * cannot be handed to the wrong person.
   */
  async reassign(input: {
    leadId: string;
    previousOwnerId: string | null;
    newOwnerId: string;
    actorId: string;
    activityType: ActivityType;
    description: string;
  }): Promise<{ leadsChanged: number; followUpsMoved: number; followUpCreated: boolean }> {
    const organizationId = this.tenantContext.requireOrganizationId();

    return this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.lead.updateMany({
        where: { id: input.leadId, deletedAt: null },
        data: {
          assignedToId: input.newOwnerId,
          assignedById: input.actorId,
          updatedBy: input.actorId,
        },
      });
      if (updated.count === 0) return { leadsChanged: 0, followUpsMoved: 0, followUpCreated: false };

      const moved = input.previousOwnerId
        ? await tx.followUp.updateMany({
            where: {
              leadId: input.leadId,
              assignedUserId: input.previousOwnerId,
              status: { in: ['UPCOMING', 'DUE', 'OVERDUE'] },
            },
            data: { assignedUserId: input.newOwnerId },
          })
        : { count: 0 };

      const lead = await tx.lead.findFirst({
        where: { id: input.leadId },
        select: { status: true, deactivatedAt: true, nextFollowUpAt: true },
      });
      const live =
        lead !== null &&
        lead.deactivatedAt === null &&
        lead.status !== 'WON' &&
        lead.status !== 'LOST';

      let followUpCreated = false;
      if (live && lead.nextFollowUpAt) {
        const open = await tx.followUp.count({
          where: { leadId: input.leadId, status: { in: ['UPCOMING', 'DUE', 'OVERDUE'] } },
        });

        if (open === 0) {
          await tx.followUp.create({
            data: {
              organizationId,
              leadId: input.leadId,
              assignedUserId: input.newOwnerId,
              scheduledAt: lead.nextFollowUpAt,
              type: 'CALL',
              status: initialFollowUpStatus(lead.nextFollowUpAt),
              title: 'First contact',
              createdBy: input.actorId,
            },
          });
          followUpCreated = true;
        }
      }

      const description =
        moved.count > 0
          ? `${input.description} — ${moved.count} open follow-${moved.count === 1 ? 'up' : 'ups'} handed over`
          : followUpCreated
            ? `${input.description} — next action added to the new owner's queue`
            : input.description;

      await tx.leadActivity.create({
        data: {
          organizationId,
          leadId: input.leadId,
          activityType: input.activityType,
          description,
          performedById: input.actorId,
        },
      });

      return { leadsChanged: updated.count, followUpsMoved: moved.count, followUpCreated };
    });
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
    tx?: PrismaTransaction | undefined;
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
      tx: input.tx,
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
