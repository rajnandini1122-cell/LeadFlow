import { Injectable } from '@nestjs/common';
import { PrismaService, type PrismaTransaction } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
import type { TerritoryStatus } from '../../generated/prisma/enums';
import type { CoverageSelector, CoverageType } from './territory-coverage';

/**
 * Territory data access.
 *
 * `Territory` and `TerritoryCoverage` are in TENANT_SCOPED_MODELS, so nothing
 * here names organizationId on a read. Two invariants belong to the database
 * rather than to this file, and that is deliberate: one ACTIVE territory per
 * name, and ONE LIVE OWNER PER PLACE. Both are partial unique indexes, so two
 * administrators claiming Pune at the same moment still produce one owner — a
 * prior read decides nothing when the other request has not committed yet.
 */
@Injectable()
export class TerritoriesRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private get organizationId(): string {
    return this.tenantContext.requireOrganizationId();
  }

  async list(includeArchived: boolean) {
    return this.prisma.client.territory.findMany({
      where: includeArchived ? {} : { status: 'ACTIVE' },
      include: TERRITORY_INCLUDE,
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });
  }

  async findById(id: string) {
    return this.prisma.client.territory.findFirst({ where: { id }, include: TERRITORY_INCLUDE });
  }

  /** Null when the partial unique index refused it — the name is live already. */
  async create(input: { name: string; nameKey: string; description?: string | undefined }) {
    const created = await this.prisma.client.territory.createManyAndReturn({
      skipDuplicates: true,
      data: [
        {
          organizationId: this.organizationId,
          name: input.name,
          nameKey: input.nameKey,
          description: input.description ?? null,
        },
      ],
      select: { id: true },
    });

    return created[0] ?? null;
  }

  /**
   * Applies changes, or reports a name collision.
   *
   * `updateMany` rather than `update`, so the tenant scope is part of the WHERE:
   * another organization's territory matches nothing and reports not-found
   * without a second query confirming it exists.
   */
  async update(
    id: string,
    changes: { name?: string; nameKey?: string; description?: string | null },
  ): Promise<'UPDATED' | 'NAME_TAKEN'> {
    try {
      await this.prisma.client.territory.updateMany({ where: { id }, data: changes });
      return 'UPDATED';
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') return 'NAME_TAKEN';
      throw error;
    }
  }

  /**
   * Retires a territory, unless live routing still points at it.
   *
   * The ORDER inside the transaction is the whole point. Archiving writes the
   * territory row FIRST, which takes its row lock, and only then asks which
   * active rules reference it. A rule being created concurrently must take the
   * same lock before it may insert (see `lockActiveTerritory`), so it is either
   * committed and visible to the count below, or still waiting and will find
   * the territory archived when its turn comes. There is no ordering in which
   * both succeed.
   *
   * Asking first and writing afterwards would be the natural way round and
   * would be wrong: two requests would each read "no rules" and "still active",
   * and production would end up routing enquiries to a territory nobody is
   * watching. PostgreSQL decides this, not a mutex in one process — there are
   * several processes.
   *
   * Archiving also RELEASES the places this territory covered, by soft-removing
   * its live coverage in the same transaction. Otherwise a retired territory
   * would keep its claim on Pune forever — the unique index does not care
   * whether the owner is still in use — and the administrator who archived it
   * to redraw the map would find they could not.
   *
   * Returning the blocking rules rather than a bare refusal: an administrator
   * needs to know what to pause, and a message that only says no is a message
   * that sends them looking.
   */
  async archiveIfUnused(
    id: string,
  ): Promise<'ARCHIVED' | 'NOT_ACTIVE' | { blockedBy: { id: string; name: string }[] }> {
    try {
      return await this.prisma.client.$transaction(async (tx) => {
        const archived = await tx.territory.updateMany({
          where: { id, status: 'ACTIVE' },
          data: { status: 'ARCHIVED' },
        });

        if (archived.count === 0) return 'NOT_ACTIVE' as const;

        const routing = await tx.assignmentRule.findMany({
          where: { territoryId: id, status: 'ACTIVE' },
          select: { id: true, name: true },
          orderBy: { priority: 'asc' },
        });

        // Rolls the archive back. A thrown sentinel rather than a returned
        // value, because returning would COMMIT the archive we just decided
        // against.
        if (routing.length > 0) throw new TerritoryInUse(routing);

        await tx.territoryCoverage.updateMany({
          where: { territoryId: id, removedAt: null },
          data: { removedAt: new Date() },
        });

        return 'ARCHIVED' as const;
      });
    } catch (error) {
      if (error instanceof TerritoryInUse) return { blockedBy: error.rules };
      throw error;
    }
  }

  /** Brings an archived territory back. Its coverage is still there. */
  async reactivate(id: string): Promise<'UPDATED' | 'NAME_TAKEN'> {
    return this.updateStatus(id, 'ACTIVE');
  }

  private async updateStatus(id: string, status: TerritoryStatus): Promise<'UPDATED' | 'NAME_TAKEN'> {
    try {
      await this.prisma.client.territory.updateMany({ where: { id }, data: { status } });
      return 'UPDATED';
    } catch (error) {
      // Reactivating re-enters the partial index, so the name may now be taken
      // by a territory created while this one was archived.
      if ((error as { code?: string }).code === 'P2002') return 'NAME_TAKEN';
      throw error;
    }
  }

  /**
   * Claims a place for a territory, or reports that somebody already has it.
   *
   * ON CONFLICT DO NOTHING through `skipDuplicates`, against the partial unique
   * index on (organization_id, coverage_key) WHERE removed_at IS NULL. A read
   * followed by an insert cannot hold: two administrators adding Pune at the
   * same moment both find it free, and two live owners would make resolution
   * depend on row order.
   *
   * It also avoids RAISING, which matters beyond elegance — a unique violation
   * aborts the statement, and on the in-process PGlite the development suite
   * runs against that takes the connection down with it.
   */
  async addCoverage(input: {
    territoryId: string;
    selector: CoverageSelector;
    coverageKey: string;
  }) {
    const { selector } = input;

    const created = await this.prisma.client.territoryCoverage.createManyAndReturn({
      skipDuplicates: true,
      data: [
        {
          organizationId: this.organizationId,
          territoryId: input.territoryId,
          type: selector.type,
          countryCode: selector.countryCode,
          stateKey: 'stateKey' in selector ? selector.stateKey ?? null : null,
          stateName: 'stateName' in selector ? selector.stateName ?? null : null,
          cityKey: 'cityKey' in selector ? selector.cityKey : null,
          cityName: 'cityName' in selector ? selector.cityName : null,
          postalCodeKey: 'postalCodeKey' in selector ? selector.postalCodeKey : null,
          postalCode: 'postalCode' in selector ? selector.postalCode : null,
          coverageKey: input.coverageKey,
        },
      ],
      select: { id: true },
    });

    return created[0] ?? null;
  }

  /** Who currently owns this place. Asked only to explain a refusal. */
  async findLiveCoverageByKey(coverageKey: string) {
    return this.prisma.client.territoryCoverage.findFirst({
      where: { coverageKey, removedAt: null },
      select: { id: true, territory: { select: { id: true, name: true } } },
    });
  }

  async findCoverageRow(territoryId: string, coverageId: string) {
    return this.prisma.client.territoryCoverage.findFirst({
      where: { id: coverageId, territoryId },
      select: { id: true, type: true, coverageKey: true, removedAt: true },
    });
  }

  /** Soft removal: the place stops resolving here, and the history stays. */
  async removeCoverage(territoryId: string, coverageId: string): Promise<number> {
    const result = await this.prisma.client.territoryCoverage.updateMany({
      where: { id: coverageId, territoryId, removedAt: null },
      data: { removedAt: new Date() },
    });

    return result.count;
  }

  /**
   * The live coverage rows matching any of these selectors.
   *
   * One query for the whole candidate list rather than one per specificity
   * level: four round trips to answer one question would be four chances for
   * the table to change underneath, and the caller orders the results itself
   * anyway.
   *
   * Takes an optional transaction, for two reasons that both matter. The map an
   * enquiry is routed by should be the map as it stands inside the transaction
   * that acts on it — and, more bluntly, a query that went to the pool for its
   * own connection while the caller's transaction held one would deadlock the
   * moment the pool was exhausted, which on a single-connection database is
   * immediately.
   */
  async findLiveCoverage(coverageKeys: string[], tx?: PrismaTransaction) {
    if (coverageKeys.length === 0) return [];

    return (tx ?? this.prisma.client).territoryCoverage.findMany({
      // Archived territories release their coverage on the way out, so this
      // status filter should never exclude anything. It is here because
      // resolution is what decides where a customer's enquiry goes, and one
      // redundant predicate is cheaper than finding out the hard way that the
      // two rules had drifted apart.
      where: { coverageKey: { in: coverageKeys }, removedAt: null, territory: { status: 'ACTIVE' } },
      select: {
        id: true,
        type: true,
        coverageKey: true,
        countryCode: true,
        stateName: true,
        cityName: true,
        postalCode: true,
        territory: { select: { id: true, name: true, status: true } },
      },
    });
  }

  /**
   * Active routing rules pointing at this territory.
   *
   * Read here rather than through the assignment-rules service, for the same
   * reason the teams repository reads them: the reverse would make the two
   * modules import each other, and this is one scoped list, not a second
   * opinion about what a rule means.
   */
  async activeRulesTargeting(territoryId: string): Promise<{ id: string; name: string }[]> {
    return this.prisma.client.assignmentRule.findMany({
      where: { territoryId, status: 'ACTIVE' },
      select: { id: true, name: true },
      orderBy: { priority: 'asc' },
    });
  }
}

