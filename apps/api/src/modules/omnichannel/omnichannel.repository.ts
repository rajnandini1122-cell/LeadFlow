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
}
