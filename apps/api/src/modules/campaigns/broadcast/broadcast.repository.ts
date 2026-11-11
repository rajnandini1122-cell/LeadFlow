import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service';
import type { Prisma } from '../../../generated/prisma/client';
import type { BroadcastState } from './broadcast-state';

@Injectable()
export class BroadcastRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Cross-tenant: organizations with a broadcast campaign in flight. */
  async organizationsWithBroadcasts(): Promise<string[]> {
    return this.tenantContext.runAsSystem('email broadcasts: find work', async () => {
      const rows = await this.prisma.client.emailCampaign.findMany({
        where: { deliveryChannel: 'RESEND_BROADCAST', status: 'SENDING' },
        distinct: ['organizationId'],
        select: { organizationId: true },
      });
      return rows.map((r) => r.organizationId);
    });
  }

  async organizationsUsingResend(): Promise<string[]> {
    return this.tenantContext.runAsSystem('email broadcasts: resend mailboxes', async () => {
      const rows = await this.prisma.client.emailMailbox.findMany({
        where: { sendingProvider: 'RESEND', encryptedApiKey: { not: null } },
        select: { organizationId: true },
      });
      return rows.map((r) => r.organizationId);
    });
  }

  async mailbox() {
    return this.prisma.client.emailMailbox.findFirst({});
  }

  async organizationName(): Promise<string> {
    return (
      (await this.prisma.client.organization.findFirst({ select: { name: true } }))?.name ?? ''
    );
  }

  async activeBroadcasts() {
    return this.prisma.client.emailCampaign.findMany({
      where: { deliveryChannel: 'RESEND_BROADCAST', status: 'SENDING' },
      orderBy: { confirmedAt: 'asc' },
    });
  }

  async campaign(id: string) {
    return this.prisma.client.emailCampaign.findFirst({ where: { id } });
  }

  /**
   * Moves the state machine only from the state the caller read. Two workers
   * cannot both take the same step: the second finds the state already moved.
   */
  async transition(
    id: string,
    from: BroadcastState | null,
    to: BroadcastState,
    data: Prisma.EmailCampaignUncheckedUpdateManyInput = {},
  ): Promise<boolean> {
    const result = await this.prisma.client.emailCampaign.updateMany({
      where: { id, status: 'SENDING', broadcastState: from },
      data: {
        ...data,
        broadcastState: to,
        broadcastStateAt: new Date(),
        broadcastError: null,
        broadcastRetrySince: null,
        broadcastVersion: { increment: 1 },
      },
    });
    return result.count === 1;
  }

  /**
   * A step could not complete. The first failure starts the clock; the caller
   * hands the campaign to a person once it has run for RETRY_LIMIT_MS.
   */
  async recordWaiting(id: string, message: string, at: Date): Promise<Date> {
    await this.prisma.client.emailCampaign.updateMany({
      where: { id, broadcastRetrySince: null },
      data: { broadcastRetrySince: at },
    });
    await this.recordError(id, message);
    const row = await this.prisma.client.emailCampaign.findFirst({
      where: { id },
      select: { broadcastRetrySince: true },
    });
    return row?.broadcastRetrySince ?? at;
  }

  /** Pauses the campaign in NEEDS_REVIEW: only a person's decision moves it on. */
  async needsReview(id: string, reason: string): Promise<boolean> {
    const result = await this.prisma.client.emailCampaign.updateMany({
      where: { id, status: 'SENDING' },
      data: {
        status: 'PAUSED',
        pausedAt: new Date(),
        pauseReason: reason.slice(0, 300),
        broadcastError: reason.slice(0, 500),
        broadcastState: 'NEEDS_REVIEW',
        broadcastStateAt: new Date(),
        broadcastRetrySince: null,
        broadcastVersion: { increment: 1 },
      },
    });
    return result.count === 1;
  }

  /** Leaves NEEDS_REVIEW (a person decided) for the given state; SENDING again. */
  async leaveReview(
    id: string,
    to: BroadcastState,
    atVersion: number,
    data: Prisma.EmailCampaignUncheckedUpdateManyInput = {},
  ): Promise<boolean> {
    const result = await this.prisma.client.emailCampaign.updateMany({
      where: { id, status: 'PAUSED', broadcastState: 'NEEDS_REVIEW', broadcastVersion: atVersion },
      data: {
        ...data,
        status: 'SENDING',
        pausedAt: null,
        pauseReason: null,
        broadcastState: to,
        broadcastStateAt: new Date(),
        broadcastError: null,
        broadcastRetrySince: null,
        broadcastVersion: { increment: 1 },
      },
    });
    return result.count === 1;
  }

  /**
   * The campaign ends in LeadFlow (cancelled or abandoned). Recipients still
   * open become UNCERTAIN when Resend may have sent to them, else CANCELLED.
   */
  async endBroadcast(
    id: string,
    fromStatus: ('SENDING' | 'PAUSED')[],
    broadcastState: BroadcastState,
    maybeSent: boolean,
    note: string,
    atVersion?: number,
  ): Promise<number | null> {
    return this.prisma.client.$transaction(async (tx) => {
      const moved = await tx.emailCampaign.updateMany({
        where: {
          id,
          status: { in: fromStatus },
          ...(atVersion === undefined ? {} : { broadcastVersion: atVersion }),
        },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          broadcastState,
          broadcastStateAt: new Date(),
          broadcastError: note.slice(0, 500),
          broadcastRetrySince: null,
          broadcastVersion: { increment: 1 },
        },
      });
      if (moved.count !== 1) return null;
      const closed = await tx.emailCampaignRecipient.updateMany({
        where: { campaignId: id, status: { in: ['QUEUED', 'SENDING'] } },
        data: maybeSent
          ? {
              status: 'UNCERTAIN',
              lastResponse: note.slice(0, 500),
              lockedBy: null,
              lockedUntil: null,
            }
          : { status: 'CANCELLED', lockedBy: null, lockedUntil: null },
      });
      return closed.count;
    });
  }

  async recordError(id: string, message: string): Promise<void> {
    await this.prisma.client.emailCampaign.updateMany({
      where: { id },
      data: { broadcastError: message.slice(0, 500), broadcastStateAt: new Date() },
    });
  }

  /**
   * One operator at a time: moves the version on only if the page they decided
   * on is still current and the campaign is still in NEEDS_REVIEW. The caller
   * then finishes with `atVersion = expected + 1`; anyone else is refused.
   */
  async claimReview(id: string, expectedVersion: number): Promise<boolean> {
    const result = await this.prisma.client.emailCampaign.updateMany({
      where: {
        id,
        status: 'PAUSED',
        broadcastState: 'NEEDS_REVIEW',
        broadcastVersion: expectedVersion,
      },
      data: { broadcastVersion: { increment: 1 } },
    });
    return result.count === 1;
  }

  /** What Resend said the broadcast's status was, and when LeadFlow asked. */
  async recordProviderStatus(id: string, status: string, at: Date): Promise<void> {
    await this.prisma.client.emailCampaign.updateMany({
      where: { id },
      data: { broadcastProviderStatus: status.slice(0, 20), broadcastCheckedAt: at },
    });
  }

  async recordReview(row: Omit<Prisma.EmailBroadcastReviewUncheckedCreateInput, 'organizationId'>) {
    await this.prisma.client.emailBroadcastReview.create({
      data: { ...row, organizationId: this.tenantContext.requireOrganizationId() },
    });
  }

  async reviews(campaignId: string, take = 20) {
    return this.prisma.client.emailBroadcastReview.findMany({
      where: { campaignId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  async block(id: string, reason: string): Promise<void> {
    await this.prisma.client.emailCampaign.updateMany({
      where: { id, status: 'SENDING' },
      data: {
        status: 'PAUSED',
        pausedAt: new Date(),
        pauseReason: reason.slice(0, 300),
        broadcastError: reason.slice(0, 500),
        broadcastVersion: { increment: 1 },
      },
    });
  }

  async complete(id: string, at: Date): Promise<void> {
    await this.prisma.client.emailCampaign.updateMany({
      where: { id, status: 'SENDING' },
      data: { status: 'COMPLETED', completedAt: at },
    });
  }

  /** Recipients still to be decided for this broadcast (QUEUED before hand-off). */
  async pendingRecipients(campaignId: string) {
    return this.prisma.client.emailCampaignRecipient.findMany({
      where: { campaignId, status: 'QUEUED' },
      select: { id: true, email: true, displayName: true, mergeData: true, leadId: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Every address in this campaign: the most LeadFlow could ever have put in its segment. */
  async campaignEmails(campaignId: string): Promise<string[]> {
    const rows = await this.prisma.client.emailCampaignRecipient.findMany({
      where: { campaignId },
      select: { email: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => r.email);
  }

  async skip(ids: string[], reason: string): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.client.emailCampaignRecipient.updateMany({
      where: { id: { in: ids }, status: 'QUEUED' },
      data: { status: 'SKIPPED', skipReason: reason },
    });
  }

  /** Handed to Resend: outcomes now arrive by webhook. */
  async markHandedOff(campaignId: string): Promise<number> {
    const result = await this.prisma.client.emailCampaignRecipient.updateMany({
      where: { campaignId, status: 'QUEUED' },
      data: { status: 'SENDING', lockedBy: null, lockedUntil: null, attempts: { increment: 1 } },
    });
    return result.count;
  }

  async openRecipients(campaignId: string): Promise<number> {
    return this.prisma.client.emailCampaignRecipient.count({
      where: { campaignId, status: { in: ['QUEUED', 'SENDING'] } },
    });
  }

  async closeUnreported(campaignId: string): Promise<number> {
    const result = await this.prisma.client.emailCampaignRecipient.updateMany({
      where: { campaignId, status: 'SENDING' },
      data: {
        status: 'UNCERTAIN',
        lastResponse: 'Resend reported no outcome for this address within 48 hours.',
      },
    });
    return result.count;
  }

  async eligibility(emails: string[]) {
    if (emails.length === 0) return { consented: new Set<string>(), suppressed: new Set<string>() };
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

  // --- the contact ledger ----------------------------------------------------------

  async ledger(emails: string[]) {
    if (emails.length === 0)
      return new Map<string, { unsubscribed: boolean; unsubscribedAt: Date | null }>();
    const rows = await this.prisma.client.emailProviderContact.findMany({
      where: { email: { in: emails } },
      select: { email: true, unsubscribed: true, unsubscribedAt: true },
    });
    return new Map(rows.map((r) => [r.email, r]));
  }

  async recordSynced(
    mailboxId: string,
    email: string,
    providerContactId: string | null,
    at: Date,
  ): Promise<void> {
    const organizationId = this.tenantContext.requireOrganizationId();
    await this.prisma.client.emailProviderContact.upsert({
      where: { organizationId_email: { organizationId, email } },
      create: { organizationId, mailboxId, email, providerContactId, lastSyncedAt: at },
      update: { ...(providerContactId ? { providerContactId } : {}), lastSyncedAt: at },
    });
  }

  /**
   * `confirmed`: Resend has the contact as unsubscribed (it told us, or our push
   * succeeded). Only then is the row marked unsubscribed — permanently; the
   * ledger trigger refuses to clear it.
   *
   * Not confirmed: the push failed. The row stays "subscribed at Resend" with
   * the push PENDING, so the next sweep tries again and every broadcast keeps
   * failing closed until it lands. (Marking it unsubscribed here would hide it
   * from the sweep and the push would be lost.)
   */
  async recordUnsubscribed(
    mailboxId: string,
    email: string,
    at: Date,
    confirmed: boolean,
  ): Promise<void> {
    const organizationId = this.tenantContext.requireOrganizationId();
    await this.prisma.client.emailProviderContact.upsert({
      where: { organizationId_email: { organizationId, email } },
      create: confirmed
        ? {
            organizationId,
            mailboxId,
            email,
            unsubscribed: true,
            unsubscribedAt: at,
            unsubscribePushedAt: at,
          }
        : { organizationId, mailboxId, email, unsubscribePending: true },
      update: confirmed
        ? {
            unsubscribed: true,
            unsubscribedAt: at,
            unsubscribePending: false,
            unsubscribePushedAt: at,
          }
        : { unsubscribePending: true },
    });
  }

  /**
   * Addresses LeadFlow has suppressed but Resend still lists as subscribed.
   * Found by comparing the two tables — not by every suppression path having to
   * remember to queue a push — so nothing that suppresses can forget.
   */
  async outstandingUnsubscribes(): Promise<string[]> {
    const subscribedAtProvider = await this.prisma.client.emailProviderContact.findMany({
      where: { OR: [{ unsubscribed: false }, { unsubscribePending: true }] },
      select: { email: true, unsubscribePending: true },
    });
    if (subscribedAtProvider.length === 0) return [];
    const suppressed = await this.prisma.client.emailSuppression.findMany({
      where: { email: { in: subscribedAtProvider.map((c) => c.email) } },
      select: { email: true },
    });
    const set = new Set(suppressed.map((s) => s.email));
    return subscribedAtProvider
      .filter((c) => c.unsubscribePending || set.has(c.email))
      .map((c) => c.email);
  }

  async suppressUnsubscribed(email: string, campaignId: string | null): Promise<void> {
    const organizationId = this.tenantContext.requireOrganizationId();
    const existing = await this.prisma.client.emailSuppression.findFirst({ where: { email } });
    if (!existing) {
      await this.prisma.client.emailSuppression.createMany({
        skipDuplicates: true,
        data: [
          { organizationId, email, reason: 'UNSUBSCRIBED', source: 'resend-contact', campaignId },
        ],
      });
    } else if (existing.reason === 'MANUAL' || existing.reason === 'BOUNCED') {
      await this.prisma.client.emailSuppression.update({
        where: { id: existing.id },
        data: { reason: 'UNSUBSCRIBED', source: 'resend-contact' },
      });
    }
    await this.prisma.client.marketingConsent.updateMany({
      where: { email },
      data: { status: 'WITHDRAWN', withdrawnAt: new Date(), source: 'resend-unsubscribe' },
    });
    await this.prisma.client.emailCampaignRecipient.updateMany({
      where: { email, status: 'QUEUED' },
      data: { status: 'SKIPPED', skipReason: 'UNSUBSCRIBED' },
    });
  }
}
