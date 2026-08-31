import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import { AuditRepository, AUDIT_ACTIONS } from '../../common/audit/audit.repository';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import type { AccountStatus } from '../../generated/prisma/enums';
import { AccountsRepository } from './accounts.repository';
import { AccountLifecycleService } from './account-lifecycle.service';
import {
  extractDomain,
  findDuplicateCandidates,
  normalizeCompanyName,
  type DuplicateCandidate,
} from './account-identity';
import { isDormancyCandidate } from './account-kpi';
import type { CreateAccountDto, ListAccountsDto, UpdateAccountDto } from './dto/accounts.dto';

export interface AccountView {
  id: string;
  name: string;
  status: string;
  industry: string | null;
  website: string | null;
  domain: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  source: string | null;
  notes: string | null;
  owner: { id: string; fullName: string } | null;
  firstContactAt: string | null;
  firstWonAt: string | null;
  lastWonAt: string | null;
  lastActivityAt: string | null;
  active: boolean;
  leadCount: number;
  contactCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Which status changes a person may make, and which the system makes for them.
 *
 * PROSPECT to CUSTOMER is deliberately absent: that transition is EARNED by
 * winning an opportunity, and AccountLifecycleService performs it. Letting it
 * be set by hand would mean the customer count and the won-deal count could
 * disagree with no way to tell which was right.
 *
 * Every other transition is a judgement only a person can make — the system
 * cannot know that a customer has churned.
 */
const ALLOWED_MANUAL_TRANSITIONS: Record<AccountStatus, AccountStatus[]> = {
  PROSPECT: ['FORMER_CUSTOMER'],
  CUSTOMER: ['DORMANT', 'FORMER_CUSTOMER'],
  DORMANT: ['CUSTOMER', 'FORMER_CUSTOMER'],
  FORMER_CUSTOMER: ['CUSTOMER', 'DORMANT'],
};

@Injectable()
export class AccountsService {
  constructor(
    private readonly repository: AccountsRepository,
    private readonly lifecycle: AccountLifecycleService,
    private readonly audit: AuditRepository,
  ) {}

