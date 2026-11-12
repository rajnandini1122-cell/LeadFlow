import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service';
import type { EmailMailbox, Prisma } from '../../../generated/prisma/client';

/**
 * Storage for provider events (Resend webhooks).
 *
 * The one cross-tenant read: the webhook carries no session, so its mailbox is
 * found by id. Everything after that runs inside that mailbox's organization,
 * and a provider message id is only ever looked up within it — an event signed
 * for one organization's mailbox can never touch another's recipients.
 */
@Injectable()
export class ProviderEventsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async mailboxById(id: string): Promise<EmailMailbox | null> {
    return this.tenantContext.runAsSystem('email provider webhook: resolve mailbox', () =>
      this.prisma.client.emailMailbox.findUnique({ where: { id } }),
    );
  }

  /** Records the event once. False if this event id was already applied (redelivery or replay). */
  async claimEvent(input: {
    mailboxId: string;
    eventId: string;
    type: string;
    providerMessageId: string | null;
    recipientId: string | null;
  }): Promise<boolean> {
    const rows = await this.prisma.client.emailProviderEvent.createManyAndReturn({
      skipDuplicates: true,
      data: [
        {
          organizationId: this.tenantContext.requireOrganizationId(),
          mailboxId: input.mailboxId,
          provider: 'RESEND',
          eventId: input.eventId,
          type: input.type,
          providerMessageId: input.providerMessageId,
          recipientId: input.recipientId,
        },
      ],
      select: { id: true },
    });
    return rows.length === 1;
  }

  async recipientByProviderId(providerMessageId: string) {
    return this.prisma.client.emailCampaignRecipient.findFirst({
      where: { providerMessageId },
      select: {
        id: true,
        campaignId: true,
        leadId: true,
        email: true,
        status: true,
        messageId: true,
        campaign: { select: { name: true, subject: true } },
      },
    });
  }

  /**
   * A broadcast email's row: this organization's campaign with that broadcast
   * id, and the address. The provider's email id is stored on first sight, so
   * later events find the row directly.
   */
  async recipientByBroadcast(broadcastId: string, email: string, providerMessageId: string) {
    const campaign = await this.prisma.client.emailCampaign.findFirst({
      where: { providerBroadcastId: broadcastId },
      select: { id: true },
    });
    if (!campaign) return null;
    const row = await this.prisma.client.emailCampaignRecipient.findFirst({
      where: { campaignId: campaign.id, email, providerMessageId: null },
      select: { id: true },
    });
    if (!row) return null;
    await this.prisma.client.emailCampaignRecipient.updateMany({
      where: { id: row.id, providerMessageId: null },
      data: { providerMessageId },
    });
    return this.recipientByProviderId(providerMessageId);
  }

  async addSentActivity(
    leadId: string | null,
    description: string,
    metadata: Prisma.InputJsonValue,
  ): Promise<void> {
    if (!leadId) return;
    await this.prisma.client.leadActivity.create({
      data: {
        organizationId: this.tenantContext.requireOrganizationId(),
        leadId,
        activityType: 'EMAIL_SENT',
        description: description.slice(0, 1000),
        metadata,
      },
    });
  }

  async updateRecipient(
    id: string,
    data: Prisma.EmailCampaignRecipientUncheckedUpdateManyInput,
  ): Promise<void> {
    await this.prisma.client.emailCampaignRecipient.updateMany({ where: { id }, data });
  }

  /** The Message-ID the recipient actually received, so IMAP can match their reply to it. */
  async adoptProviderMessageId(id: string, messageId: string): Promise<void> {
    const taken = await this.prisma.client.emailCampaignRecipient.count({
      where: { messageId, id: { not: id } },
    });
    if (taken === 0) {
      await this.prisma.client.emailCampaignRecipient.updateMany({
        where: { id },
        data: { messageId },
      });
    }
  }

  async suppress(
    email: string,
    reason: 'BOUNCED' | 'COMPLAINT',
    campaignId: string,
  ): Promise<void> {
    const organizationId = this.tenantContext.requireOrganizationId();
    const existing = await this.prisma.client.emailSuppression.findFirst({ where: { email } });
    if (existing) {
      if (
        reason === 'COMPLAINT' &&
        existing.reason !== 'COMPLAINT' &&
        existing.reason !== 'UNSUBSCRIBED'
      ) {
        await this.prisma.client.emailSuppression.update({
          where: { id: existing.id },
          data: { reason, source: 'resend-webhook', campaignId },
        });
      }
      return;
    }
    await this.prisma.client.emailSuppression.createMany({
      skipDuplicates: true,
      data: [{ organizationId, email, reason, source: 'resend-webhook', campaignId }],
    });
  }

  /** A spam complaint withdraws marketing eligibility and stops anything still queued to that person. */
  async stopMarketingTo(email: string): Promise<void> {
    const now = new Date();
    await this.prisma.client.marketingConsent.updateMany({
      where: { email },
      data: { status: 'WITHDRAWN', withdrawnAt: now, source: 'resend-complaint' },
    });
    await this.prisma.client.emailCampaignRecipient.updateMany({
      where: { email, status: 'QUEUED' },
      data: { status: 'SKIPPED', skipReason: 'COMPLAINT' },
    });
  }

  async addActivity(
    leadId: string,
    description: string,
    metadata: Prisma.InputJsonValue,
  ): Promise<void> {
    await this.prisma.client.leadActivity.create({
      data: {
        organizationId: this.tenantContext.requireOrganizationId(),
        leadId,
        activityType: 'EMAIL_FAILED',
        description: description.slice(0, 1000),
        metadata,
      },
    });
  }

  async touchMailbox(mailboxId: string, at: Date): Promise<void> {
    await this.prisma.client.emailMailbox.updateMany({
      where: { id: mailboxId },
      data: { lastWebhookAt: at },
    });
  }

  /** ACCEPTED Resend messages with no final event yet, for reconciliation. */
  async awaitingOutcome(olderThan: Date, newerThan: Date, take: number) {
    return this.prisma.client.emailCampaignRecipient.findMany({
      where: {
        status: 'ACCEPTED',
        providerMessageId: { not: null },
        deliveredAt: null,
        acceptedAt: { lt: olderThan, gt: newerThan },
      },
      select: { id: true, providerMessageId: true },
      take,
    });
  }

  async mailboxForOrg() {
    return this.prisma.client.emailMailbox.findFirst({});
  }

  async organizationsUsingResend(): Promise<string[]> {
    return this.tenantContext.runAsSystem(
      'email reconciliation: find Resend mailboxes',
      async () => {
        const rows = await this.prisma.client.emailMailbox.findMany({
          where: { sendingProvider: 'RESEND', encryptedApiKey: { not: null } },
          select: { organizationId: true },
        });
        return rows.map((r) => r.organizationId);
      },
    );
  }
}
