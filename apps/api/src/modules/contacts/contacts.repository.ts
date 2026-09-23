import { Injectable } from '@nestjs/common';
import { PrismaService, type PrismaTransaction } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
import { AppConfig } from '../../common/config/config.module';

/**
 * Contact data access.
 *
 * `Contact` is registered in TENANT_SCOPED_MODELS, so reads are narrowed
 * automatically and none of these queries mentions organizationId. Writes name
 * it explicitly, because Prisma's generated types cannot see the extension.
 */
@Injectable()
export class ContactsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly config: AppConfig,
  ) {}

  /** Excludes merged and deleted rows — both are tombstones, not people. */
  private readonly live = { deletedAt: null, mergedIntoId: null };

  async findById(id: string) {
    return this.prisma.client.contact.findFirst({
      where: { id, deletedAt: null },
      include: {
        leads: {
          where: { deletedAt: null },
          select: {
            id: true,
            leadNumber: true,
            status: true,
            priority: true,
            estimatedValue: true,
            nextFollowUpAt: true,
            createdAt: true,
            assignedTo: { select: { id: true, fullName: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
  }

  /** Shared by page() and countAll() so the total always matches the page. */
  private listWhere(search?: string): Record<string, unknown> {
    const where: Record<string, unknown> = { ...this.live };

    if (search) {
      where['OR'] = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { companyName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { mobile: { contains: search } },
      ];
    }

    return where;
  }

  async page(filters: { search?: string | undefined; cursor?: string | undefined; limit: number }) {
    return this.prisma.client.contact.findMany({
      where: this.listWhere(filters.search),
      take: filters.limit + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { leads: true } } },
    });
  }

  /**
   * The organization's country, used to canonicalise phone input to E.164.
   *
   * Tenant data rather than a constant: the same digits mean different numbers
   * in different countries, and getting it wrong silently breaks duplicate
   * matching, which is entirely built on the canonical form.
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

  async countAll(search?: string): Promise<number> {
    return this.prisma.client.contact.count({ where: this.listWhere(search) });
  }

  async create(input: {
    firstName?: string | undefined;
    lastName?: string | undefined;
    /** Null for a contact with no phone number — an Instagram or Messenger lead. */
    mobile?: string | null | undefined;
    email?: string | undefined;
    companyName?: string | undefined;
    city?: string | undefined;
    notes?: string | undefined;
    /**
     * Null for a SYSTEM write.
     *
     * `created_by` and `updated_by` are nullable with no foreign key, so null
     * is the honest value for a contact the automated intake pipeline created:
     * nobody typed it. Borrowing a real user's id would attribute the record
     * to somebody who was not there.
     */
    actorId: string | null;
    /** Supplied when this write is part of a caller's larger transaction. */
    tx?: PrismaTransaction | undefined;
  }) {
    const organizationId = this.tenantContext.requireOrganizationId();

    return (input.tx ?? this.prisma.client).contact.create({
      data: {
        organizationId,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        mobile: input.mobile ?? null,
        email: input.email ?? null,
        companyName: input.companyName ?? null,
        city: input.city ?? null,
        notes: input.notes ?? null,
        createdBy: input.actorId,
        updatedBy: input.actorId,
      },
    });
  }

  async update(id: string, data: Record<string, unknown>): Promise<number> {
    const result = await this.prisma.client.contact.updateMany({
      where: { id, deletedAt: null },
      data,
    });
    return result.count;
  }

  /**
   * Finds or creates the contact for a person, keyed on E.164 mobile.
   *
   * A null mobile ALWAYS creates a new contact. There is nothing to match on,
   * and treating "no number" as a shared key would collapse every numberless
   * enquiry — every Instagram and Messenger lead — into a single contact
   * holding several unrelated customers' history.
   */
  async findOrCreateByMobile(input: {
    mobile: string | null;
    firstName?: string | undefined;
    lastName?: string | undefined;
    email?: string | undefined;
    companyName?: string | undefined;
    city?: string | undefined;
    actorId: string | null;
    /**
     * Supplied when this is part of a caller's transaction.
     *
     * The automated path needs the lookup AND the insert inside the same
     * transaction as the lead: a contact created for a lead that then rolls
     * back would be a person in the CRM with no enquiry behind them.
     */
    tx?: PrismaTransaction | undefined;
  }) {
    const db = input.tx ?? this.prisma.client;

    if (input.mobile !== null) {
      const existing = await db.contact.findFirst({
        where: { mobile: input.mobile, ...this.live },
      });

      if (existing) return existing;
    }

    return this.create({ ...input, email: input.email?.toLowerCase() });
  }

  // ---------------------------------------------------------------------------
  // Duplicate detection
  // ---------------------------------------------------------------------------

  /**
   * Candidate duplicates of one contact.
   *
   * Matches on E.164 mobile or lowercased email only. Deliberately NOT on name
   * or company: "John Smith at Acme" matches far too readily, and a merge is
   * destructive, so a false positive presented as a suggestion is how two real
   * customers get combined.
   */
  async findDuplicatesOf(contact: { id: string; mobile: string | null; email: string | null }) {
    const matchers: Record<string, unknown>[] = [];
    if (contact.mobile) matchers.push({ mobile: contact.mobile });
    if (contact.email) matchers.push({ email: contact.email });
    if (matchers.length === 0) return [];

    return this.prisma.client.contact.findMany({
      where: { id: { not: contact.id }, OR: matchers, ...this.live },
      include: { _count: { select: { leads: true } } },
      take: 25,
    });
  }

  /**
   * Every duplicate cluster in the organization.
   *
   * groupBy rather than a self-join, so the database does the work and the
   * result is bounded by the number of DUPLICATED values rather than the number
   * of contacts.
   */
  async duplicateGroups(limit: number) {
    const [byMobile, byEmail] = await Promise.all([
      this.prisma.client.contact.groupBy({
        by: ['mobile'],
        where: { mobile: { not: null }, ...this.live },
        _count: { _all: true },
        having: { mobile: { _count: { gt: 1 } } },
        // Explicit, because `take` on a groupBy needs an order and Prisma's
        // implicit fallback is `id`, which is not one of the by-fields.
        orderBy: { mobile: 'asc' },
        take: limit,
      }),
      this.prisma.client.contact.groupBy({
        by: ['email'],
        where: { email: { not: null }, ...this.live },
        _count: { _all: true },
        having: { email: { _count: { gt: 1 } } },
        orderBy: { email: 'asc' },
        take: limit,
      }),
    ]);

    return { byMobile, byEmail };
  }

  async findByMobileOrEmail(input: { mobile?: string | null; email?: string | null }) {
    const matchers: Record<string, unknown>[] = [];
    if (input.mobile) matchers.push({ mobile: input.mobile });
    if (input.email) matchers.push({ email: input.email });
    if (matchers.length === 0) return [];

    return this.prisma.client.contact.findMany({
      where: { OR: matchers, ...this.live },
      include: { _count: { select: { leads: true } } },
    });
  }

  // ---------------------------------------------------------------------------
  // Merge
  // ---------------------------------------------------------------------------

  /**
   * Merges `sourceId` into `targetId` in one transaction.
   *
   * Everything is MOVED, never deleted: leads are repointed, and the source row
   * is kept as a tombstone carrying `mergedIntoId` so any lingering reference
   * still resolves. Deleting the source would break `leads.contact_id` on
   * anything the transaction did not see, and would erase the fact a merge
   * happened at all.
   *
   * Returns how many leads moved, so the caller can report it honestly.
   */
  async merge(input: {
    sourceId: string;
    targetId: string;
    winningFields: Record<string, unknown>;
    actorId: string;
  }): Promise<{ leadsMoved: number }> {
    const organizationId = this.tenantContext.requireOrganizationId();

    return this.prisma.client.$transaction(async (tx) => {
      // Both ids are re-read under the tenant scope INSIDE the transaction, so
      // a contact from another organization cannot be merged in even if the
      // caller supplies its id.
      const [source, target] = await Promise.all([
        tx.contact.findFirst({ where: { id: input.sourceId, deletedAt: null } }),
        tx.contact.findFirst({ where: { id: input.targetId, deletedAt: null } }),
      ]);

      if (!source || !target) {
        throw new Error('CONTACT_NOT_FOUND');
      }

      const moved = await tx.lead.updateMany({
        where: { contactId: input.sourceId },
        data: { contactId: input.targetId, updatedBy: input.actorId },
      });

      await tx.contact.update({
        where: { id: input.targetId },
        data: { ...input.winningFields, updatedBy: input.actorId },
      });

      await tx.contact.update({
        where: { id: input.sourceId },
        data: {
          mergedIntoId: input.targetId,
          mergedAt: new Date(),
          updatedBy: input.actorId,
        },
      });

      // Recorded on every moved lead's timeline, because from the salesperson's
      // point of view the lead's contact just changed identity.
      await tx.leadActivity.createMany({
        data: (
          await tx.lead.findMany({
            where: { contactId: input.targetId },
            select: { id: true },
          })
        ).map((lead) => ({
          organizationId,
          leadId: lead.id,
          activityType: 'LEAD_UPDATED' as const,
          description: 'Contact records merged',
          performedById: input.actorId,
        })),
      });

      return { leadsMoved: moved.count };
    });
  }
}