  async list(query: ListAccountsDto): Promise<{
    items: AccountView[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = Math.min(query.limit ?? 25, 100);
    const offset = query.offset ?? 0;

    const { items, total } = await this.repository.list({
      search: query.search,
      status: query.status as AccountStatus | undefined,
      ownerId: query.ownerId,
      limit,
      offset,
    });

    return { items: items.map(toView), total, limit, offset };
  }

  async get(id: string): Promise<AccountView> {
    const account = await this.requireAccount(id);
    return toView({ ...account, _count: { leads: 0, contacts: 0 } });
  }

  /**
   * Creates an account.
   *
   * Duplicate candidates are checked FIRST and returned rather than silently
   * accepted or silently merged. `force` is how the caller says "I have looked
   * at those and this is a different company" — which happens legitimately with
   * franchises and with two branches a business treats separately.
   *
   * The important property is that the refusal is INFORMATIVE: it names the
   * accounts it thinks are the same and which fields matched, so the decision
   * is made on evidence rather than on a system's say-so.
   */
  async create(
    dto: CreateAccountDto,
    principal: TenantPrincipal,
  ): Promise<{ account: AccountView; duplicates: DuplicateCandidate[] }> {
    const normalizedName = normalizeCompanyName(dto.name);
    const domain = extractDomain(dto.website) ?? extractDomain(dto.email);

    const existing = await this.repository.findByIdentityKeys({ normalizedName, domain });
    const duplicates = findDuplicateCandidates(
      { name: dto.name, website: dto.website, email: dto.email, phone: dto.phone },
      existing,
    );

    if (duplicates.length > 0 && !dto.force) {
      /*
       * Details carry the candidates so the client can offer "open the existing
       * one" without a second round trip — the same shape the existing
       * DUPLICATE_LEAD conflict already uses, as parallel arrays, rather than a
       * second error format for the same idea.
       */
      throw new AppException(
        ERROR_CODES.DUPLICATE_ACCOUNT,
        duplicates.length === 1
          ? `"${duplicates[0]?.name}" already exists and looks like the same company. ` +
            'Open it, or confirm this is a different one.'
          : `${duplicates.length} existing accounts look like the same company. ` +
            'Open one, or confirm this is a different one.',
        HttpStatus.CONFLICT,
        {
          duplicateAccountIds: duplicates.map((candidate) => candidate.accountId),
          duplicateAccountNames: duplicates.map((candidate) => candidate.name),
          duplicateAccountStatuses: duplicates.map((candidate) => candidate.status),
          duplicateConfidences: duplicates.map((candidate) => candidate.confidence),
          duplicateMatchedOn: duplicates.map((candidate) => candidate.matchedOn.join(',')),
        },
      );
    }

    if (dto.ownerId) await this.requireMember(dto.ownerId);

    const account = await this.repository.create({
      name: dto.name.trim(),
      normalizedName,
      // Always PROSPECT. A new record has no won opportunity behind it, and
      // letting the caller declare a customer would put revenue in the
      // acquisition figures that no deal ever produced.
      status: 'PROSPECT',
      industry: dto.industry,
      website: dto.website,
      domain,
      phone: dto.phone,
      email: dto.email,
      city: dto.city,
      state: dto.state,
      country: dto.country,
      source: dto.source,
      notes: dto.notes,
      ownerId: dto.ownerId,
      actorId: principal.userId,
    });

    await this.audit.record({
      action: AUDIT_ACTIONS.ACCOUNT_CREATED,
      entityType: 'Account',
      entityId: account.id,
      after: { name: account.name, status: account.status, domain: account.domain },
    });

    return {
      account: toView({ ...account, _count: { leads: 0, contacts: 0 } }),
      // Returned even on success, so a caller who forced past them still sees
      // what it thought.
      duplicates,
    };
  }

  async update(id: string, dto: UpdateAccountDto, principal: TenantPrincipal): Promise<AccountView> {
    const before = await this.requireAccount(id);

    if (dto.ownerId) await this.requireMember(dto.ownerId);

    const data: Record<string, unknown> = { updatedBy: principal.userId };

    if (dto.name !== undefined) {
      data['name'] = dto.name.trim();
      // Kept in step with the name, or duplicate detection would compare
      // against the spelling the account had when it was created.
      data['normalizedName'] = normalizeCompanyName(dto.name);
    }
    if (dto.industry !== undefined) data['industry'] = dto.industry;
    if (dto.phone !== undefined) data['phone'] = dto.phone;
    if (dto.city !== undefined) data['city'] = dto.city;
    if (dto.state !== undefined) data['state'] = dto.state;
    if (dto.country !== undefined) data['country'] = dto.country;
    if (dto.source !== undefined) data['source'] = dto.source;
    if (dto.notes !== undefined) data['notes'] = dto.notes;
    if (dto.ownerId !== undefined) data['ownerId'] = dto.ownerId;

    if (dto.website !== undefined || dto.email !== undefined) {
      const website = dto.website !== undefined ? dto.website : before.website;
      const email = dto.email !== undefined ? dto.email : before.email;
      if (dto.website !== undefined) data['website'] = dto.website;
      if (dto.email !== undefined) data['email'] = dto.email;
      data['domain'] = extractDomain(website) ?? extractDomain(email);
    }

    /*
     * Status is NOT settable here. It is what every acquisition and retention
     * figure is counted from, so it goes through changeStatus, which holds a
     * separate permission, validates the transition and audits the before/after.
     */
    const updated = await this.repository.update(id, data);
    if (updated === 0) throw this.notFound();

    await this.audit.record({
      action: AUDIT_ACTIONS.ACCOUNT_UPDATED,
      entityType: 'Account',
      entityId: id,
      before: { name: before.name, domain: before.domain, ownerId: before.ownerId },
      after: data,
    });

    return this.get(id);
  }

  /**
   * Reclassifies a relationship.
   *
   * Refuses PROSPECT to CUSTOMER: that is earned by winning an opportunity, not
   * declared. Refuses a no-op. Conditional on the current status, so two people
   * changing it at once cannot both be told they succeeded.
   */
  async changeStatus(
    id: string,
    to: AccountStatus,
    reason: string | undefined,
    principal: TenantPrincipal,
  ): Promise<AccountView> {
    const account = await this.requireAccount(id);
    const from = account.status;

    if (from === to) {
      throw AppException.validation(`This account is already ${to.toLowerCase()}.`, {
        status: ['unchanged'],
      });
    }

    if (from === 'PROSPECT' && to === 'CUSTOMER') {
      throw AppException.validation(
        'An account becomes a customer by winning an opportunity, not by being marked one. ' +
          'Record the won deal instead.',
        { status: ['PROSPECT to CUSTOMER is earned, not set'] },
      );
    }

    const allowed = ALLOWED_MANUAL_TRANSITIONS[from];
    if (!allowed.includes(to)) {
      throw AppException.validation(
        `Cannot change a ${from.toLowerCase()} account to ${to.toLowerCase()}.`,
        { status: [`allowed from here: ${allowed.join(', ') || 'none'}`] },
      );
    }

    const changed = await this.repository.changeStatus({
      id,
      from,
      to,
      actorId: principal.userId,
    });

    if (changed === 0) {
      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        'Someone else changed this account first. Reload and try again.',
      );
    }

    await this.audit.record({
      action: AUDIT_ACTIONS.ACCOUNT_STATUS_CHANGED,
      entityType: 'Account',
      entityId: id,
      before: { status: from },
      after: { status: to, reason: reason ?? null },
    });

    return this.get(id);
  }

