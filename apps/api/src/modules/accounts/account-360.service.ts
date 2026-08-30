import { Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import { AccountsRepository } from './accounts.repository';
import { Account360Repository } from './account-360.repository';

/**
 * Customer 360 — one customer's whole relationship on one screen.
 *
 * Assembled from the EXISTING entities: leads are the opportunities,
 * LeadActivity is the timeline, Conversation is the correspondence. Nothing
 * here is a second copy of any of them, and nothing invents an order or
 * revenue concept LeadFlow does not have — the commercial figures are CRM
 * opportunity figures and say so.
 *
 * Every list reports its own total alongside a bounded page, so the screen can
 * say "20 of 340" instead of quietly showing a truncated history as if it were
 * the whole thing.
 */
@Injectable()
export class Account360Service {
  constructor(
    private readonly accounts: AccountsRepository,
    private readonly repository: Account360Repository,
  ) {}

  async load(accountId: string) {
    const account = await this.accounts.findById(accountId);

    if (!account) {
      /*
       * A merged account is not gone — it IS another account now. Following the
       * chain and saying so beats a 404 for a company whose history is sitting
       * right there under a different id.
       */
      const survivor = await this.accounts.resolveSurvivor(accountId);
      if (survivor && survivor.id !== accountId) {
        throw AppException.notFound(
          ERROR_CODES.ACCOUNT_NOT_FOUND,
          `This account was merged into "${survivor.name}". Open that one instead.`,
        );
      }

      // Same 404 as an account in another tenant — the response must not
      // confirm that an id exists somewhere else.
      throw AppException.notFound(ERROR_CODES.ACCOUNT_NOT_FOUND, 'Account not found.');
    }

    const [
      contacts,
      openOpportunities,
      closedOpportunities,
      commercial,
      productHistory,
      leadsWithoutProduct,
      conversations,
      activities,
      followUps,
      crossSell,
    ] = await Promise.all([
      this.repository.contacts(accountId),
      this.repository.opportunities(accountId, false),
      this.repository.opportunities(accountId, true),
      this.repository.commercialSummary(accountId),
      this.repository.productHistory(accountId),
      this.repository.leadsWithoutProduct(accountId),
      this.repository.conversations(accountId),
      this.repository.activities(accountId),
      this.repository.accountFollowUps(accountId),
      this.repository.crossSellGaps(accountId),
    ]);

    const wonCount = commercial.won._count._all;
    const wonValue = Number(commercial.won._sum.wonValue ?? 0);

    return {
      account: {
        id: account.id,
        name: account.name,
        status: account.status,
        industry: account.industry,
        website: account.website,
        domain: account.domain,
        phone: account.phone,
        email: account.email,
        city: account.city,
        state: account.state,
        country: account.country,
        source: account.source,
        notes: account.notes,
        owner: account.owner,
        firstContactAt: account.firstContactAt?.toISOString() ?? null,
        firstWonAt: account.firstWonAt?.toISOString() ?? null,
        lastWonAt: account.lastWonAt?.toISOString() ?? null,
        lastActivityAt: account.lastActivityAt?.toISOString() ?? null,
        active: account.active,
      },

      contacts: {
        items: contacts.items.map((contact) => ({
          id: contact.id,
          name:
            [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() || '(no name)',
          mobile: contact.mobile,
          email: contact.email,
          notes: contact.notes,
          leadCount: contact._count.leads,
          createdAt: contact.createdAt.toISOString(),
        })),
        total: contacts.total,
      },

      openOpportunities: {
        items: openOpportunities.items.map(toOpportunity),
        total: openOpportunities.total,
      },

      closedOpportunities: {
        items: closedOpportunities.items.map(toOpportunity),
        total: closedOpportunities.total,
      },

      /**
       * CRM opportunity figures, and labelled as such.
       *
       * LeadFlow has no Order table, so there is no invoiced revenue to report.
       * Saying plainly what these numbers are beats inventing an order concept
       * to fill the section — and the shape leaves room for real order data to
       * be added later without changing what these mean.
       */
      commercial: {
        basis: 'crm-opportunities' as const,
        wonCount,
        wonValue,
        averageDealValue: wonCount > 0 ? wonValue / wonCount : null,
        lostCount: commercial.lost._count._all,
        lostEstimatedValue: Number(commercial.lost._sum.estimatedValue ?? 0),
        openCount: commercial.open._count._all,
        openPipeline: Number(commercial.open._sum.estimatedValue ?? 0),
        firstWonAt: commercial.firstWonAt?.toISOString() ?? null,
        lastWonAt: commercial.lastWonAt?.toISOString() ?? null,
        // More than one win is what makes this a repeat customer, and it is the
        // single most useful fact on the page.
        repeatOrderCount: wonCount > 1 ? wonCount - 1 : 0,
        isRepeatCustomer: wonCount > 1,
      },

      products: buildProductHistory(productHistory, leadsWithoutProduct),

      conversations: {
        items: conversations.items.map((conversation) => ({
          id: conversation.id,
          channel: conversation.channel,
          status: conversation.status,
          linkState: conversation.linkState,
          lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
          messageCount: conversation._count.messages,
          contactName: conversation.contact
            ? [conversation.contact.firstName, conversation.contact.lastName]
                .filter(Boolean)
                .join(' ')
                .trim() || null
            : null,
          leadId: conversation.lead?.id ?? null,
          leadNumber: conversation.lead?.leadNumber ?? null,
          owner: conversation.owner,
        })),
        total: conversations.total,
      },

      activities: {
        items: activities.items.map((activity) => ({
          id: activity.id,
          type: activity.activityType,
          description: activity.description,
          leadId: activity.lead.id,
          leadNumber: activity.lead.leadNumber,
          performedBy: activity.performedBy,
          createdAt: activity.createdAt.toISOString(),
        })),
        total: activities.total,
      },

      /** Follow-ups on the RELATIONSHIP. Each opportunity carries its own. */
      followUps: followUps.map((followUp) => ({
        id: followUp.id,
        scheduledAt: followUp.scheduledAt.toISOString(),
        type: followUp.type,
        status: followUp.status,
        title: followUp.title,
        notes: followUp.notes,
        outcome: followUp.outcome,
        completedAt: followUp.completedAt?.toISOString() ?? null,
        assignedTo: followUp.assignedUser,
        isOverdue:
          ['UPCOMING', 'DUE', 'OVERDUE'].includes(followUp.status) &&
          followUp.scheduledAt.getTime() < Date.now(),
      })),

      /**
       * Active products this customer has never enquired about.
       *
       * The whole of the V1 cross-sell rule: a set difference over what
       * actually happened, with no model and no score pretending to know what
       * they want next. A rep can judge "they buy garlic powder and have never
       * asked about garlic flakes" perfectly well themselves.
       */
      crossSell: crossSell.map((product) => ({
        productId: product.id,
        name: product.name,
        sku: product.sku,
        category: product.category,
      })),
    };
  }
}

type OpportunityRow = {
  id: string;
  leadNumber: string;
  firstName: string | null;
  lastName: string | null;
  status: string;
  priority: string;
  source: string | null;
  estimatedValue: { toString(): string } | null;
  wonValue: { toString(): string } | null;
  wonAt: Date | null;
  lostAt: Date | null;
  lostReason: string | null;
  nextFollowUpAt: Date | null;
  lastActivityAt: Date | null;
  createdAt: Date;
  productInterest: string | null;
  product: { id: string; name: string; sku: string } | null;
  assignedTo: { id: string; fullName: string } | null;
  contact: { id: string; firstName: string | null; lastName: string | null } | null;
};

function toOpportunity(lead: OpportunityRow) {
  return {
    id: lead.id,
    leadNumber: lead.leadNumber,
    name: [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim() || null,
    status: lead.status,
    priority: lead.priority,
    source: lead.source,
    estimatedValue: lead.estimatedValue ? Number(lead.estimatedValue.toString()) : null,
    wonValue: lead.wonValue ? Number(lead.wonValue.toString()) : null,
    wonAt: lead.wonAt?.toISOString() ?? null,
    lostAt: lead.lostAt?.toISOString() ?? null,
    lostReason: lead.lostReason,
    nextFollowUpAt: lead.nextFollowUpAt?.toISOString() ?? null,
    lastActivityAt: lead.lastActivityAt?.toISOString() ?? null,
    createdAt: lead.createdAt.toISOString(),
    // Both, always. The product is the grouping key; the free text is what the
    // customer actually asked for, and no catalogue entry can carry that.
    product: lead.product,
    productInterest: lead.productInterest,
    assignedTo: lead.assignedTo,
    contact: lead.contact
      ? {
          id: lead.contact.id,
          name:
            [lead.contact.firstName, lead.contact.lastName].filter(Boolean).join(' ').trim() ||
            '(no name)',
        }
      : null,
  };
}

/**
 * What this customer has enquired about, won and lost, per product.
 *
 * `leadsWithoutProduct` is returned alongside so the screen can say how much of
 * this customer's story the breakdown covers — a customer with two mapped leads
 * out of forty is not a two-product customer, and without this figure they
 * would look like one.
 */
function buildProductHistory(
  history: {
    rows: {
      productId: string | null;
      status: string;
      _count: { _all: number };
      _sum: { wonValue: unknown; estimatedValue: unknown };
    }[];
    products: { id: string; name: string; sku: string; category: string | null; active: boolean }[];
  },
  leadsWithoutProduct: number,
) {
  const byId = new Map(history.products.map((product) => [product.id, product]));
  const summary = new Map<
    string,
    { enquiries: number; won: number; wonValue: number; lost: number; open: number }
  >();

  for (const row of history.rows) {
    if (!row.productId) continue;

    const entry = summary.get(row.productId) ?? {
      enquiries: 0,
      won: 0,
      wonValue: 0,
      lost: 0,
      open: 0,
    };

    entry.enquiries += row._count._all;

    if (row.status === 'WON') {
      entry.won += row._count._all;
      entry.wonValue += Number(row._sum.wonValue ?? 0);
    } else if (row.status === 'LOST') {
      entry.lost += row._count._all;
    } else {
      entry.open += row._count._all;
    }

    summary.set(row.productId, entry);
  }

  const items = [...summary.entries()]
    .map(([productId, entry]) => {
      const product = byId.get(productId);
      if (!product) return null;

      return {
        productId,
        name: product.name,
        sku: product.sku,
        category: product.category,
        active: product.active,
        ...entry,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => b.enquiries - a.enquiries);

  return { items, leadsWithoutProduct };
}
