import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service';
import type { EmailRecipientStatus, Prisma } from '../../../generated/prisma/client';

export interface RecoveredRecipient {
  id: string;
  organizationId: string;
  leadId: string | null;
  email: string;
  campaignId: string;
  messageId: string;
}

export interface ClaimedRecipient {
  id: string;
  campaignId: string;
  leadId: string | null;
  email: string;
  displayName: string | null;
  mergeData: Record<string, string | null>;
  messageId: string;
  attempts: number;
}

/**
 * The delivery queue's storage. The recipient rows ARE the queue.
 *
 * Cross-tenant work (finding which organizations have something due, recovering
 * abandoned leases) runs under runAsSystem with a stated reason. Everything that
 * touches one organization's data runs inside runForOrganization, and the one
 * raw statement — the claim — names its organization explicitly, because raw
 * SQL is not covered by the tenant-scope extension.
 */
@Injectable()
export class DispatchRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  // --- cross-tenant -----------------------------------------------------------

  async promoteScheduled(now: Date): Promise<number> {
    return this.tenantContext.runAsSystem('email dispatch: start scheduled campaigns', async () => {
      const result = await this.prisma.client.emailCampaign.updateMany({
        where: { status: 'SCHEDULED', scheduledAt: { lte: now } },
        data: { status: 'SENDING', startedAt: now },
      });
      return result.count;
    });
  }

  /**
   * A row still SENDING after its lease expired belongs to a worker that died
   * mid-send. Whether the server accepted the message is unknowable, so it is
   * UNCERTAIN — and never sent again automatically.
   */
  async recoverAbandoned(now: Date): Promise<RecoveredRecipient[]> {
    return this.tenantContext.runAsSystem('email dispatch: recover abandoned sends', async () => {
      const stuck = await this.prisma.client.emailCampaignRecipient.findMany({
        where: { status: 'SENDING', lockedUntil: { lt: now } },
        select: {
          id: true,
          organizationId: true,
          leadId: true,
          email: true,
          campaignId: true,
          messageId: true,
        },
        take: 500,
      });
      if (stuck.length === 0) return [];
      const ids = stuck.map((row) => row.id);
      await this.prisma.client.emailCampaignRecipient.updateMany({
        where: { id: { in: ids }, status: 'SENDING' },
        data: {
          status: 'UNCERTAIN',
          lockedBy: null,
          lockedUntil: null,
          lastResponse:
            'The sending process stopped during this attempt; delivery is unknown and it was not retried.',
        },
      });
      await this.prisma.client.emailDeliveryAttempt.updateMany({
        where: { recipientId: { in: ids }, finishedAt: null },
        data: { finishedAt: now, outcome: 'UNCERTAIN', response: 'worker lease expired' },
      });
      return stuck;
    });
  }

  async organizationsWithWork(now: Date): Promise<string[]> {
    return this.tenantContext.runAsSystem('email dispatch: find due work', async () => {
      const rows = await this.prisma.client.emailCampaignRecipient.findMany({
        where: { status: 'QUEUED', nextAttemptAt: { lte: now }, campaign: { status: 'SENDING' } },
        distinct: ['organizationId'],
        select: { organizationId: true },
        take: 200,
      });
      return rows.map((row) => row.organizationId);
    });
  }

  async organizationsSending(): Promise<string[]> {
    return this.tenantContext.runAsSystem('email dispatch: campaigns in progress', async () => {
      const rows = await this.prisma.client.emailCampaign.findMany({
        where: { status: 'SENDING' },
        distinct: ['organizationId'],
        select: { organizationId: true },
        take: 500,
      });
      return rows.map((row) => row.organizationId);
    });
  }

  // --- inside one organization ------------------------------------------------

  async mailbox() {
    return this.prisma.client.emailMailbox.findFirst({});
  }

  async organizationName(): Promise<string> {
    return (
      (await this.prisma.client.organization.findFirst({ select: { name: true } }))?.name ?? ''
    );
  }

  async acquireMailboxLease(
    mailboxId: string,
    worker: string,
    until: Date,
    now: Date,
  ): Promise<boolean> {
    const result = await this.prisma.client.emailMailbox.updateMany({
      where: {
        id: mailboxId,
        OR: [{ dispatchLockedUntil: null }, { dispatchLockedUntil: { lt: now } }],
      },
      data: { dispatchLockedBy: worker, dispatchLockedUntil: until },
    });
    return result.count === 1;
  }

  async releaseMailboxLease(mailboxId: string, worker: string): Promise<void> {
    await this.prisma.client.emailMailbox.updateMany({
      where: { id: mailboxId, dispatchLockedBy: worker },
      data: { dispatchLockedBy: null, dispatchLockedUntil: null },
    });
  }

  async recordMailboxError(mailboxId: string, message: string, at: Date): Promise<void> {
    await this.prisma.client.emailMailbox.updateMany({
      where: { id: mailboxId },
      data: { lastSmtpError: message.slice(0, 300), lastSmtpCheckAt: at },
    });
  }

  /** Attempts started since `since` — what the provider has been asked to take. */
  async attemptsSince(since: Date): Promise<number> {
    return this.prisma.client.emailDeliveryAttempt.count({ where: { startedAt: { gte: since } } });
  }

  /**
   * Atomically takes up to `limit` due rows of this organization: QUEUED →
   * SENDING with a lease, attempt counter incremented, in ONE statement. Rows
   * another worker holds are skipped, never waited on.
   */
  async claim(limit: number, worker: string, leaseUntil: Date): Promise<ClaimedRecipient[]> {
    const organizationId = this.tenantContext.requireOrganizationId();
    // eslint-disable-next-line no-restricted-syntax -- Prisma has no SKIP LOCKED; organizationId is bound explicitly and covered by test/tenant-isolation.e2e-spec.ts
    const rows = await this.prisma.client.$queryRaw<
      {
        id: string;
        campaign_id: string;
        lead_id: string | null;
        email: string;
        display_name: string | null;
        merge_data: Record<string, string | null>;
        message_id: string;
        attempts: number;
      }[]
    >`
      UPDATE email_campaign_recipients AS r
      SET status = 'SENDING', locked_by = ${worker}, locked_until = ${leaseUntil},
          attempts = r.attempts + 1, updated_at = now()
      WHERE r.id IN (
        SELECT q.id
        FROM email_campaign_recipients AS q
        JOIN email_campaigns AS c ON c.id = q.campaign_id AND c.organization_id = q.organization_id
        WHERE q.organization_id = ${organizationId}::uuid
          AND q.status = 'QUEUED'
          AND q.next_attempt_at <= now()
          AND c.status = 'SENDING'
        ORDER BY q.next_attempt_at, q.id
        LIMIT ${limit}
        FOR UPDATE OF q SKIP LOCKED
      )
      AND r.organization_id = ${organizationId}::uuid
      RETURNING r.id, r.campaign_id, r.lead_id, r.email, r.display_name, r.merge_data, r.message_id, r.attempts`;
    const claimed = rows.map((row) => ({
      id: row.id,
      campaignId: row.campaign_id,
      leadId: row.lead_id,
      email: row.email,
      displayName: row.display_name,
      mergeData: row.merge_data ?? {},
      messageId: row.message_id,
      attempts: Number(row.attempts),
    }));
    if (claimed.length > 0) {
      await this.prisma.client.emailDeliveryAttempt.createMany({
        data: claimed.map((r) => ({
          organizationId,
          recipientId: r.id,
          campaignId: r.campaignId,
          attempt: r.attempts,
          worker,
        })),
      });
    }
    return claimed;
  }

  async campaigns(ids: string[]) {
    return this.prisma.client.emailCampaign.findMany({ where: { id: { in: ids } } });
  }

  async assets(ids: string[]) {
    if (ids.length === 0) return [];
    return this.prisma.client.emailAsset.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, fileName: true, mimeType: true, data: true },
    });
  }

  async eligibilityFacts(emails: string[]) {
    const [consents, suppressions] = await Promise.all([
      this.prisma.client.marketingConsent.findMany({
        where: { email: { in: emails }, status: 'GRANTED' },
        select: { email: true },
      }),
      this.prisma.client.emailSuppression.findMany({
        where: { email: { in: emails } },
        select: { email: true },
      }),
    ]);
    return {
      consented: new Set(consents.map((c) => c.email)),
      suppressed: new Set(suppressions.map((s) => s.email)),
    };
  }

  /**
   * Records how one attempt ended. The recipient update is conditional on the
   * lease still being ours, so a recovered (UNCERTAIN) row is never overwritten.
   */
  async finish(
    recipient: { id: string; attempt: number },
    worker: string,
    result: {
      status: EmailRecipientStatus;
      outcome: string;
      smtpCode: number | null;
      response: string | null;
      nextAttemptAt?: Date;
      skipReason?: string;
      undoAttempt?: boolean;
    },
    now: Date,
  ): Promise<boolean> {
    const data: Prisma.EmailCampaignRecipientUncheckedUpdateManyInput = {
      status: result.status,
      lockedBy: null,
      lockedUntil: null,
      lastSmtpCode: result.smtpCode,
      lastResponse: result.response?.slice(0, 500) ?? null,
    };
    if (result.status === 'ACCEPTED') data.acceptedAt = now;
    if (result.status === 'FAILED') data.failedAt = now;
    if (result.nextAttemptAt) data.nextAttemptAt = result.nextAttemptAt;
    if (result.skipReason) data.skipReason = result.skipReason;
    if (result.undoAttempt) data.attempts = { decrement: 1 };
    const updated = await this.prisma.client.emailCampaignRecipient.updateMany({
      where: { id: recipient.id, status: 'SENDING', lockedBy: worker },
      data,
    });
    await this.prisma.client.emailDeliveryAttempt.updateMany({
      where: { recipientId: recipient.id, attempt: recipient.attempt, finishedAt: null },
      data: {
        finishedAt: now,
        outcome: result.outcome,
        smtpCode: result.smtpCode,
        response: result.response?.slice(0, 500) ?? null,
      },
    });
    return updated.count === 1;
  }

  async suppressBounce(email: string, campaignId: string): Promise<void> {
    await this.prisma.client.emailSuppression.createMany({
      skipDuplicates: true,
      data: [
        {
          organizationId: this.tenantContext.requireOrganizationId(),
          email,
          reason: 'BOUNCED',
          source: 'smtp-rejection',
          campaignId,
        },
      ],
    });
  }

  /**
   * The lead's history: every campaign email to it, with what the mail server
   * answered. Sent and not-sent are different activity types, so a failure is
   * never shown as an email that went out.
   */
  async recordEmailActivity(input: {
    leadId: string;
    type: 'EMAIL_SENT' | 'EMAIL_FAILED';
    description: string;
    metadata: Prisma.InputJsonValue;
  }): Promise<void> {
    await this.prisma.client.leadActivity.create({
      data: {
        organizationId: this.tenantContext.requireOrganizationId(),
        leadId: input.leadId,
        activityType: input.type,
        description: input.description.slice(0, 1000),
        metadata: input.metadata,
      },
    });
  }

  async pauseSending(reason: string, now: Date): Promise<number> {
    const result = await this.prisma.client.emailCampaign.updateMany({
      where: { status: 'SENDING' },
      data: { status: 'PAUSED', pausedAt: now, pauseReason: reason.slice(0, 300) },
    });
    return result.count;
  }

  /** SENDING campaigns with nothing left queued or in flight are complete. */
  async completeFinished(now: Date): Promise<number> {
    const sending = await this.prisma.client.emailCampaign.findMany({
      where: { status: 'SENDING' },
      select: { id: true },
    });
    let completed = 0;
    for (const { id } of sending) {
      const open = await this.prisma.client.emailCampaignRecipient.count({
        where: { campaignId: id, status: { in: ['QUEUED', 'SENDING'] } },
      });
      if (open === 0) {
        const result = await this.prisma.client.emailCampaign.updateMany({
          where: { id, status: 'SENDING' },
          data: { status: 'COMPLETED', completedAt: now },
        });
        completed += result.count;
      }
    }
    return completed;
  }
}
