import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service';
import type { EmailInboundKind, Prisma } from '../../../generated/prisma/client';

@Injectable()
export class InboxRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Cross-tenant: which organizations have a mailbox to read. */
  async organizationsWithMailbox(): Promise<string[]> {
    return this.tenantContext.runAsSystem('email inbox sync: find mailboxes', async () => {
      const rows = await this.prisma.client.emailMailbox.findMany({
        where: { enabled: true, lastImapOkAt: { not: null } },
        select: { organizationId: true },
      });
      return rows.map((row) => row.organizationId);
    });
  }

  async mailbox() {
    return this.prisma.client.emailMailbox.findFirst({});
  }

  async acquireSyncLease(mailboxId: string, until: Date, now: Date): Promise<boolean> {
    const result = await this.prisma.client.emailMailbox.updateMany({
      where: { id: mailboxId, OR: [{ syncLockedUntil: null }, { syncLockedUntil: { lt: now } }] },
      data: { syncLockedUntil: until },
    });
    return result.count === 1;
  }

  async finishSync(
    mailboxId: string,
    data: {
      lastSyncAt: Date;
      lastSyncError: string | null;
      lastSyncCount?: number;
      imapUidValidity?: bigint;
      imapLastUid?: bigint;
    },
  ): Promise<void> {
    await this.prisma.client.emailMailbox.updateMany({
      where: { id: mailboxId },
      data: { ...data, syncLockedUntil: null },
    });
  }

  /** Moves the sync position forward after each message, so a crash resumes where it stopped. */
  async advance(mailboxId: string, uidValidity: bigint, uid: bigint): Promise<void> {
    await this.prisma.client.emailMailbox.updateMany({
      where: { id: mailboxId },
      data: { imapUidValidity: uidValidity, imapLastUid: uid },
    });
  }

  /**
   * Records that this exact message (mailbox + UIDVALIDITY + UID) was read.
   * Returns null if it was already recorded: reprocessing is a no-op.
   */
  async recordInbound(data: {
    mailboxId: string;
    uidValidity: bigint;
    uid: bigint;
    messageId: string | null;
    inReplyTo: string | null;
    fromAddress: string | null;
    subject: string | null;
    snippet: string | null;
    receivedAt: Date | null;
    kind: EmailInboundKind;
    recipientId: string | null;
    leadId: string | null;
  }): Promise<{ id: string } | null> {
    const rows = await this.prisma.client.emailInboundMessage.createManyAndReturn({
      skipDuplicates: true,
      data: [{ ...data, organizationId: this.tenantContext.requireOrganizationId() }],
      select: { id: true },
    });
    return rows[0] ?? null;
  }

  /** The same Message-ID seen before (a copy in another folder, a re-delivery). */
  async alreadySeenMessageId(messageId: string, exceptId: string): Promise<boolean> {
    return (
      (await this.prisma.client.emailInboundMessage.count({
        where: { messageId, id: { not: exceptId }, kind: { in: ['REPLY', 'BOUNCE'] } },
      })) > 0
    );
  }

  async recipientsByMessageIds(messageIds: string[]) {
    if (messageIds.length === 0) return [];
    return this.prisma.client.emailCampaignRecipient.findMany({
      where: { messageId: { in: messageIds } },
      select: {
        id: true,
        campaignId: true,
        leadId: true,
        email: true,
        messageId: true,
        status: true,
        campaign: { select: { name: true, subject: true } },
        lead: {
          select: { assignedToId: true, firstName: true, lastName: true, companyName: true },
        },
      },
    });
  }

  async markReplied(recipientId: string, at: Date): Promise<void> {
    await this.prisma.client.emailCampaignRecipient.updateMany({
      where: { id: recipientId, repliedAt: null },
      data: { repliedAt: at },
    });
  }

  async markBounced(recipientId: string, response: string, at: Date): Promise<void> {
    await this.prisma.client.emailCampaignRecipient.updateMany({
      where: { id: recipientId },
      data: { status: 'FAILED', failedAt: at, lastResponse: response.slice(0, 500) },
    });
  }

  async suppressBounce(email: string, campaignId: string): Promise<void> {
    await this.prisma.client.emailSuppression.createMany({
      skipDuplicates: true,
      data: [
        {
          organizationId: this.tenantContext.requireOrganizationId(),
          email,
          reason: 'BOUNCED',
          source: 'bounce-report',
          campaignId,
        },
      ],
    });
  }

  async addActivity(input: {
    leadId: string;
    type: 'EMAIL_REPLY_RECEIVED' | 'EMAIL_FAILED';
    description: string;
    metadata: Prisma.InputJsonValue;
  }): Promise<string> {
    const row = await this.prisma.client.leadActivity.create({
      data: {
        organizationId: this.tenantContext.requireOrganizationId(),
        leadId: input.leadId,
        activityType: input.type,
        description: input.description.slice(0, 1000),
        metadata: input.metadata,
      },
      select: { id: true },
    });
    await this.prisma.client.lead.updateMany({
      where: { id: input.leadId },
      data: { lastActivityAt: new Date() },
    });
    return row.id;
  }

  async linkActivity(inboundId: string, activityId: string): Promise<void> {
    await this.prisma.client.emailInboundMessage.updateMany({
      where: { id: inboundId },
      data: { activityId },
    });
  }

  /** The follow-up prompt for whoever owns the lead. Idempotent on the inbound message. */
  async notifyReply(input: {
    userId: string;
    leadId: string;
    title: string;
    body: string;
    inboundId: string;
  }): Promise<void> {
    await this.prisma.client.notification.createMany({
      skipDuplicates: true,
      data: [
        {
          organizationId: this.tenantContext.requireOrganizationId(),
          userId: input.userId,
          type: 'EMAIL_REPLY_RECEIVED',
          title: input.title.slice(0, 200),
          body: input.body.slice(0, 1000),
          entityType: 'Lead',
          entityId: input.leadId,
          dedupeKey: `email-reply:${input.inboundId}`,
        },
      ],
    });
  }
}
