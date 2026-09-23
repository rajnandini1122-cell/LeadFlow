import { Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  type TerritoryCoverageType,
  type TerritoryCoverageView,
  type TerritoryDetail,
  type TerritoryListItem,
  type TerritoryResolution,
  type TerritoryStatus,
} from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import type { PrismaTransaction } from '../../common/prisma/transaction';
import { AuditRepository } from '../../common/audit/audit.repository';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { TerritoriesRepository } from './territories.repository';
import { territoryNameKey } from './territory-name';
import {
  coverageCandidates,
  coverageKey,
  isPostalCodeShape,
  normalizeLocation,
  normalizePlaceKey,
  normalizePlaceName,
  normalizePostalKey,
  type CoverageSelector,
  type LocationFacts,
} from './territory-coverage';
import type {
  AddTerritoryCoverageDto,
  CreateTerritoryDto,
  ResolveTerritoryDto,
  UpdateTerritoryDto,
} from './dto/territories.dto';

/** Audit actions this module writes. `noun.verb`, like every other module. */
export const TERRITORY_AUDIT = {
  CREATED: 'territory.created',
  UPDATED: 'territory.updated',
  ARCHIVED: 'territory.archived',
  REACTIVATED: 'territory.reactivated',
  COVERAGE_ADDED: 'territory.coverage_added',
  COVERAGE_REMOVED: 'territory.coverage_removed',
} as const;

/**
 * Geography, turned into a name.
 *
 * The one place in the product that knows what a pincode is. Everything
 * downstream deals in territory ids: an assignment rule says "Pune / PCMC", not
 * "postal code starts with 411", so the routing table stays readable and there
 * is exactly one description of where a place is.
 *
 * Three things this deliberately does NOT do:
 *
 *   it names no team. Which team covers a territory is an assignment rule, so
 *   that there is one routing authority rather than two that can disagree;
 *
 *   it holds no people. Who may take the work is team membership, so that a
 *   suspended colleague is not still an agent somewhere else;
 *
 *   it guesses nothing. A missing state is not looked up from a city, and an
 *   unrecognised pincode does not fall back to "probably the nearest city" —
 *   the resolver reports NO_MATCH and an administrator decides.
 */
@Injectable()
export class TerritoriesService {
  constructor(
    private readonly repository: TerritoriesRepository,
    private readonly audit: AuditRepository,
  ) {}

  async list(includeArchived: boolean): Promise<TerritoryListItem[]> {
    const territories = await this.repository.list(includeArchived);
    return territories.map(toListItem);
  }

  async findOne(id: string): Promise<TerritoryDetail> {
    const territory = await this.requireTerritory(id);

    return {
      ...toListItem(territory),
      coverage: territory.coverage.map(toCoverageView),
    };
  }

  async create(dto: CreateTerritoryDto, principal: TenantPrincipal): Promise<TerritoryDetail> {
    const created = await this.repository.create({
      name: dto.name,
      nameKey: territoryNameKey(dto.name),
      description: dto.description,
    });

    if (!created) {
      // The partial unique index refused it. Archived territories are outside
      // that index, so this really is a live territory with the same name.
      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        'A territory with this name already exists. Use a different name, or reactivate the existing one.',
      );
    }

    await this.audit.record({
      action: TERRITORY_AUDIT.CREATED,
      entityType: 'Territory',
      entityId: created.id,
      actorUserId: principal.userId,
      after: { name: dto.name },
    });