  /** Possible duplicates of an existing account, for the review screen. */
  async duplicatesOf(id: string): Promise<DuplicateCandidate[]> {
    const account = await this.requireAccount(id);
    const candidates = await this.repository.matchCandidates();

    return findDuplicateCandidates(
      {
        name: account.name,
        website: account.website,
        email: account.email,
        phone: account.phone,
      },
      // Itself is not its own duplicate.
      candidates.filter((candidate) => candidate.id !== id),
    );
  }

  /**
   * Merges one account into another.
   *
   * The destructive operation in this module, and the only one that needs its
   * own permission. Everything the loser owns moves to the survivor in a single
   * transaction, the loser row is retained with mergedIntoId set so lingering
   * references still resolve, and the whole thing is audited with both ids.
   *
   * Both accounts are read through the tenant-scoped repository first, so a
   * cross-tenant merge cannot get past this point: the foreign id simply does
   * not resolve, and the caller gets the same 404 as for an id that does not
   * exist.
   */
  async merge(
    loserId: string,
    survivorId: string,
    principal: TenantPrincipal,
  ): Promise<{ survivor: AccountView; moved: { leads: number; contacts: number; followUps: number } }> {
    if (loserId === survivorId) {
      throw AppException.validation('An account cannot be merged into itself.', {
        survivorId: ['must be a different account'],
      });
    }

    // Both scoped reads. A foreign id resolves to nothing.
    const loser = await this.requireAccount(loserId);
    const survivor = await this.requireAccount(survivorId);

    if (loser.mergedIntoId) {
      throw AppException.validation('That account has already been merged into another.', {
        loserId: ['already merged'],
      });
    }
    if (survivor.mergedIntoId) {
      throw AppException.validation(
        'The surviving account has itself been merged into another. Merge into that one instead.',
        { survivorId: ['already merged'] },
      );
    }

    const moved = await this.repository.merge({
      loserId,
      survivorId,
      actorId: principal.userId,
    });

    /*
     * The survivor may have just inherited won deals, which makes it a customer
     * and moves the date every acquisition figure counts from.
     *
     * Through the lifecycle service, not the repository's date-only recompute:
     * rebuilding the milestones without the STATUS left a prospect holding
     * revenue, absent from every retention figure. recomputeFromLeads sets
     * both, and never demotes an account a person deliberately reclassified.
     */
    await this.lifecycle.recomputeFromLeads(survivorId);

    await this.audit.record({
      action: AUDIT_ACTIONS.ACCOUNT_MERGED,
      entityType: 'Account',
      entityId: survivorId,
      before: { mergedAccountId: loserId, mergedAccountName: loser.name },
      after: { survivorId, survivorName: survivor.name, moved },
    });

    return { survivor: await this.get(survivorId), moved };
  }

