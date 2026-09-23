import { Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import { AuditRepository, AUDIT_ACTIONS } from '../../common/audit/audit.repository';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { AccountMappingRepository } from './account-mapping.repository';
import { AccountLifecycleService } from './account-lifecycle.service';
import {
  groupByNormalizedName,
  suggestAccountsForCompanyName,
  type ExistingAccount,
} from './account-identity';

/**
 * Classifying records that predate accounts.
 *
 * The whole of this file exists because NOTHING IS GUESSED. Historical leads
 * carry a free-text company name typed by whoever took the call, so the same
 * customer appears as "ABC Foods", "ABC Foods Pvt Ltd", "abc foods" and
 * "ABC". Deciding those are one company is a judgement — and deciding it wrong
 * fuses two businesses' opportunities, contacts and revenue into one record
 * with no undo.
 *
 * So this offers PROPOSALS and shows the evidence behind each one:
 *
 *   - grouping by normalised name, with every original spelling listed, so a
 *     reviewer sees exactly what is being grouped
 *   - exact-match suggestions against existing accounts, never substring
 *   - a count of records with no company name at all, so the backfill cannot
 *     look finished while a pile of them is still unattached
 *
 * A person selects and confirms. The free-text `companyName` is NEVER
 * overwritten: it is the evidence, and the account is a grouping key placed
 * beside it — exactly as productId sits beside productInterest.
 */
@Injectable()
export class AccountMappingService {
  constructor(
    private readonly repository: AccountMappingRepository,
    private readonly lifecycle: AccountLifecycleService,
    private readonly audit: AuditRepository,
  ) {}

  async progress(): Promise<{
    mapped: number;
    unmapped: number;
    total: number;
    /** Null for an organization with no leads at all, rather than 100%. */
    percentMapped: number | null;
    /** Unmapped leads with nothing to group on. Reported, never hidden. */
    withoutCompanyName: number;
  }> {
    const [counts, withoutCompanyName] = await Promise.all([
      this.repository.progress(),
      this.repository.unmappedWithoutCompanyNameCount(),
    ]);

    return {
      ...counts,
      percentMapped:
        counts.total === 0 ? null : Math.round((counts.mapped / counts.total) * 1000) / 10,
      withoutCompanyName,
    };
  }

  async unmappedLeads(search: string | undefined, limit = 100) {
    const { items, total } = await this.repository.unmappedLeads({
      search,
      limit: Math.min(limit, 200),
    });

    return {
      items: items.map((lead) => ({
        id: lead.id,
        leadNumber: lead.leadNumber,
        name: [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim() || '(no name)',
        companyName: lead.companyName,
        email: lead.email,
        mobile: lead.mobile,
        city: lead.city,
        status: lead.status,
        createdAt: lead.createdAt.toISOString(),
      })),
      total,
      returned: items.length,
    };
  }

  async unmappedContacts(search: string | undefined, limit = 100) {
    const { items, total } = await this.repository.unmappedContacts({
      search,
      limit: Math.min(limit, 200),
    });

    return {
      items: items.map((contact) => ({
        id: contact.id,
        name:
          [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() || '(no name)',
        companyName: contact.companyName,
        email: contact.email,
        mobile: contact.mobile,
        city: contact.city,
        createdAt: contact.createdAt.toISOString(),
      })),
      total,
      returned: items.length,
    };
  }

  /**
   * Unmapped leads grouped by what their company name normalises to.
   *
   * A PROPOSAL: "these seven leads all wrote something that reduces to
   * abc foods". Every original spelling is returned so the reviewer can see
   * what is actually being grouped and reject it if two different companies
   * have collided.
   *
   * Where an existing account already matches a group exactly, it is named — so
   * the reviewer attaches to it instead of creating a second record for a
   * company that is already there. That is the single most valuable thing this
   * screen does, because creating the duplicate is the mistake that is hardest
   * to undo later.
   */
  async suggestions(limit = 500): Promise<{
    groups: {
      normalizedName: string;
      /** Every spelling found. The evidence. */
      variants: string[];
      leadCount: number;
      leads: { id: string; leadNumber: string; companyName: string | null; status: string }[];
      /** Existing accounts this group matches exactly. Usually zero or one. */
      existingAccounts: { id: string; name: string; status: string }[];
    }[];
    withoutCompanyName: number;
    scanned: number;
  }> {
    const [rows, withoutCompanyName, candidates] = await Promise.all([
      this.repository.unmappedWithCompanyName(limit),
      this.repository.unmappedWithoutCompanyNameCount(),
      this.repository.matchCandidates(),
    ]);

    const grouped = groupByNormalizedName(rows);

    return {
      groups: grouped.map((group) => {
        const existing = suggestAccountsForCompanyName(group.variants[0] ?? null, candidates);

        return {
          normalizedName: group.normalizedName,
          variants: group.variants,
          leadCount: group.rows.length,
          // Bounded: the reviewer needs a sample to judge by, not all 400.
          leads: group.rows.slice(0, 25).map((row) => ({
            id: row.id,
            leadNumber: row.leadNumber,
            companyName: row.companyName,
            status: row.status,
          })),
          existingAccounts: existing.map((account) => ({
            id: account.id,
            name: account.name,
            status: account.status,
          })),
        };
      }),
      withoutCompanyName,
      scanned: rows.length,
    };
  }

  /** Existing accounts that exactly match one lead's company name. */
  async suggestionsForLead(leadId: string): Promise<{
    companyName: string | null;
    accounts: { id: string; name: string; status: string }[];
  }> {
    const lead = await this.repository.leadCompanyName(leadId);
    if (!lead) throw AppException.leadNotFound();

    const candidates: ExistingAccount[] = await this.repository.matchCandidates();
    const matches = suggestAccountsForCompanyName(lead.companyName, candidates);

    return {
      companyName: lead.companyName,
      accounts: matches.map((account) => ({
        id: account.id,
        name: account.name,
        status: account.status,
      })),
    };
  }

  /**
   * Attaches selected leads and contacts to an account.
   *
   * The account is verified to belong to this tenant FIRST. The tenant
   * extension would already narrow the update, but checking here means a
   * foreign id produces a clear 404 rather than a silent zero-row success that
   * looks like the mapping worked.
   *
   * Only records that currently have NO account are touched. Re-parenting one
   * that is already attached is a different operation with different
   * consequences, and it must not happen as a side effect of a bulk classify —
   * so the returned count may be lower than what was asked for, and that
   * difference is reported rather than smoothed over.
   */
  async assign(
    input: { accountId: string; leadIds?: string[] | undefined; contactIds?: string[] | undefined },
    principal: TenantPrincipal,
  ): Promise<{ leadsUpdated: number; contactsUpdated: number; requested: number }> {
    const leadIds = input.leadIds ?? [];
    const contactIds = input.contactIds ?? [];

    if (leadIds.length === 0 && contactIds.length === 0) {
      throw AppException.validation('Select at least one lead or contact to map.', {
        leadIds: ['nothing selected'],
      });
    }

    const exists = await this.repository.accountExists(input.accountId);
    if (!exists) {
      throw AppException.notFound(
        // Same 404 as an id in another tenant. Confirming the difference would
        // turn this into an enumeration oracle over the customer list.
        ERROR_CODES.ACCOUNT_NOT_FOUND,
        'Account not found.',
      );
    }

    const leadsUpdated = leadIds.length
      ? await this.repository.assignLeadsToAccount({
          accountId: input.accountId,
          leadIds,
          actorId: principal.userId,
        })
      : 0;

    const contactsUpdated = contactIds.length
      ? await this.repository.assignContactsToAccount({
          accountId: input.accountId,
          contactIds,
          actorId: principal.userId,
        })
      : 0;

    /*
     * Newly attached leads may include won deals, which means this account has
     * been a customer all along and its milestones were simply unknown. Rebuilt
     * from the opportunity history rather than assumed.
     */
    if (leadsUpdated > 0) {
      await this.lifecycle.recomputeFromLeads(input.accountId);
    }

    await this.audit.record({
      action: AUDIT_ACTIONS.ACCOUNT_LEAD_LINKED,
      entityType: 'Account',
      entityId: input.accountId,
      after: {
        leadsUpdated,
        contactsUpdated,
        requested: leadIds.length + contactIds.length,
      },
    });

    return { leadsUpdated, contactsUpdated, requested: leadIds.length + contactIds.length };
  }
}