    return this.findOne(created.id);
  }

  async update(
    id: string,
    dto: UpdateTerritoryDto,
    principal: TenantPrincipal,
  ): Promise<TerritoryDetail> {
    const territory = await this.requireTerritory(id);

    const changes: Parameters<TerritoriesRepository['update']>[1] = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    if (dto.name !== undefined && dto.name !== territory.name) {
      changes.name = dto.name;
      changes.nameKey = territoryNameKey(dto.name);
      before['name'] = territory.name;
      after['name'] = dto.name;
    }

    if (dto.description !== undefined) changes.description = dto.description ?? null;

    if (Object.keys(changes).length > 0) {
      const result = await this.repository.update(id, changes);

      if (result === 'NAME_TAKEN') {
        throw AppException.conflict(
          ERROR_CODES.CONFLICT,
          'A territory with this name already exists. Use a different name.',
        );
      }

      await this.audit.record({
        action: TERRITORY_AUDIT.UPDATED,
        entityType: 'Territory',
        entityId: id,
        actorUserId: principal.userId,
        before,
        after,
      });
    }

    if (dto.status !== undefined && dto.status !== territory.status) {
      await this.changeStatus(id, dto.status, principal);
    }

    return this.findOne(id);
  }

  /**
   * Retiring a territory, or bringing one back.
   *
   * Archiving is refused while ACTIVE rules route to it, and the refusal names
   * them. The alternatives are both worse: letting it through leaves
   * production routing to a scope nobody maintains, and automatically deleting
   * or retargeting the rules would make a routing decision on an
   * administrator's behalf — the exact thing this phase exists to keep
   * explicit.
   */
  private async changeStatus(
    id: string,
    status: TerritoryStatus,
    principal: TenantPrincipal,
  ): Promise<void> {
    if (status === 'ARCHIVED') {
      const result = await this.repository.archiveIfUnused(id);

      if (typeof result === 'object') {
        throw AppException.validation('Assignment rules still route work to this territory.', {
          status: [
            `pause, archive or retarget these rules first: ${result.blockedBy
              .map((rule) => rule.name)
              .join(', ')}`,
          ],
        });
      }

      if (result === 'NOT_ACTIVE') return;

      await this.audit.record({
        action: TERRITORY_AUDIT.ARCHIVED,
        entityType: 'Territory',
        entityId: id,
        actorUserId: principal.userId,
        before: { status: 'ACTIVE' },
        // Said out loud in the audit trail, because it is the part that
        // surprises people: the places this territory covered are released on
        // the way out, and reactivating does not take them back — somebody
        // else may have claimed them in between.
        after: { status: 'ARCHIVED', coverageReleased: true },
      });
      return;
    }

    const result = await this.repository.reactivate(id);

    if (result === 'NAME_TAKEN') {
      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        'Another active territory now has this name. Rename this one before reactivating it.',
      );
    }

    await this.audit.record({
      action: TERRITORY_AUDIT.REACTIVATED,
      entityType: 'Territory',
      entityId: id,
      actorUserId: principal.userId,
      before: { status: 'ARCHIVED' },
      after: { status: 'ACTIVE' },
    });
  }

  async addCoverage(
    territoryId: string,
    dto: AddTerritoryCoverageDto,
    principal: TenantPrincipal,
  ): Promise<TerritoryDetail> {
    const territory = await this.requireTerritory(territoryId);

    if (territory.status !== 'ACTIVE') {
      // An archived territory is history. A place added to it could never
      // resolve, and would silently be unavailable to any live territory.
      throw AppException.validation('This territory is archived.', {
        territoryId: ['reactivate the territory before adding coverage'],
      });
    }

    const selector = this.buildSelector(dto);
    const key = coverageKey(selector);

    const added = await this.repository.addCoverage({
      territoryId,
      selector,
      coverageKey: key,
    });

    if (!added) {
      /*
       * The unique index refused it: this place already has a live owner.
       *
       * Asked afterwards rather than checked beforehand — a prior read decides
       * nothing when a second administrator is mid-request. Naming the owner,
       * because "that is taken" without saying by whom is a message that sends
       * somebody hunting through every territory.
       */
      const owner = await this.repository.findLiveCoverageByKey(key);

      if (owner?.territory.id === territoryId) {
        // Already ours. The caller asked for a state that already holds, and a
        // 409 on a double-click would make success look like failure.
        return this.findOne(territoryId);
      }

      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        owner
          ? `${describeSelector(selector)} is already covered by ${owner.territory.name}. Remove it there first.`
          : `${describeSelector(selector)} is already covered by another territory.`,
      );
    }

    await this.audit.record({
      action: TERRITORY_AUDIT.COVERAGE_ADDED,
      entityType: 'Territory',
      entityId: territoryId,
      actorUserId: principal.userId,
      // The selector, not a customer: an audit row answers "who changed the
      // map" and needs no enquiry attached to it.
      after: { coverageId: added.id, type: selector.type, coverageKey: key },
    });

    return this.findOne(territoryId);
  }

  /**
   * Stops a place resolving here.
   *
   * Soft removal, following team membership: the row explains where enquiries
   * went while it was live, and a later re-add is a new row rather than a
   * resurrection. It does NOT delete the territory and does NOT touch a single
   * assignment rule — a rule pointing at this territory keeps pointing at it,
   * and simply matches less.
   */
  async removeCoverage(
    territoryId: string,
    coverageId: string,
    principal: TenantPrincipal,
  ): Promise<TerritoryDetail> {
    await this.requireTerritory(territoryId);
    const row = await this.repository.findCoverageRow(territoryId, coverageId);

    // Another tenant's row, another territory's row, or nothing at all: one
    // answer, so the response never says whether an id exists elsewhere.
    if (!row) {
      throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Coverage area not found.');
    }

    if (!row.removedAt) {
      const removed = await this.repository.removeCoverage(territoryId, coverageId);

      if (removed > 0) {
        await this.audit.record({
          action: TERRITORY_AUDIT.COVERAGE_REMOVED,
          entityType: 'Territory',
          entityId: territoryId,
          actorUserId: principal.userId,
          before: { coverageId, type: row.type, coverageKey: row.coverageKey },
        });
      }
    }

    return this.findOne(territoryId);
  }

  /**
   * Where does this location belong?
   *
   * READ-ONLY, and not incidentally: no lead is created or changed, no intake
   * is processed, no agent is chosen, no rule is touched. Asking where an
   * address would go must never change where anything goes, or an
   * administrator cannot safely check their own configuration.
   *
   * MOST SPECIFIC WINS: a configured pincode beats the city it sits in, which
   * beats the state, which beats the country. The order is fixed in
   * `coverageCandidates`, and every place has at most one live owner, so there
   * is no tie to break and no AMBIGUOUS outcome to report — the ambiguity was
   * made impossible by a unique index rather than resolved by a preference.
   */
  async resolve(facts: LocationFacts, tx?: PrismaTransaction): Promise<TerritoryResolution> {
    const location = normalizeLocation(facts);
    const candidates = coverageCandidates(location);

    if (candidates.length === 0) return NO_TERRITORY;

    const rows = await this.repository.findLiveCoverage(
      candidates.map((c) => c.key),
      tx,
    );
    if (rows.length === 0) return NO_TERRITORY;

    const byKey = new Map(rows.map((row) => [row.coverageKey, row]));

    for (const candidate of candidates) {
      const row = byKey.get(candidate.key);
      if (!row) continue;

      return {
        decision: 'MATCHED',
        territory: { id: row.territory.id, name: row.territory.name },
        matchedCoverage: {
          id: row.id,
          type: row.type as TerritoryCoverageType,
          label: coverageLabel(row),
        },
      };
    }

    return NO_TERRITORY;
  }

  async preview(dto: ResolveTerritoryDto): Promise<TerritoryResolution> {
    return this.resolve(dto);
  }

  /**
   * Turns a request into a normalised selector, refusing shapes that do not
   * mean anything.
   *
   * Each type states exactly which facts it needs, and refuses the ones it does
   * not: a COUNTRY selector with a city in it is either a mistake or a CITY
   * selector, and storing it as the first while somebody meant the second is
   * how an enquiry ends up in the wrong place with nothing in the record to
   * explain it.
   *
   * State is optional on a CITY selector and absent from the rest. Requiring
   * one everywhere would mean refusing to cover Singapore, the UAE or Malta,
   * none of which have a province layer worth naming — the model is not built
   * around India's hierarchy.
   */
  private buildSelector(dto: AddTerritoryCoverageDto): CoverageSelector {
    const countryCode = dto.country;
    const stateKey = normalizePlaceKey(dto.state);
    const stateName = normalizePlaceName(dto.state);
    const cityKey = normalizePlaceKey(dto.city);
    const cityName = normalizePlaceName(dto.city);
    const postalCodeKey = normalizePostalKey(dto.postalCode);

    switch (dto.type) {
      case 'COUNTRY':
        this.refuseExtras({ state: stateKey, city: cityKey, postalCode: postalCodeKey }, 'a country');
        return { type: 'COUNTRY', countryCode };

      case 'STATE':
        if (!stateKey || !stateName) throw missing('state', 'a state selector needs a state');
        this.refuseExtras({ city: cityKey, postalCode: postalCodeKey }, 'a state');
        return { type: 'STATE', countryCode, stateKey, stateName };

      case 'CITY': {
        if (!cityKey || !cityName) throw missing('city', 'a city selector needs a city');
        this.refuseExtras({ postalCode: postalCodeKey }, 'a city');

        return {
          type: 'CITY',
          countryCode,
          cityKey,
          cityName,
          // Kept when given, never invented when not. A city without a state is
          // a DIFFERENT selector from the same city under a named state, not a
          // vaguer version of it — see coverageKey.
          ...(stateKey && stateName ? { stateKey, stateName } : {}),
        };
      }

      case 'POSTAL_CODE': {
        if (!postalCodeKey) {
          throw missing('postalCode', 'a postal code selector needs a postal code');
        }
        if (!isPostalCodeShape(postalCodeKey)) {
          // Shape only. There is no claim here that the code EXISTS — no
          // country-by-country database, and no pretending a typo in a real
          // format can be caught.
          throw missing('postalCode', 'must look like a postal code');
        }
        this.refuseExtras({ state: stateKey, city: cityKey }, 'a postal code');

        return { type: 'POSTAL_CODE', countryCode, postalCodeKey, postalCode: postalCodeKey };
      }
    }
  }

  private refuseExtras(extras: Record<string, string | undefined>, shape: string): void {
    for (const [field, value] of Object.entries(extras)) {
      if (value !== undefined) {
        throw AppException.validation(`A ${shape} selector cannot also set ${field}.`, {
          [field]: [`remove it, or choose a selector type that uses it`],
        });
      }
    }
  }

  /** A territory in another organization is indistinguishable from one that is gone. */
  private async requireTerritory(id: string) {
    const territory = await this.repository.findById(id);
    if (!territory) throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Territory not found.');

    return territory;
  }
}

