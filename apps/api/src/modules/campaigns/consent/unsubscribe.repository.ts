import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service';

export interface UnsubscribeTarget {
  recipientId: string;
  organizationId: string;
  organizationName: string;
  campaignId: string;
  email: string;
  leadId: string | null;
  unsubscribedAt: Date | null;
}

/**
 * The one cross-tenant read in campaigns: a person clicking an unsubscribe link
 * has no session, so the recipient is found by the token's hash alone. The read
 * is a unique-index lookup returning one row; everything after it runs pinned to
 * that row's organization.
 */
@Injectable()
export class UnsubscribeRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async findByTokenHash(hash: string): Promise<UnsubscribeTarget | null> {
    const row = await this.tenantContext.runAsSystem('email unsubscribe: resolve token', () =>
      this.prisma.client.emailCampaignRecipient.findUnique({
        where: { unsubscribeTokenHash: hash },
        select: {
          id: true,
          organizationId: true,
          campaignId: true,
          email: true,
          leadId: true,
          unsubscribedAt: true,
          organization: { select: { name: true } },
        },
      }),
    );
    if (!row) return null;
    return {
      recipientId: row.id,
      organizationId: row.organizationId,
      organizationName: row.organization.name,
      campaignId: row.campaignId,
      email: row.email,
      leadId: row.leadId,
      unsubscribedAt: row.unsubscribedAt,
    };
  }

  /** Inside the recipient's organization (runForOrganization). */
  async markRecipientUnsubscribed(recipientId: string, at: Date): Promise<void> {
    await this.prisma.client.emailCampaignRecipient.updateMany({
      where: { id: recipientId, unsubscribedAt: null },
      data: { unsubscribedAt: at },
    });
    // Anything of this person's still waiting in ANY campaign of this
    // organization is cancelled now, not at send time.
    const recipient = await this.prisma.client.emailCampaignRecipient.findFirst({
      where: { id: recipientId },
      select: { email: true },
    });
    if (recipient) {
      await this.prisma.client.emailCampaignRecipient.updateMany({
        where: { email: recipient.email, status: 'QUEUED' },
        data: { status: 'SKIPPED', skipReason: 'UNSUBSCRIBED' },
      });
    }
  }
}
