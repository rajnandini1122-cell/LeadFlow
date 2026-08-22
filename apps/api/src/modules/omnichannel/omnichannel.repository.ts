import { Injectable } from '@nestjs/common';
import { PrismaService, type PrismaTransaction } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
import type { ChannelType, MessageType } from '../../generated/prisma/enums';
import type { LeadCandidate } from './lead-selection';

/**
 * Every database read and write for omnichannel capture.
 *
 * Reads carry no tenant predicate: the Prisma extension injects one on every
 * query, and a hand-written copy here would be a second, weaker version of a
 * rule that is already enforced, free to drift out of agreement with it.
 *
 * Writes DO name `organizationId` explicitly, following the same convention as
 * LeadsRepository. Prisma's generated types require it on a create, and the
 * extension overwrites whatever is passed with the tenant actually in scope —
 * so this is a type-level obligation, not a second source of truth.
 */
@Injectable()
export class OmnichannelRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private get organizationId(): string {
    return this.tenantContext.requireOrganizationId();
  }

  // --- identity -------------------------------------------------------------

  async findIdentity(channel: ChannelType, externalUserId: string) {
    return this.prisma.client.contactChannelIdentity.findFirst({
      where: { channel, externalUserId },
    });
  }

  async findLiveContactByMobile(mobile: string) {
    return this.prisma.client.contact.findFirst({
      where: { mobile, deletedAt: null, mergedIntoId: null },
      select: { id: true },
    });
  }

  /**
   * Records how a person is known on a channel.
   *
   * An upsert rather than a create because providers redeliver: the second
   * arrival of the same message must find the identity it wrote the first time
   * instead of failing on the unique index.
   */
  async upsertIdentity(input: {
    contactId: string;
    channel: ChannelType;
    externalUserId: string;
    username?: string | undefined;
    phoneNumber?: string | undefined;
    profileName?: string | undefined;
  }) {
    const existing = await this.findIdentity(input.channel, input.externalUserId);

    if (existing) {
      // Profile names and handles change. The mapping does not.
      return this.prisma.client.contactChannelIdentity.update({
        where: { id: existing.id },
        data: {
          username: input.username ?? existing.username,
          phoneNumber: input.phoneNumber ?? existing.phoneNumber,
          profileName: input.profileName ?? existing.profileName,
        },
      });
    }

    return this.prisma.client.contactChannelIdentity.create({
      data: {
        organizationId: this.organizationId,
        contactId: input.contactId,
        channel: input.channel,
        externalUserId: input.externalUserId,
        username: input.username ?? null,
        phoneNumber: input.phoneNumber ?? null,
        profileName: input.profileName ?? null,
      },
    });
  }

  // --- conversations --------------------------------------------------------

  async findConversationByExternalId(channel: ChannelType, externalConversationId: string) {
    return this.prisma.client.conversation.findFirst({
      where: { channel, externalConversationId },
    });
  }

  async findConversationById(id: string) {
    return this.prisma.client.conversation.findFirst({ where: { id } });
  }

  async listConversationsForLead(leadId: string) {
    return this.prisma.client.conversation.findMany({
      where: { leadId },
      orderBy: { lastMessageAt: 'desc' },
      include: {
        contact: { select: { id: true, firstName: true, lastName: true, mobile: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
  }

  async createConversation(input: {
    channel: ChannelType;
    integrationId: string;
    externalConversationId: string;
    contactId: string | null;
    companyName: string | null;
  }) {
    return this.prisma.client.conversation.create({
      data: {
        organizationId: this.organizationId,
        channel: input.channel,
        integrationId: input.integrationId,
        externalConversationId: input.externalConversationId,
        contactId: input.contactId,
        companyName: input.companyName,
      },
    });
  }

  // --- messages -------------------------------------------------------------

  async findMessageByExternalId(channel: ChannelType, externalMessageId: string) {
    return this.prisma.client.message.findFirst({ where: { channel, externalMessageId } });
  }

  async createMessage(input: {
    conversationId: string;
    channel: ChannelType;
    externalMessageId: string;
    content: string | null;
    messageType: MessageType;
    sentAt: Date;
  }) {
    return this.prisma.client.message.create({
      data: {
        organizationId: this.organizationId,
        conversationId: input.conversationId,
        channel: input.channel,
        externalMessageId: input.externalMessageId,
        direction: 'INCOMING',
        senderType: 'CONTACT',
        messageType: input.messageType,
        content: input.content,
        sentAt: input.sentAt,
        receivedAt: new Date(),
      },
    });
  }

  // --- leads ----------------------------------------------------------------

  /**
   * Every live lead for one contact.
   *
   * Archived leads are excluded outright — attaching a customer's message to a
   * lead somebody deliberately archived would resurrect it in every list.
   */
  async findLeadsForContact(contactId: string): Promise<LeadCandidate[]> {
    return this.prisma.client.lead.findMany({
      where: { contactId, deletedAt: null },
      select: {
        id: true,
        leadNumber: true,
        status: true,
        assignedToId: true,
        companyName: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findLeadById(id: string) {
    return this.prisma.client.lead.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        leadNumber: true,
        status: true,
        assignedToId: true,
        contactId: true,
        companyName: true,
        createdAt: true,
      },
    });
  }

  // --- linking --------------------------------------------------------------

  /**
   * Attaches a conversation to a lead and records it on the lead's timeline,
   * in one transaction.
   *
   * Together, because a link with no activity is invisible to the person who
   * owns the lead, and an activity claiming a link that did not happen is a
   * lie in an append-only log. Either both land or neither does.
   *
   * `ownerId` follows the lead's existing assignee and is never computed here.
   * Assignment stays entirely in the existing lead flow.
   */
  async linkToLead(input: {
    conversationId: string;
    leadId: string;
    ownerId: string | null;
    description: string;
    actorId: string | null;
  }): Promise<void> {
    const organizationId = this.organizationId;

    await this.prisma.client.$transaction(async (tx: PrismaTransaction) => {
      await tx.conversation.update({
        where: { id: input.conversationId },
        data: {
          leadId: input.leadId,
          ownerId: input.ownerId,
          linkState: 'LINKED',
        },
      });

      await tx.leadActivity.create({
        data: {
          organizationId,
          leadId: input.leadId,
          activityType: 'CONVERSATION_LINKED',
          description: input.description,
          performedById: input.actorId,
        },
      });

      // The lead has been touched by the customer. Reporting reads this, and
      // leaving it stale would make a live conversation look like a cold lead.
      await tx.lead.update({
        where: { id: input.leadId },
        data: { lastActivityAt: new Date() },
      });
    });
  }

  async unlinkFromLead(input: {
    conversationId: string;
    leadId: string;
    description: string;
    actorId: string | null;
  }): Promise<void> {
    const organizationId = this.organizationId;

    await this.prisma.client.$transaction(async (tx: PrismaTransaction) => {
      await tx.conversation.update({
        where: { id: input.conversationId },
        data: { leadId: null, ownerId: null, linkState: 'UNLINKED' },
      });

      await tx.leadActivity.create({
        data: {
          organizationId,
          leadId: input.leadId,
          activityType: 'CONVERSATION_UNLINKED',
          description: input.description,
          performedById: input.actorId,
        },
      });
    });
  }

  async markReviewRequired(conversationId: string): Promise<void> {
    await this.prisma.client.conversation.update({
      where: { id: conversationId },
      data: { linkState: 'REVIEW_REQUIRED' },
    });
  }

  async touchConversation(input: {
    conversationId: string;
    contactId?: string | null;
    lastMessageAt: Date;
  }): Promise<void> {
    await this.prisma.client.conversation.update({
      where: { id: input.conversationId },
      data: {
        lastMessageAt: input.lastMessageAt,
        ...(input.contactId ? { contactId: input.contactId } : {}),
      },
    });
  }

  /**
   * Records that this thread looks like a buying enquiry.
   *
   * Signals accumulate across messages rather than being replaced: a customer
   * who opens with "hi" and follows with "what is your MOQ" should end up
   * flagged, and the reviewer should see every word that contributed.
   */
  async markPotentialLead(conversationId: string, signals: string[]): Promise<void> {
    const existing = await this.prisma.client.conversation.findFirst({
      where: { id: conversationId },
      select: { potentialLeadSignals: true },
    });

    const merged = [...new Set([...(existing?.potentialLeadSignals ?? []), ...signals])];

    await this.prisma.client.conversation.update({
      where: { id: conversationId },
      data: { potentialLead: true, potentialLeadSignals: merged },
    });
  }

  // --- review queue ---------------------------------------------------------

  /**
   * The summary shape every list returns.
   *
   * Deliberately excludes messages beyond the most recent one: an inbox page
   * showing fifty threads must not drag fifty full histories across the wire,
   * and the detail view loads them when a thread is actually opened.
   */
  private static readonly SUMMARY_INCLUDE = {
    contact: {
      select: {
        id: true,
        firstName: true,
        lastName: true,
        mobile: true,
        email: true,
        companyName: true,
      },
    },
    owner: { select: { id: true, fullName: true } },
    lead: { select: { id: true, leadNumber: true, status: true } },
    messages: { orderBy: { createdAt: 'desc' }, take: 1 },
  } as const;

  /**
   * Conversations, filtered by what the caller may see.
   *
   * `scopeFilter` comes from conversation-visibility.ts and is merged into the
   * WHERE clause rather than applied afterwards, so a conversation the caller
   * may not see is never loaded and never counted.
   */
  async listConversations(options: {
    scopeFilter: Record<string, unknown> | undefined;
    channel?: 'WHATSAPP' | 'FACEBOOK' | 'INSTAGRAM' | undefined;
    category?: string | undefined;
    /** Inbox-only: narrow to mine or to unowned. */
    inboxFilter?: 'MINE' | 'UNASSIGNED' | undefined;
    userId?: string | undefined;
    archived: boolean;
    /** Review lists hide already-linked threads; the inbox shows everything. */
    excludeLinked: boolean;
    limit: number;
    cursor?: string | undefined;
  }) {
    const where = this.buildWhere(options);

    const rows = await this.prisma.client.conversation.findMany({
      where,
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      take: options.limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      include: OmnichannelRepository.SUMMARY_INCLUDE,
    });

    const hasMore = rows.length > options.limit;
    return { rows: hasMore ? rows.slice(0, options.limit) : rows, hasMore };
  }

  async countConversations(options: {
    scopeFilter: Record<string, unknown> | undefined;
    inboxFilter?: 'MINE' | 'UNASSIGNED' | undefined;
    userId?: string | undefined;
    archived: boolean;
    excludeLinked: boolean;
    category?: string | undefined;
  }): Promise<number> {
    return this.prisma.client.conversation.count({ where: this.buildWhere(options) });
  }

  /** One WHERE builder, so a list and its count can never disagree. */
  private buildWhere(options: {
    scopeFilter: Record<string, unknown> | undefined;
    channel?: 'WHATSAPP' | 'FACEBOOK' | 'INSTAGRAM' | undefined;
    category?: string | undefined;
    inboxFilter?: 'MINE' | 'UNASSIGNED' | undefined;
    userId?: string | undefined;
    archived: boolean;
    excludeLinked: boolean;
  }): Record<string, unknown> {
    const and: Record<string, unknown>[] = [];

    const where: Record<string, unknown> = {
      archivedAt: options.archived ? { not: null } : null,
    };

    if (options.channel) where['channel'] = options.channel;
    if (options.scopeFilter) and.push(options.scopeFilter);

    switch (options.inboxFilter) {
      case 'MINE':
        // Mine means mine: threads assigned to me, or on a lead assigned to me.
        and.push({
          OR: [{ ownerId: options.userId }, { lead: { assignedToId: options.userId } }],
        });
        break;
      case 'UNASSIGNED':
        // Narrows what is already visible. It never widens it — the scope
        // filter above still applies, so a rep with the shared queue switched
        // off sees nothing here rather than everything.
        and.push({ ownerId: null });
        break;
      default:
        break;
    }

    switch (options.category) {
      case 'UNRESOLVED':
        where['contactId'] = null;
        where['linkState'] = 'UNLINKED';
        break;
      case 'UNLINKED':
        where['contactId'] = { not: null };
        where['linkState'] = 'UNLINKED';
        break;
      case 'REVIEW_REQUIRED':
        where['linkState'] = 'REVIEW_REQUIRED';
        break;
      case 'POTENTIAL_LEAD':
        where['potentialLead'] = true;
        where['linkState'] = { not: 'LINKED' };
        break;
      case 'LINKED':
        where['linkState'] = 'LINKED';
        break;
      default:
        // The review queue hides what has already been dealt with; the inbox
        // is the whole picture and hides nothing.
        if (options.excludeLinked) where['linkState'] = { not: 'LINKED' };
    }

    if (and.length > 0) where['AND'] = and;
    return where;
  }

  /** One conversation with its full message history, for the detail view. */
  async findConversationDetail(id: string) {
    return this.prisma.client.conversation.findFirst({
      where: { id },
      include: {
        contact: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            mobile: true,
            email: true,
            companyName: true,
          },
        },
        owner: { select: { id: true, fullName: true } },
        lead: {
          select: { id: true, leadNumber: true, status: true, assignedToId: true },
        },
        integration: { select: { id: true, displayName: true, status: true } },
        messages: { orderBy: { createdAt: 'asc' }, take: 200 },
      },
    });
  }

  async setArchived(input: {
    conversationId: string;
    archivedAt: Date | null;
    actorId: string | null;
    reason: string | null;
  }): Promise<void> {
    await this.prisma.client.conversation.update({
      where: { id: input.conversationId },
      data: {
        archivedAt: input.archivedAt,
        archivedById: input.archivedAt ? input.actorId : null,
        archivedReason: input.archivedAt ? input.reason : null,
      },
    });
  }

  /**
   * Candidate leads for a contact, narrowed to what this caller may see.
   *
   * The visibility filter is applied HERE rather than after fetching, so a
   * candidate list can never become a way to learn that a colleague's lead
   * exists.
   */
  async findVisibleLeadsForContact(contactId: string, assignedToId: string | undefined) {
    return this.prisma.client.lead.findMany({
      where: {
        contactId,
        deletedAt: null,
        ...(assignedToId ? { assignedToId } : {}),
      },
      select: {
        id: true,
        leadNumber: true,
        status: true,
        companyName: true,
        productInterest: true,
        createdAt: true,
        lastActivityAt: true,
        assignedTo: { select: { id: true, fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }

  // --- activity -------------------------------------------------------------

  async recordLeadActivity(input: {
    leadId: string;
    activityType: 'CHANNEL_MESSAGE_RECEIVED' | 'CONVERSATION_LINKED' | 'CONVERSATION_UNLINKED';
    description: string;
    actorId: string | null;
  }): Promise<void> {
    await this.prisma.client.leadActivity.create({
      data: {
        organizationId: this.organizationId,
        leadId: input.leadId,
        activityType: input.activityType,
        description: input.description,
        performedById: input.actorId,
      },
    });
  }

  /**
   * Whether this exact activity already exists for this lead.
   *
   * The guard against a redelivered message adding a second identical line to
   * an append-only timeline that can never be tidied up afterwards.
   */
  async hasActivity(leadId: string, description: string): Promise<boolean> {
    const existing = await this.prisma.client.leadActivity.findFirst({
      where: { leadId, description },
      select: { id: true },
    });
    return existing !== null;
  }

  // --- integrations ---------------------------------------------------------

  /**
   * Every integration record this organization has.
   *
   * A channel with no row has simply never been connected. The UI derives
   * "Not connected" from the absence rather than from a stored state, so there
   * is nothing to keep in step and no row to invent at signup.
   */
  async listIntegrations() {
    return this.prisma.client.channelIntegration.findMany({
      orderBy: { channel: 'asc' },
      select: {
        id: true,
        channel: true,
        status: true,
        enabled: true,
        displayName: true,
        providerAccountId: true,
        connectedAt: true,
        disconnectedAt: true,
        lastErrorAt: true,
        lastErrorMessage: true,
        connectedBy: { select: { id: true, fullName: true } },
      },
    });
  }

  async findIntegration(id: string) {
    return this.prisma.client.channelIntegration.findFirst({ where: { id } });
  }

  async setIntegrationEnabled(id: string, enabled: boolean) {
    await this.prisma.client.channelIntegration.update({ where: { id }, data: { enabled } });
  }

  /** The most recent inbound message per channel, for "last activity". */
  async lastActivityByChannel(): Promise<Record<string, string>> {
    const rows = await this.prisma.client.message.groupBy({
      by: ['channel'],
      _max: { createdAt: true },
      orderBy: { channel: 'asc' },
    });

    const result: Record<string, string> = {};
    for (const row of rows) {
      // Only real timestamps. A channel that has never carried a message gets
      // no entry, and the UI shows nothing rather than inventing a date.
      if (row._max.createdAt) result[row.channel] = row._max.createdAt.toISOString();
    }
    return result;
  }

  // --- assignment -----------------------------------------------------------

  /**
   * Sets who is handling a conversation.
   *
   * Writes `conversations.owner_id` and nothing else. The linked lead's
   * `assignedToId` is deliberately untouched: handing a thread to a colleague
   * is not the same act as handing them the deal, and conflating the two would
   * silently move a salesperson's pipeline out from under them.
   */
  async setConversationOwner(conversationId: string, ownerId: string | null): Promise<void> {
    await this.prisma.client.conversation.update({
      where: { id: conversationId },
      data: { ownerId },
    });
  }

  /** An ACTIVE member of this organization, for validating an assignee. */
  async findAssignableMember(userId: string) {
    const membership = await this.prisma.client.organizationUser.findFirst({
      where: { userId, status: 'ACTIVE' },
      select: { userId: true, user: { select: { id: true, fullName: true } } },
    });
    return membership?.user ?? null;
  }

  // --- settings -------------------------------------------------------------

  /**
   * The tenant's dialling region, for canonicalising an incoming phone number.
   *
   * The same one-line query LeadsRepository already makes. Duplicated rather
   * than reaching into that repository, because a cross-module repository
   * dependency is a heavier coupling than a two-line SELECT, and the country
   * is tenant data either way.
   */
  async organizationCountry(): Promise<string> {
    const organization = await this.prisma.client.organization.findFirst({
      select: { country: true },
    });
    return organization?.country ?? 'US';
  }

  async omnichannelEnabled(): Promise<boolean> {
    const settings = await this.prisma.client.organizationSettings.findFirst({
      select: { omnichannelEnabled: true },
    });
    return settings?.omnichannelEnabled ?? false;
  }

  /**
   * Whether ordinary sales users may browse unowned conversations.
   *
   * Defaults to false when a tenant has no settings row at all — the closed
   * answer, so a missing row can never widen who sees a customer's message.
   */
  async sharedUnassignedQueue(): Promise<boolean> {
    const settings = await this.prisma.client.organizationSettings.findFirst({
      select: { sharedUnassignedQueue: true },
    });
    return settings?.sharedUnassignedQueue ?? false;
  }
}