const NO_TERRITORY: TerritoryResolution = {
  decision: 'NO_MATCH',
  territory: null,
  matchedCoverage: null,
};

function missing(field: string, detail: string): AppException {
  return AppException.validation('That coverage area is incomplete.', { [field]: [detail] });
}

type TerritoryRow = Awaited<ReturnType<TerritoriesRepository['findById']>>;
type LoadedTerritory = NonNullable<TerritoryRow>;
type CoverageRow = LoadedTerritory['coverage'][number];

function toListItem(territory: LoadedTerritory): TerritoryListItem {
  const coverage = territory.coverage;

  return {
    id: territory.id,
    name: territory.name,
    description: territory.description,
    status: territory.status as TerritoryStatus,
    coverageCount: coverage.length,
    // Three is enough to recognise a territory in a list; the rest are one
    // click away, and a row that wraps to four lines is a row nobody scans.
    coverageSummary: coverage
      .slice(0, 3)
      .map((row) => coverageLabel(row))
      .join(' · '),
    createdAt: territory.createdAt.toISOString(),
    updatedAt: territory.updatedAt.toISOString(),
  };
}

function toCoverageView(row: CoverageRow): TerritoryCoverageView {
  return {
    id: row.id,
    type: row.type as TerritoryCoverageType,
    countryCode: row.countryCode,
    state: row.stateName,
    city: row.cityName,
    postalCode: row.postalCode,
    label: coverageLabel(row),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The selector in words, most specific part first.
 *
 * Built from the DISPLAY columns, so an administrator reads back what they
 * typed rather than the lower-cased comparison form the database matches on.
 */
function coverageLabel(row: {
  countryCode: string;
  stateName: string | null;
  cityName: string | null;
  postalCode: string | null;
}): string {
  return [row.postalCode, row.cityName, row.stateName, row.countryCode]
    .filter((part): part is string => Boolean(part))
    .join(', ');
}

/** The same, for a selector that has not been stored yet. */
function describeSelector(selector: CoverageSelector): string {
  switch (selector.type) {
    case 'COUNTRY':
      return selector.countryCode;
    case 'STATE':
      return `${selector.stateName}, ${selector.countryCode}`;
    case 'CITY':
      return [selector.cityName, selector.stateName, selector.countryCode]
        .filter((part): part is string => Boolean(part))
        .join(', ');
    case 'POSTAL_CODE':
      return `${selector.postalCode}, ${selector.countryCode}`;
  }
}
