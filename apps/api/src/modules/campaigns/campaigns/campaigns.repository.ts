import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { PrismaTransaction } from '../../../common/prisma/transaction';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service';
import type {
  EmailCampaignStatus,
  EmailRecipientStatus,
  Prisma,
} from '../../../generated/prisma/client';

export interface NewRecipient {
  /** Chosen before insert: the unsubscribe token is derived from it. */
  id: string;
  email: string;
  leadId: string | null;
  contactId: string | null;
  displayName: string | null;
  mergeData: Prisma.InputJsonValue;
  messageId: string;
  unsubscribeTokenHash: string;
}

@Injectable()
export class CampaignsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private db(tx?: PrismaTransaction) {
    return tx ?? this.prisma.client;
  }

  async organizationName(): Promise<string> {
    const org = await this.prisma.client.organization.findFirst({ select: { name: true } });
    return org?.name ?? '';
  }

  async userEmail(userId: string): Promise<{ email: string; name: string } | null> {
    // Users are global identities; reading one by id is not a tenant read.
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { email: true, fullName: true },
    });
    return user ? { email: user.email, name: user.fullName } : null;
  }

  async list(take: number) {
    return this.prisma.client.emailCampaign.findMany({ orderBy: { createdAt: 'desc' }, take });
  }

  async find(id: string, tx?: PrismaTransaction) {
    return this.db(tx).emailCampaign.findFirst({ where: { id } });
  }

  async create(data: Omit<Prisma.EmailCampaignUncheckedCreateInput, 'organizationId'>) {
    return this.prisma.client.emailCampaign.create({
      data: { ...data, organizationId: this.tenantContext.requireOrganizationId() },
    });
  }

  async update(id: string, data: Prisma.EmailCampaignUncheckedUpdateInput, tx?: PrismaTransaction) {
    return this.db(tx).emailCampaign.update({ where: { id }, data });
  }

  /** Conditional transition: only from one of `from`. Returns false if another request got there first. */
  async transition(
    id: string,
    from: EmailCampaignStatus | { in: EmailCampaignStatus[] },
    data: Prisma.EmailCampaignUncheckedUpdateInput,
    tx?: PrismaTransaction,
  ): Promise<boolean> {
    const result = await this.db(tx).emailCampaign.updateMany({
      where: { id, status: from },
      data,
    });
    return result.count === 1;
  }

  async inTransaction<T>(run: (tx: PrismaTransaction) => Promise<T>): Promise<T> {
    return this.prisma.client.$transaction(async (tx) => run(tx as unknown as PrismaTransaction), {
      timeout: 60_000,
    });
  }

  async insertRecipients(
    campaignId: string,
    recipients: NewRecipient[],
    tx: PrismaTransaction,
  ): Promise<number> {
    const organizationId = this.tenantContext.requireOrganizationId();
    let inserted = 0;
    for (let i = 0; i < recipients.length; i += 500) {
      const result = await tx.emailCampaignRecipient.createMany({
        skipDuplicates: true,
        data: recipients
          .slice(i, i + 500)
          .map((r) => ({ ...r, organizationId, campaignId, status: 'QUEUED' as const })),
      });
      inserted += result.count;
    }
    return inserted;
  }

  async statusCounts(
    campaignIds: string[],
  ): Promise<Map<string, Map<EmailRecipientStatus, number>>> {
    if (campaignIds.length === 0) return new Map();
    const rows = await this.prisma.client.emailCampaignRecipient.groupBy({
      by: ['campaignId', 'status'],
      where: { campaignId: { in: campaignIds } },
      _count: { _all: true },
    });
    const out = new Map<string, Map<EmailRecipientStatus, number>>();
    for (const row of rows) {
      const perCampaign = out.get(row.campaignId) ?? new Map<EmailRecipientStatus, number>();
      perCampaign.set(row.status, row._count._all);
      out.set(row.campaignId, perCampaign);
    }
    return out;
  }

  /** Replies and unsubscribes per campaign, for the list. */
  async engagementByCampaign(
    campaignIds: string[],
  ): Promise<Map<string, { replies: number; unsubscribes: number }>> {
    const out = new Map<string, { replies: number; unsubscribes: number }>();
    if (campaignIds.length === 0) return out;
    const [replies, unsubscribes] = await Promise.all([
      this.prisma.client.emailCampaignRecipient.groupBy({
        by: ['campaignId'],
        where: { campaignId: { in: campaignIds }, repliedAt: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.client.emailCampaignRecipient.groupBy({
        by: ['campaignId'],
        where: { campaignId: { in: campaignIds }, unsubscribedAt: { not: null } },
        _count: { _all: true },
      }),
    ]);
    for (const id of campaignIds) out.set(id, { replies: 0, unsubscribes: 0 });
    for (const row of replies) out.get(row.campaignId)!.replies = row._count._all;
    for (const row of unsubscribes) out.get(row.campaignId)!.unsubscribes = row._count._all;
    return out;
  }

  async engagementCounts(campaignId: string) {
    const [attempted, retrying, replies, unsubscribes] = await Promise.all([
      this.prisma.client.emailCampaignRecipient.count({
        where: { campaignId, attempts: { gt: 0 } },
      }),
      this.prisma.client.emailCampaignRecipient.count({
        where: { campaignId, status: 'QUEUED', attempts: { gt: 0 } },
      }),
      this.prisma.client.emailCampaignRecipient.count({
        where: { campaignId, repliedAt: { not: null } },
      }),
      this.prisma.client.emailCampaignRecipient.count({
        where: { campaignId, unsubscribedAt: { not: null } },
      }),
    ]);
    return { attempted, retrying, replies, unsubscribes };
  }

  async recipients(campaignId: string, status: EmailRecipientStatus | undefined, take: number) {
    return this.prisma.client.emailCampaignRecipient.findMany({
      where: { campaignId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'asc' },
      take,
      select: {
        id: true,
        email: true,
        displayName: true,
        leadId: true,
        status: true,
        attempts: true,
        lastSmtpCode: true,
        lastResponse: true,
        skipReason: true,
        acceptedAt: true,
        failedAt: true,
        repliedAt: true,
        unsubscribedAt: true,
        mergeData: true,
      },
    });
  }

  async firstRecipient(campaignId: string) {
    return this.prisma.client.emailCampaignRecipient.findFirst({
      where: { campaignId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async replies(campaignId: string, take: number) {
    return this.prisma.client.emailInboundMessage.findMany({
      where: { kind: 'REPLY', recipient: { campaignId } },
      orderBy: { receivedAt: 'desc' },
      take,
      select: {
        id: true,
        fromAddress: true,
        subject: true,
        snippet: true,
        receivedAt: true,
        leadId: true,
        lead: { select: { firstName: true, lastName: true, companyName: true } },
        recipient: { select: { email: true } },
      },
    });
  }

  async cancelQueued(campaignId: string, tx?: PrismaTransaction): Promise<number> {
    const result = await this.db(tx).emailCampaignRecipient.updateMany({
      where: { campaignId, status: 'QUEUED' },
      data: { status: 'CANCELLED', lockedBy: null, lockedUntil: null },
    });
    return result.count;
  }

  /** Test sends in the last 24 hours, from the audit log, for the per-organization cap. */
  async testSendsToday(): Promise<number> {
    return this.prisma.client.auditLog.count({
      where: {
        organizationId: this.tenantContext.requireOrganizationId(),
        action: 'email.campaign.test_sent',
        createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) },
      },
    });
  }
}