  /**
   * Customers that have gone quiet for longer than the tenant's threshold.
   *
   * A REVIEW LIST, and nothing more. Nothing here changes a status: a customer
   * can easily have been active on the phone with nothing written down, and
   * silently reclassifying them would be both wrong and invisible. Someone
   * looks, and decides.
   */
  async dormancyCandidates(limit = 50): Promise<{
    thresholdDays: number;
    items: { id: string; name: string; lastActivityAt: string | null; lastWonAt: string | null; daysQuiet: number }[];
  }> {
    const thresholdDays = await this.repository.dormancyThresholdDays();
    const now = new Date();
    const before = new Date(now.getTime() - thresholdDays * 24 * 60 * 60 * 1000);

    const rows = await this.repository.dormancyCandidates(before, limit);

    return {
      thresholdDays,
      items: rows
        .filter((row) =>
          isDormancyCandidate({
            status: row.status,
            lastActivityAt: row.lastActivityAt,
            thresholdDays,
            now,
          }),
        )
        .map((row) => ({
          id: row.id,
          name: row.name,
          lastActivityAt: row.lastActivityAt?.toISOString() ?? null,
          lastWonAt: row.lastWonAt?.toISOString() ?? null,
          daysQuiet: row.lastActivityAt
            ? Math.floor((now.getTime() - row.lastActivityAt.getTime()) / (1000 * 60 * 60 * 24))
            : 0,
        })),
    };
  }

  // ---------------------------------------------------------------------------

  private async requireAccount(id: string) {
    const account = await this.repository.findById(id);
    if (!account) throw this.notFound();
    return account;
  }

  private async requireMember(userId: string): Promise<void> {
    const isMember = await this.repository.isActiveMember(userId);
    if (!isMember) {
      throw AppException.validation('Cannot assign this account.', {
        ownerId: ['must be an active member of your organization'],
      });
    }
  }

  /**
   * The same 404 an account in another tenant produces.
   *
   * Deliberately not a 403: telling the caller that an id exists but belongs to
   * someone else is an enumeration oracle over the customer list.
   */
  private notFound(): AppException {
    return AppException.notFound(ERROR_CODES.ACCOUNT_NOT_FOUND, 'Account not found.');
  }
}

type AccountRow = {
  id: string;
  name: string;
  status: string;
  industry: string | null;
  website: string | null;
  domain: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  source: string | null;
  notes: string | null;
  owner?: { id: string; fullName: string } | null;
  firstContactAt: Date | null;
  firstWonAt: Date | null;
  lastWonAt: Date | null;
  lastActivityAt: Date | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  _count?: { leads: number; contacts: number } | undefined;
};

function toView(row: AccountRow): AccountView {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    industry: row.industry,
    website: row.website,
    domain: row.domain,
    phone: row.phone,
    email: row.email,
    city: row.city,
    state: row.state,
    country: row.country,
    source: row.source,
    notes: row.notes,
    owner: row.owner ?? null,
    firstContactAt: row.firstContactAt?.toISOString() ?? null,
    firstWonAt: row.firstWonAt?.toISOString() ?? null,
    lastWonAt: row.lastWonAt?.toISOString() ?? null,
    lastActivityAt: row.lastActivityAt?.toISOString() ?? null,
    active: row.active,
    leadCount: row._count?.leads ?? 0,
    contactCount: row._count?.contacts ?? 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
