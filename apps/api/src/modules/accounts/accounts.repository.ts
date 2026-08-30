import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
import type { AccountStatus } from '../../generated/prisma/enums';

/**
 * Account data access.
 *
 * `Account` is registered in TENANT_SCOPED_MODELS, so nothing here mentions
 * organizationId on a read — the extension narrows every query and fails closed
 * when the context is missing. That matters especially here: an account id is
 * what leads, contacts and follow-ups reference, so an unscoped read would
 * expose one tenant's whole customer list and let a foreign account be attached
 * to a local lead, filing that revenue under the wrong company.
 *
 * Writes name organizationId explicitly because Prisma's generated types cannot
 * see the runtime extension.
 */
@Injectable()
export class AccountsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * The customer list.
   *
   * Counts come from the database in one grouped pass rather than a query per
   * row: a list of 200 accounts would otherwise be 200 round trips.
   */
  async list(filters: {
    search?: string | undefined;
    status?: AccountStatus | undefined;
    ownerId?: string | undefined;
    limit: number;
    offset: number;
  }) {
    const where = {
      deletedAt: null,
      // A merged account is not a customer any more — it IS another customer.
      // Showing it would put the same company in the list twice.
      mergedIntoId: null,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.ownerId ? { ownerId: filters.ownerId } : {}),
      ...(filters.search
        ? {
            OR: [
              { name: { contains: filters.search, mode: 'insensitive' as const } },
              { domain: { contains: filters.search, mode: 'insensitive' as const } },
              { phone: { contains: filters.search } },
              { email: { contains: filters.search, mode: 'insensitive' as const } },
              { city: { contains: filters.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.client.account.findMany({
        where,
        include: {
          owner: { select: { id: true, fullName: true } },
          _count: { select: { leads: true, contacts: true } },
        },
        orderBy: [{ lastActivityAt: { sort: 'desc', nulls: 'last' } }, { name: 'asc' }],
        take: filters.limit,
        skip: filters.offset,
      }),
      this.prisma.client.account.count({ where }),
    ]);

    return { items, total };
  }

  async findById(id: string) {
    return this.prisma.client.account.findFirst({
      where: { id, deletedAt: null },
      include: { owner: { select: { id: true, fullName: true } } },
    });
  }

  /**
   * Follows a merge chain to the surviving account.
   *
   * A reference to a merged account must still resolve to something, and the
   * survivor is the honest answer. Bounded so a cycle — which the merge path
   * refuses to create, but which a manual database edit could — cannot hang the
   * request.
   */
  async resolveSurvivor(id: string, maxHops = 10) {
    let current = await this.prisma.client.account.findFirst({ where: { id } });

    for (let hop = 0; hop < maxHops; hop += 1) {
      if (!current?.mergedIntoId) break;
      const next = await this.prisma.client.account.findFirst({
        where: { id: current.mergedIntoId },
      });
      if (!next) break;
      current = next;
    }

    return current;
  }

  /**
   * Live accounts reduced to just the fields duplicate detection compares.
   *
   * Deliberately a narrow projection: the matcher needs four columns, and
   * loading whole rows to compare four of them would pull the entire customer
   * list into memory on every lead form submission.
   */
  async matchCandidates(limit = 5000) {
    return this.prisma.client.account.findMany({
      where: { deletedAt: null, mergedIntoId: null },
      select: { id: true, name: true, normalizedName: true, domain: true, phone: true, status: true },
      take: limit,
    });
  }

  /** Narrower lookup for the create path, where only two keys can collide. */
  async findByIdentityKeys(input: { normalizedName: string; domain: string | null }) {
    return this.prisma.client.account.findMany({
      where: {
        deletedAt: null,
        mergedIntoId: null,
        OR: [
          { normalizedName: input.normalizedName },
          ...(input.domain ? [{ domain: input.domain }] : []),
        ],
      },
      select: { id: true, name: true, normalizedName: true, domain: true, phone: true, status: true },
      take: 25,
    });
  }

  async create(input: {
    name: string;
    normalizedName: string;
    status: AccountStatus;
    industry?: string | undefined;
    website?: string | undefined;
    domain: string | null;
    phone?: string | undefined;
    email?: string | undefined;
    city?: string | undefined;
    state?: string | undefined;
    country?: string | undefined;
    source?: string | undefined;
    notes?: string | undefined;
    ownerId?: string | undefined;
    actorId: string;
  }) {
    return this.prisma.client.account.create({
      data: {
        organizationId: this.tenantContext.requireOrganizationId(),
        name: input.name,
        normalizedName: input.normalizedName,
        status: input.status,
        industry: input.industry ?? null,
        website: input.website ?? null,
        domain: input.domain,
        phone: input.phone ?? null,
        email: input.email ?? null,
        city: input.city ?? null,
        state: input.state ?? null,
        country: input.country ?? null,
        source: input.source ?? null,
        notes: input.notes ?? null,
        ownerId: input.ownerId ?? null,
        // The relationship starts now. Set on create rather than derived, so a
        // customer acquired before their first won deal still has a start date.
        firstContactAt: new Date(),
        lastActivityAt: new Date(),
        createdBy: input.actorId,
        updatedBy: input.actorId,
      },
      include: { owner: { select: { id: true, fullName: true } } },
    });
  }

  /**
   * Updates an account.
   *
   * `updateMany` with the id in the WHERE so the tenant extension narrows it.
   * `update` by unique id addresses a row directly and could reach another
   * organization's account if the id were guessed.
   */
  async update(id: string, data: Record<string, unknown>): Promise<number> {
    const result = await this.prisma.client.account.updateMany({
      where: { id, deletedAt: null },
      data,
    });
    return result.count;
  }

  /**
   * Records a status change only if the account is still in the state the
   * caller saw.
   *
   * Conditional so two concurrent changes cannot both report success while one
   * silently loses — the second updates zero rows and the caller is told.
   */
  async changeStatus(input: {
    id: string;
    from: AccountStatus;
    to: AccountStatus;
    actorId: string;
  }): Promise<number> {
    const result = await this.prisma.client.account.updateMany({
      where: { id: input.id, status: input.from, deletedAt: null },
      data: { status: input.to, updatedBy: input.actorId },
    });
    return result.count;
  }

  async countByStatus() {
    return this.prisma.client.account.groupBy({
      by: ['status'],
      where: { deletedAt: null, mergedIntoId: null },
      _count: { _all: true },
    });
  }

  /** Accounts quiet for longer than the tenant threshold. A review list, not an action. */
  async dormancyCandidates(before: Date, limit: number) {
    return this.prisma.client.account.findMany({
      where: {
        deletedAt: null,
        mergedIntoId: null,
        status: 'CUSTOMER',
        lastActivityAt: { lt: before, not: null },
      },
      select: { id: true, name: true, lastActivityAt: true, lastWonAt: true, status: true },
      orderBy: { lastActivityAt: 'asc' },
      take: limit,
    });
  }

  /**
   * Moves everything an account owns onto the survivor, in one transaction.
   *
   * A partial merge is the worst outcome available here: half a customer's
   * leads under one record and half under another, with no indication that it
   * happened. Either all of it moves or none of it does.
   *
   * The loser row is RETAINED with mergedIntoId set rather than deleted, so any
   * reference still resolves — the same approach Contact already takes.
   *
   * Both ids are read through the tenant-scoped client by the caller before
   * this runs, so a cross-tenant merge cannot reach here.
   */
  async merge(input: {
    loserId: string;
    survivorId: string;
    actorId: string;
  }): Promise<{ leads: number; contacts: number; followUps: number }> {
    return this.prisma.client.$transaction(async (tx) => {
      const leads = await tx.lead.updateMany({
        where: { accountId: input.loserId },
        data: { accountId: input.survivorId, updatedBy: input.actorId },
      });

      const contacts = await tx.contact.updateMany({
        where: { accountId: input.loserId },
        data: { accountId: input.survivorId, updatedBy: input.actorId },
      });

      const followUps = await tx.followUp.updateMany({
        where: { accountId: input.loserId },
        data: { accountId: input.survivorId },
      });

      await tx.account.updateMany({
        where: { id: input.loserId },
        data: {
          mergedIntoId: input.survivorId,
          mergedAt: new Date(),
          active: false,
          updatedBy: input.actorId,
        },
      });

      return { leads: leads.count, contacts: contacts.count, followUps: followUps.count };
    });
  }

  /**
   * The survivor's milestones after a merge, recomputed from the combined
   * history rather than copied from either side.
   *
   * Taking the survivor's own dates would lose the fact that the merged
   * customer bought earlier, which is the date every acquisition figure is
   * counted from.
   */
  async recomputeMilestones(accountId: string): Promise<void> {
    const [firstWon, lastWon, lastActivity] = await Promise.all([
      this.prisma.client.lead.findFirst({
        where: { accountId, status: 'WON', wonAt: { not: null }, deletedAt: null },
        orderBy: { wonAt: 'asc' },
        select: { wonAt: true },
      }),
      this.prisma.client.lead.findFirst({
        where: { accountId, status: 'WON', wonAt: { not: null }, deletedAt: null },
        orderBy: { wonAt: 'desc' },
        select: { wonAt: true },
      }),
      this.prisma.client.lead.findFirst({
        where: { accountId, deletedAt: null },
        orderBy: { updatedAt: 'desc' },
        select: { updatedAt: true },
      }),
    ]);

    await this.prisma.client.account.updateMany({
      where: { id: accountId },
      data: {
        firstWonAt: firstWon?.wonAt ?? null,
        lastWonAt: lastWon?.wonAt ?? null,
        ...(lastActivity ? { lastActivityAt: lastActivity.updatedAt } : {}),
      },
    });
  }

  /** Members of this organization, for owner assignment validation. */
  async isActiveMember(userId: string): Promise<boolean> {
    const membership = await this.prisma.client.organizationUser.findFirst({
      where: { userId, status: 'ACTIVE' },
      select: { id: true },
    });
    return membership !== null;
  }

  async dormancyThresholdDays(): Promise<number> {
    const settings = await this.prisma.client.organizationSettings.findFirst({
      select: { accountDormantAfterDays: true },
    });
    return settings?.accountDormantAfterDays ?? 180;
  }
}