/** Thrown inside the archive transaction purely to roll it back. */
class TerritoryInUse extends Error {
  constructor(readonly rules: { id: string; name: string }[]) {
    super('Territory is referenced by active assignment rules');
    this.name = 'TerritoryInUse';
  }
}

/**
 * Takes the territory row's write lock, and reports whether it may be routed to.
 *
 * Called by the assignment-rules repository INSIDE the transaction that writes
 * the rule, so that an ACTIVE rule and an archived territory cannot both come
 * into existence. The archive path (`archiveIfUnused`) writes the same row
 * first and then looks for rules, so the two serialise on this row: whichever
 * gets the lock first, the other sees its committed result.
 *
 * The write is a lock, not a change. `status` is set to the value it already
 * has and `updatedAt` to the value it already has, so the row version changes —
 * which is what acquires the lock — while nothing an administrator can see
 * does. An UPDATE is used rather than SELECT ... FOR UPDATE because raw SQL
 * bypasses tenant scoping and is banned; this takes the same row-level
 * exclusive lock through the scoped client.
 *
 * Returns null when the territory is archived, absent, or another tenant's —
 * three cases the caller is right to treat alike, since distinguishing them
 * would say whether an id exists somewhere else.
 */
export async function lockActiveTerritory(
  tx: PrismaTransaction,
  territoryId: string,
): Promise<{ id: string; name: string } | null> {
  const territory = await tx.territory.findFirst({
    where: { id: territoryId },
    select: { id: true, name: true, status: true, updatedAt: true },
  });

  if (!territory || territory.status !== 'ACTIVE') return null;

  const locked = await tx.territory.updateMany({
    where: { id: territoryId, status: 'ACTIVE' },
    data: { status: 'ACTIVE', updatedAt: territory.updatedAt },
  });

  // Zero rows means a concurrent archive committed while this transaction
  // waited for the lock. The territory is gone as far as new routing goes.
  if (locked.count === 0) return null;

  return { id: territory.id, name: territory.name };
}

/** A territory's live coverage, plus the counts a list needs. */
const TERRITORY_INCLUDE = {
  coverage: {
    where: { removedAt: null },
    select: {
      id: true,
      type: true,
      countryCode: true,
      stateName: true,
      cityName: true,
      postalCode: true,
      createdAt: true,
    },
    // Oldest first, so the list is stable as an administrator adds to it. The
    // detail screen groups by type itself; ordering by the enum here would put
    // the map in evaluation order, which is not the order somebody edits in.
    orderBy: { createdAt: 'asc' },
  },
} as const;

export type { CoverageType };
