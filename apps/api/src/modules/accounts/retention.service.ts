import { Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import { AuditRepository, AUDIT_ACTIONS } from '../../common/audit/audit.repository';
import { RedisService } from '../../common/redis/redis.service';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { LeadsService } from '../leads/leads.service';
import { FollowUpsService } from '../follow-ups/follow-ups.service';
import { RetentionRepository } from './retention.repository';
import { AccountsRepository } from './accounts.repository';
import {
  classifyOpportunity,
  DEFAULT_REPEAT_AFTER_DAYS,
  daysSince,
  headlineSignal,
  signalsFor,
  type RetentionSignal,
} from './retention-signals';
import type { CreateRepeatOpportunityDto } from './dto/retention.dto';

/**
 * The customer retention engine.
 *
 * Answers WHO needs attention, WHY, WHAT to discuss and WHEN — and then gets
 * out of the way. Nothing here creates an opportunity, schedules a follow-up or
 * sends a message on its own; the queue is a list of observations and a person
 * decides. A CRM that manufactures work from its own guesses is one a
 * salesperson learns to ignore, and then the real signals are lost with the
 * invented ones.
 *
 * The repeat-business workflow deliberately delegates to LeadsService.create
 * rather than writing its own insert. That is what guarantees a repeat
 * opportunity is an ORDINARY lead — same validation, same duplicate detection,
 * same activity timeline, same "no lead left behind" rule — and not a parallel
 * kind of record that every existing report would have to learn about.
 */
@Injectable()
export class RetentionService {
  constructor(
    private readonly repository: RetentionRepository,
    private readonly accounts: AccountsRepository,
    private readonly leads: LeadsService,
    private readonly followUps: FollowUpsService,
    private readonly redis: RedisService,
    private readonly audit: AuditRepository,
  ) {}

  /**
   * The action queue.
   *
   * A fixed number of grouped queries whatever the page size: one page of
   * accounts, then one aggregate per fact across exactly those accounts. Never
   * a query per customer.
   */
  async actionQueue(options: {
    signal?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  }): Promise<{
    items: {
      accountId: string;
      name: string;
      status: string;
      owner: { id: string; fullName: string } | null;
      headline: RetentionSignal | null;
      signals: RetentionSignal[];
      wonCount: number;
      wonValue: number;
      openOpportunities: number;
      lastWonAt: string | null;
      lastActivityAt: string | null;
      daysSinceActivity: number | null;
      topProduct: { id: string; name: string } | null;
    }[];
    total: number;
    scanned: number;
  }> {
    const limit = Math.min(options.limit ?? 50, 100);
    const offset = options.offset ?? 0;

    const [{ items: accounts, total }, settings] = await Promise.all([
      this.repository.candidateAccounts({ limit, offset }),
      this.repository.repeatWindowDays(),
    ]);

    const ids = accounts.map((account) => account.id);

    const [leadCounts, followUpState, topProducts, expansion] = await Promise.all([
      this.repository.leadCountsFor(ids),
      this.repository.followUpStateFor(ids),
      this.repository.topWonProductFor(ids),
      this.repository.expansionGapsFor(ids),
    ]);

    const wonByAccount = new Map(
      leadCounts.won.map((row) => [
        row.accountId,
        { count: row._count._all, value: Number(row._sum.wonValue ?? 0) },
      ]),
    );
    const openByAccount = new Map(
      leadCounts.open.map((row) => [row.accountId, row._count._all]),
    );
    const followUpByAccount = new Map(
      followUpState.map((row) => [
        row.accountId,
        { count: row._count._all, next: row._min.scheduledAt },
      ]),
    );

    // Top won product per account, picked over a result set bounded by the page.
    const productNames = new Map(topProducts.products.map((product) => [product.id, product]));
    const topByAccount = new Map<string, { id: string; name: string; count: number }>();
    for (const row of topProducts.rows) {
      if (!row.accountId || !row.productId) continue;
      const product = productNames.get(row.productId);
      if (!product) continue;

      const current = topByAccount.get(row.accountId);
      if (!current || row._count._all > current.count) {
        topByAccount.set(row.accountId, {
          id: product.id,
          name: product.name,
          count: row._count._all,
        });
      }
    }

    const now = new Date();

    const items = accounts.map((account) => {
      const won = wonByAccount.get(account.id) ?? { count: 0, value: 0 };
      const open = openByAccount.get(account.id) ?? 0;
      const followUp = followUpByAccount.get(account.id);
      const top = topByAccount.get(account.id) ?? null;
      const enquired = expansion.enquiredByAccount.get(account.id) ?? 0;

      const signals = signalsFor({
        status: account.status,
        wonCount: won.count,
        lastWonAt: account.lastWonAt,
        lastActivityAt: account.lastActivityAt,
        openOpportunities: open,
        openFollowUps: followUp?.count ?? 0,
        nextFollowUpAt: followUp?.next ?? null,
        neverEnquiredProducts: Math.max(expansion.catalogueSize - enquired, 0),
        topProductName: top?.name ?? null,
        dormantAfterDays: settings.dormantAfterDays,
        repeatAfterDays: DEFAULT_REPEAT_AFTER_DAYS,
        now,
      });

      return {
        accountId: account.id,
        name: account.name,
        status: account.status,
        owner: account.owner,
        headline: headlineSignal(signals),
        signals,
        wonCount: won.count,
        wonValue: won.value,
        openOpportunities: open,
        lastWonAt: account.lastWonAt?.toISOString() ?? null,
        lastActivityAt: account.lastActivityAt?.toISOString() ?? null,
        daysSinceActivity: daysSince(account.lastActivityAt, now),
        topProduct: top ? { id: top.id, name: top.name } : null,
      };
    });

    /*
     * Customers with nothing to say are dropped from the queue, and filtering
     * happens AFTER the signals are computed because a signal is a property of
     * the customer's history, not something SQL can select on.
     *
     * The trade-off is stated in `scanned`: this filters within a page rather
     * than across the whole customer base, so the screen can say how much it
     * actually looked at instead of implying it examined everything.
     */
    const withSignals = items.filter((item) => item.signals.length > 0);

    const filtered = options.signal
      ? withSignals.filter((item) =>
          item.signals.some((signal) => signal.kind === options.signal),
        )
      : withSignals;

    return { items: filtered, total, scanned: accounts.length };
  }

  /** The compact card for the main dashboard. */
  async summary(): Promise<{
    needAttention: number;
    repeatCandidates: number;
    followUpsDue: number;
    dormant: number;
    expansionCandidates: number;
    openCustomerOpportunities: number;
    scanned: number;
  }> {
    const queue = await this.actionQueue({ limit: 100 });

    const count = (kind: string): number =>
      queue.items.filter((item) => item.signals.some((signal) => signal.kind === kind)).length;

    return {
      needAttention: queue.items.length,
      repeatCandidates: count('REPEAT_CANDIDATE'),
      followUpsDue: count('FOLLOW_UP_DUE'),
      dormant: count('DORMANT'),
      expansionCandidates: count('EXPANSION_CANDIDATE'),
      openCustomerOpportunities: queue.items.reduce(
        (total, item) => total + item.openOpportunities,
        0,
      ),
      scanned: queue.scanned,
    };
  }

  /**
   * What this customer has bought, for the repeat picker.
   *
   * The previous won value is CONTEXT. It is shown so the salesperson can
   * decide, and never written into the new opportunity unless they send it —
   * an estimate is a forecast about this deal, and last quarter's price is not
   * that.
   */
  async repeatOptions(accountId: string): Promise<{
    account: { id: string; name: string; status: string };
    products: {
      productId: string;
      name: string;
      sku: string;
      active: boolean;
      wins: number;
      lastWonAt: string | null;
      lastWonValue: number | null;
      totalWonValue: number;
    }[];
    contacts: { id: string; name: string; mobile: string | null; email: string | null }[];
  }> {
    const account = await this.repository.accountForRepeat(accountId);
    if (!account) throw this.accountNotFound();

    const [history, contact] = await Promise.all([
      this.repository.wonProductHistory(accountId),
      this.repository.defaultContactFor(accountId),
    ]);

    const byId = new Map(history.products.map((product) => [product.id, product]));

    // Most recent won value per product — "what they paid last time", not a
    // sum across three deals.
    const lastValue = new Map<string, { value: number | null; at: Date | null }>();
    for (const row of history.latest) {
      if (!row.productId || lastValue.has(row.productId)) continue;
      lastValue.set(row.productId, {
        value: row.wonValue === null ? null : Number(row.wonValue),
        at: row.wonAt,
      });
    }

    const products = history.rows
      .map((row) => {
        if (!row.productId) return null;
        const product = byId.get(row.productId);
        if (!product) return null;

        const last = lastValue.get(row.productId);

        return {
          productId: product.id,
          name: product.name,
          sku: product.sku,
          active: product.active,
          wins: row._count._all,
          lastWonAt: (last?.at ?? row._max.wonAt)?.toISOString() ?? null,
          lastWonValue: last?.value ?? null,
          totalWonValue: Number(row._sum.wonValue ?? 0),
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((a, b) => b.wins - a.wins);

    return {
      account: { id: account.id, name: account.name, status: account.status },
      products,
      contacts: contact
        ? [
            {
              id: contact.id,
              name:
                [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() ||
                '(no name)',
              mobile: contact.mobile,
              email: contact.email,
            },
          ]
        : [],
    };
  }

  /**
   * Creates a repeat opportunity for an existing customer.
   *
   * An ORDINARY lead, created through LeadsService so it gets the same
   * validation, duplicate detection, timeline and follow-up rule as any other.
   * The only things this adds are the customer context and the classification.
   *
   * What it must never do: create a second account, a second contact, a second
   * product, or anything resembling an order. The account is passed through,
   * the contact is verified to belong to it, and the customer's status is not
   * touched — winning a repeat deal does not re-acquire a customer.
   */
  async createRepeatOpportunity(
    accountId: string,
    dto: CreateRepeatOpportunityDto,
    principal: TenantPrincipal,
    idempotencyKey: string | null,
  ): Promise<{ leadId: string; opportunityKind: string | null; replayed: boolean }> {
    /*
     * Double-submit protection.
     *
     * Keyed on the caller's own key, scoped to tenant and user, and returning
     * the SAME lead on replay rather than an error — a salesperson who
     * double-clicks should see the opportunity they created, not a failure.
     *
     * Deliberately NOT a uniqueness constraint on account+product: a customer
     * may legitimately have two live enquiries for the same product, and a
     * constraint would refuse real business to prevent a UI accident.
     *
     * Redis is fail-soft here. If it is unavailable the protection degrades to
     * none, which is the right way round: allowing a possible duplicate beats
     * blocking a salesperson mid-call, and a duplicate lead is visible and
     * fixable.
     */
    const cacheKey = idempotencyKey
      ? `repeat:${principal.organizationId}:${principal.userId}:${idempotencyKey}`
      : null;

    if (cacheKey) {
      const existing = await this.redis.getJson<{ leadId: string; opportunityKind: string | null }>(
        cacheKey,
      );
      if (existing) {
        return { ...existing, replayed: true };
      }
    }

    const account = await this.repository.accountForRepeat(accountId);
    if (!account) throw this.accountNotFound();

    /*
     * The contact must belong to THIS account, not merely to this tenant.
     *
     * A contact at another customer would pass every tenant check — same
     * organization, real person — and file this enquiry against the wrong
     * human being, where nobody looking at either customer would ever see it.
     */
    if (dto.contactId) {
      const belongs = await this.repository.contactBelongsToAccount(dto.contactId, accountId);
      if (!belongs) {
        throw AppException.validation('That contact does not belong to this customer.', {
          contactId: ['must be a contact at this customer'],
        });
      }
    }

    // Classified against the history AS IT IS NOW, and stored, because it is a
    // fact about this moment.
    const history = await this.repository.winHistoryFor(accountId, dto.productId ?? null);
    const opportunityKind = classifyOpportunity({
      accountId,
      accountWonCount: history.accountWonCount,
      productWonBefore: history.productWonBefore,
    });

    const contact = dto.contactId
      ? null
      : await this.repository.defaultContactFor(accountId);

    const created = await this.leads.create(
      {
        // The customer's own details stand in when no contact is named, so the
        // lead is never nameless. Nothing new is created for the customer.
        firstName: dto.firstName ?? contact?.firstName ?? account.name,
        ...(dto.lastName ?? contact?.lastName
          ? { lastName: dto.lastName ?? contact?.lastName ?? undefined }
          : {}),
        ...(dto.mobile ?? contact?.mobile ?? account.phone
          ? { mobile: dto.mobile ?? contact?.mobile ?? account.phone ?? undefined }
          : {}),
        ...(account.email ? { email: account.email } : {}),
        companyName: account.name,
        ...(account.city ? { city: account.city } : {}),
        accountId,
        ...(dto.contactId ? { contactId: dto.contactId } : {}),
        ...(dto.productId ? { productId: dto.productId } : {}),
        ...(dto.productInterest ? { productInterest: dto.productInterest } : {}),
        // Never copied from the previous deal. The screen offers the old value
        // as context; only what the salesperson actually sent lands here.
        ...(dto.estimatedValue !== undefined ? { estimatedValue: dto.estimatedValue } : {}),
        ...(dto.source ? { source: dto.source } : { source: 'Repeat business' }),
        nextFollowUpAt: dto.nextFollowUpAt,
        // A returning customer will collide with their own earlier lead on
        // mobile, and that is exactly the point — a second enquiry from a
        // customer is not a mistake.
        allowDuplicate: true,
      } as never,
      principal,
    );

    const leadId = (created as { id: string }).id;

    await this.repository.classify(leadId, opportunityKind);

    await this.audit.record({
      action: AUDIT_ACTIONS.REPEAT_OPPORTUNITY_CREATED,
      entityType: 'Lead',
      entityId: leadId,
      after: {
        accountId,
        accountName: account.name,
        contactId: dto.contactId ?? contact?.id ?? null,
        productId: dto.productId ?? null,
        opportunityKind,
        origin: 'customer-360',
      },
    });

    const result = { leadId, opportunityKind };
    if (cacheKey) await this.redis.setJson(cacheKey, result, 24 * 60 * 60);

    return { ...result, replayed: false };
  }

  /**
   * Creates an opportunity from a customer-level follow-up.
   *
   * The follow-up said "call them about the next order"; this is what happens
   * when that call produces a real requirement. The account is already known,
   * so nothing about the customer is re-entered or re-created.
   */
  async opportunityFromFollowUp(
    followUpId: string,
    dto: CreateRepeatOpportunityDto,
    principal: TenantPrincipal,
    idempotencyKey: string | null,
  ): Promise<{ leadId: string; opportunityKind: string | null; replayed: boolean }> {
    const followUp = await this.repository.accountFollowUp(followUpId);

    if (!followUp?.accountId) {
      throw AppException.notFound(
        ERROR_CODES.FOLLOW_UP_NOT_FOUND,
        'That follow-up is not on a customer.',
      );
    }

    const created = await this.createRepeatOpportunity(
      followUp.accountId,
      dto,
      principal,
      idempotencyKey,
    );

    await this.audit.record({
      action: AUDIT_ACTIONS.REPEAT_OPPORTUNITY_CREATED,
      entityType: 'Lead',
      entityId: created.leadId,
      after: { fromFollowUpId: followUpId, accountId: followUp.accountId, origin: 'follow-up' },
    });

    return created;
  }

  /** Follow-ups owed on the relationship itself. */
  async accountFollowUps(accountId: string) {
    const account = await this.repository.accountForRepeat(accountId);
    if (!account) throw this.accountNotFound();

    return this.followUps.listForAccount(accountId);
  }

  /**
   * Schedules a follow-up on the CUSTOMER, with no lead involved.
   *
   * "Call ABC Foods on Monday about a repeat order" is real work, and before
   * this the only way to record it was to invent a lead — which put a fake
   * enquiry in the pipeline and corrupted every conversion figure that counted
   * it.
   */
  async createAccountFollowUp(
    accountId: string,
    dto: { scheduledAt: string; type?: string; title?: string; notes?: string; assignedUserId?: string },
    principal: TenantPrincipal,
  ) {
    const account = await this.repository.accountForRepeat(accountId);
    if (!account) throw this.accountNotFound();

    return this.followUps.createForAccount(accountId, dto as never, principal);
  }

  private accountNotFound(): AppException {
    // The same 404 an account in another tenant produces.
    return AppException.notFound(ERROR_CODES.ACCOUNT_NOT_FOUND, 'Account not found.');
  }
}
