import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { LeadStatus } from '../../generated/prisma/enums';

/**
 * Everything Customer 360 shows about one account.
 *
 * Two rules govern this file.
 *
 * FIRST, nothing loads a customer's whole history into memory. Totals are
 * `groupBy` and `aggregate`; the lists are bounded with an explicit `take` and
 * report their own total so the screen can say "showing 20 of 340" rather than
 * quietly truncating. A ten-year customer must not be able to make this
 * endpoint fall over.
 *
 * SECOND, conversations and activities are reached through RELATION FILTERS
 * (`where: { lead: { accountId } }`) rather than by fetching the account's lead
 * ids and passing them back in an `IN` list. The relation filter compiles to a
 * join; the `IN` list would grow with the customer and eventually exceed what
 * is sensible to send. It also means there is no denormalised accountId on
 * Conversation to drift out of step with the lead it hangs off.
 *
 * Every model touched here is tenant-scoped, so an account id belonging to
 * another organization matches nothing rather than leaking a row.
 */
@Injectable()
export class Account360Repository {
  constructor(private readonly prisma: PrismaService) {}

  /** People at this company. */
  async contacts(accountId: string, limit = 50) {
    const [items, total] = await Promise.all([
      this.prisma.client.contact.findMany({
        where: { accountId, deletedAt: null, mergedIntoId: null },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          mobile: true,
          email: true,
          notes: true,
          createdAt: true,
          _count: { select: { leads: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      this.prisma.client.contact.count({
        where: { accountId, deletedAt: null, mergedIntoId: null },
      }),
    ]);

    return { items, total };
  }

  /**
   * Opportunities, open or closed.
   *
   * `closed` decides which side is returned. They are separate calls rather
   * than one list the caller filters, because the screen shows them as two
   * different things — what we are working on now, and what happened before —
   * and each needs its own ordering and its own limit.
   */
  async opportunities(accountId: string, closed: boolean, limit = 25) {
    /*
     * One object shape, not a union of two. Spreading a conditional produced
     * `{ in } | { notIn }`, which Prisma's Exact<> constraint rejects because
     * it cannot prove the absent key is genuinely absent.
     */
    const terminal: LeadStatus[] = ['WON', 'LOST'];
    const where = {
      accountId,
      deletedAt: null,
      status: closed ? { in: terminal } : { notIn: terminal },
    };

    const [items, total] = await Promise.all([
      this.prisma.client.lead.findMany({
        where,
        select: {
          id: true,
          leadNumber: true,
          firstName: true,
          lastName: true,
          status: true,
          priority: true,
          source: true,
          estimatedValue: true,
          wonValue: true,
          wonAt: true,
          lostAt: true,
          lostReason: true,
          nextFollowUpAt: true,
          lastActivityAt: true,
          createdAt: true,
          productInterest: true,
          product: { select: { id: true, name: true, sku: true } },
          assignedTo: { select: { id: true, fullName: true } },
          contact: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: closed
          ? [{ wonAt: { sort: 'desc', nulls: 'last' } }, { lostAt: { sort: 'desc', nulls: 'last' } }]
          : [{ nextFollowUpAt: { sort: 'asc', nulls: 'last' } }],
        take: limit,
      }),
      this.prisma.client.lead.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * The commercial summary, entirely from the database.
   *
   * There is no Order table in LeadFlow, so these are CRM opportunity figures
   * and the service labels them as such. Inventing an order concept to fill the
   * section would be worse than saying plainly what the numbers are.
   */
  async commercialSummary(accountId: string) {
    const [won, lost, open, firstWon, lastWon] = await Promise.all([
      this.prisma.client.lead.aggregate({
        where: { accountId, status: 'WON', deletedAt: null },
        _count: { _all: true },
        _sum: { wonValue: true },
        _avg: { wonValue: true },
      }),
      this.prisma.client.lead.aggregate({
        where: { accountId, status: 'LOST', deletedAt: null },
        _count: { _all: true },
        _sum: { estimatedValue: true },
      }),
      this.prisma.client.lead.aggregate({
        where: { accountId, status: { notIn: ['WON', 'LOST'] }, deletedAt: null },
        _count: { _all: true },
        _sum: { estimatedValue: true },
      }),
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
    ]);

    return { won, lost, open, firstWonAt: firstWon?.wonAt ?? null, lastWonAt: lastWon?.wonAt ?? null };
  }

  /**
   * What this customer has asked about and bought, grouped by product.
   *
   * One `groupBy` over the account's leads rather than a query per product. The
   * product names are then fetched in a single `findMany` over the ids that
   * actually appeared — two queries total, whatever the size of the catalogue.
   */
  async productHistory(accountId: string) {
    const rows = await this.prisma.client.lead.groupBy({
      by: ['productId', 'status'],
      where: { accountId, deletedAt: null, productId: { not: null } },
      _count: { _all: true },
      _sum: { wonValue: true, estimatedValue: true },
    });

    const productIds = [...new Set(rows.map((row) => row.productId).filter((id): id is string => id !== null))];

    const products = productIds.length
      ? await this.prisma.client.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, name: true, sku: true, category: true, active: true },
        })
      : [];

    return { rows, products };
  }

  /**
   * Leads at this account with no product attached.
   *
   * Reported alongside the product history so the screen can say how much of
   * this customer's story the product breakdown actually covers — otherwise a
   * customer with two mapped leads out of forty looks like a two-product
   * customer.
   */
  async leadsWithoutProduct(accountId: string): Promise<number> {
    return this.prisma.client.lead.count({
      where: { accountId, deletedAt: null, productId: null },
    });
  }

  /**
   * Conversations belonging to this customer, across every channel.
   *
   * Reached by relation filter through either the contact or the lead — a
   * thread is this customer's if it is with one of their people OR about one of
   * their opportunities. Reusing the existing conversation architecture
   * entirely; nothing here is a second messaging system.
   */
  async conversations(accountId: string, limit = 20) {
    const where = {
      OR: [{ contact: { accountId } }, { lead: { accountId } }],
    };

    const [items, total] = await Promise.all([
      this.prisma.client.conversation.findMany({
        where,
        select: {
          id: true,
          channel: true,
          status: true,
          linkState: true,
          lastMessageAt: true,
          companyName: true,
          contact: { select: { id: true, firstName: true, lastName: true } },
          lead: { select: { id: true, leadNumber: true } },
          owner: { select: { id: true, fullName: true } },
          _count: { select: { messages: true } },
        },
        orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
        take: limit,
      }),
      this.prisma.client.conversation.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * The activity timeline, rolled up from every opportunity at this account.
   *
   * LeadActivity hangs off a lead, so this is the account's history as seen
   * through its opportunities — which is where the calls, emails and notes were
   * actually recorded. Bounded, newest first.
   */
  async activities(accountId: string, limit = 30) {
    const where = { lead: { accountId } };

    const [items, total] = await Promise.all([
      this.prisma.client.leadActivity.findMany({
        where,
        select: {
          id: true,
          activityType: true,
          description: true,
          createdAt: true,
          lead: { select: { id: true, leadNumber: true } },
          performedBy: { select: { id: true, fullName: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      this.prisma.client.leadActivity.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Follow-ups owed on the RELATIONSHIP, not on any single opportunity.
   *
   * Deliberately does not roll up the leads' follow-ups: those appear under
   * their opportunities, and merging the two would make "we owe this customer a
   * call" indistinguishable from "we owe this deal a call".
   */
  async accountFollowUps(accountId: string, limit = 20) {
    return this.prisma.client.followUp.findMany({
      where: { accountId },
      select: {
        id: true,
        scheduledAt: true,
        type: true,
        status: true,
        title: true,
        notes: true,
        outcome: true,
        completedAt: true,
        assignedUser: { select: { id: true, fullName: true } },
      },
      orderBy: { scheduledAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Active catalogue products this customer has NEVER enquired about.
   *
   * Two queries, no per-product loop: the ids they have enquired about, then
   * the active catalogue minus those. Retired products are excluded because
   * suggesting something no longer sold would waste the call.
   */
  async crossSellGaps(accountId: string, limit = 10) {
    const enquired = await this.prisma.client.lead.findMany({
      where: { accountId, deletedAt: null, productId: { not: null } },
      select: { productId: true },
      distinct: ['productId'],
    });

    const enquiredIds = enquired
      .map((row) => row.productId)
      .filter((id): id is string => id !== null);

    return this.prisma.client.product.findMany({
      where: { active: true, ...(enquiredIds.length ? { id: { notIn: enquiredIds } } : {}) },
      select: { id: true, name: true, sku: true, category: true },
      orderBy: { name: 'asc' },
      take: limit,
    });
  }
}
