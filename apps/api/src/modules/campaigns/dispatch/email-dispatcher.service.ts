import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { AppConfig } from '../../../common/config/config.module';
import { parseEncryptionKey } from '../../../common/crypto/secret-box';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service';
import type { EmailCampaign } from '../../../generated/prisma/client';
import { BillingService } from '../../billing/billing.service';
import { deriveUnsubscribeToken, unsubscribeKey } from '../consent/unsubscribe-token';
import { MailboxService } from '../mailbox/mailbox.service';
import { composeMessage, sendOnce } from '../mailbox/mail-connection';
import { sendViaResend, type ResendOutcome } from '../mailbox/resend-transport';
import { SendingAllowlist } from '../content/sending-allowlist';
import { normalizeEmailAddress, type MergeValues } from '../content/email-content';
import { buildCampaignMessage, type MessageAttachment } from '../campaigns/mail-message';
import { DispatchRepository, type ClaimedRecipient } from './dispatch.repository';
import { BroadcastService } from '../broadcast/broadcast.service';

/** At most this many messages per mailbox per tick. */
const BATCH = 10;
/**
 * How long a claim lasts. A message can take up to ~60 s (15 s connect + 15 s
 * greeting + 30 s socket), so a full batch stays well inside it. A row still
 * SENDING after this is recovered as UNCERTAIN.
 */
const LEASE_MS = 15 * 60_000;
const TICK_MS = 5_000;
/** Retries after a temporary failure: 1, 5, 15, 60 minutes. Then permanent. */
const BACKOFF_MINUTES = [1, 5, 15, 60];
const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;

export interface TickReport {
  promoted: number;
  recovered: number;
  accepted: number;
  retried: number;
  failed: number;
  uncertain: number;
  skipped: number;
  paused: number;
  completed: number;
}

/**
 * Delivers queued campaign mail, one message per recipient.
 *
 * Runs only where EMAIL_DISPATCH_ENABLED=true, and sends to customers only when
 * EMAIL_CAMPAIGNS_SENDING_ENABLED=true; with either off, queued rows wait.
 *
 * SMTP is not transactional with PostgreSQL, so this is AT MOST ONCE, never
 * "exactly once": a row is marked SENDING (and an attempt recorded) before the
 * conversation starts; only an explicit server answer or a failure before the
 * body moves it anywhere a retry can follow. Anything ambiguous — the process
 * died, the connection dropped after the body — ends UNCERTAIN and is not sent
 * again by LeadFlow.
 */
@Injectable()
export class EmailDispatcher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(EmailDispatcher.name);
  private readonly worker = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly repository: DispatchRepository,
    private readonly tenantContext: TenantContextService,
    private readonly mailbox: MailboxService,
    private readonly billing: BillingService,
    private readonly config: AppConfig,
    private readonly broadcasts: BroadcastService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('EMAIL_DISPATCH_ENABLED')) {
      this.logger.log('Email dispatcher disabled in this process (EMAIL_DISPATCH_ENABLED=false)');
      return;
    }
    this.logger.log(`Email dispatcher running as ${this.worker}`);
    this.timer = setInterval(
      () =>
        void this.tick().catch((e) => this.logger.error(`tick failed: ${(e as Error).message}`)),
      TICK_MS,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass. Public so tests drive it deterministically. Never overlaps itself. */
  async tick(now = new Date()): Promise<TickReport> {
    const report: TickReport = {
      promoted: 0,
      recovered: 0,
      accepted: 0,
      retried: 0,
      failed: 0,
      uncertain: 0,
      skipped: 0,
      paused: 0,
      completed: 0,
    };
    if (this.running) return report;
    this.running = true;
    try {
      const recovered = await this.repository.recoverAbandoned(now);
      report.recovered = recovered.length;
      for (const row of recovered.filter((r) => r.leadId)) {
        await this.tenantContext.runForOrganization(
          row.organizationId,
          'email dispatch: record recovery',
          async () => {
            const [campaign] = await this.repository.campaigns([row.campaignId]);
            await this.repository.recordEmailActivity({
              leadId: row.leadId!,
              type: 'EMAIL_FAILED',
              description: `Campaign email "${campaign?.subject ?? ''}" to ${row.email}: sending was interrupted, so delivery is unknown. It was not sent again.`,
              metadata: {
                campaignId: row.campaignId,
                recipientId: row.id,
                email: row.email,
                outcome: 'UNCERTAIN',
                messageId: row.messageId,
              },
            });
          },
        );
      }
      report.promoted = await this.repository.promoteScheduled(now);
      if (this.config.get('EMAIL_CAMPAIGNS_SENDING_ENABLED')) {
        for (const organizationId of await this.repository.organizationsWithWork(now)) {
          await this.tenantContext.runForOrganization(organizationId, 'email dispatch', () =>
            this.deliverFor(organizationId, now, report),
          );
        }
      }
      // Promotional broadcasts advance one persisted step per tick (off unless enabled).
      await this.broadcasts.tick(now);
      for (const organizationId of await this.repository.organizationsSending()) {
        report.completed += await this.tenantContext.runForOrganization(
          organizationId,
          'email dispatch: complete',
          () => this.repository.completeFinished(now),
        );
      }
      return report;
    } finally {
      this.running = false;
    }
  }

  private async deliverFor(organizationId: string, now: Date, report: TickReport): Promise<void> {
    const entitlement = await this.billing.entitlement(organizationId, now);
    if (!entitlement.grantsAccess) {
      report.paused += await this.repository.pauseSending(
        'Paused: this organization’s LeadFlow subscription is not active.',
        now,
      );
      return;
    }
    const mailbox = await this.repository.mailbox();
    if (!mailbox || !mailbox.enabled) {
      report.paused += await this.repository.pauseSending(
        'Paused: the email account is switched off in Email settings.',
        now,
      );
      return;
    }

    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    if (!(await this.repository.acquireMailboxLease(mailbox.id, this.worker, leaseUntil, now)))
      return;
    try {
      const hourLeft =
        mailbox.hourlyLimit -
        (await this.repository.attemptsSince(new Date(now.getTime() - 3_600_000)));
      const dayLeft =
        mailbox.dailyLimit -
        (await this.repository.attemptsSince(new Date(now.getTime() - 86_400_000)));
      const allowed = Math.min(BATCH, hourLeft, dayLeft);
      if (allowed <= 0) return;

      const provider = mailbox.sendingProvider;
      const claimed = await this.repository.claim(allowed, this.worker, leaseUntil, provider);
      if (claimed.length === 0) return;

      const campaigns = new Map(
        (await this.repository.campaigns([...new Set(claimed.map((r) => r.campaignId))])).map(
          (c) => [c.id, c],
        ),
      );
      const assetIds = [...new Set([...campaigns.values()].flatMap((c) => c.assetIds))];
      const assets = new Map((await this.repository.assets(assetIds)).map((a) => [a.id, a]));
      const facts = await this.repository.eligibilityFacts(claimed.map((r) => r.email));
      const organizationName = await this.repository.organizationName();
      const key = unsubscribeKey(parseEncryptionKey(this.config.get('CREDENTIAL_ENCRYPTION_KEY')));
      // Exactly one credential is opened: the one this mailbox sends with.
      const account = provider === 'SMTP' ? this.mailbox.account(mailbox) : null;
      const apiKey = provider === 'RESEND' ? this.mailbox.resendApiKey(mailbox) : null;

      const allowlist = new SendingAllowlist(this.config);
      for (let index = 0; index < claimed.length; index++) {
        const recipient = claimed[index]!;
        const campaign = campaigns.get(recipient.campaignId)!;
        const attempt = { id: recipient.id, attempt: recipient.attempts };

        // Checked again now, not trusted from confirmation time: an unsubscribe
        // or a withdrawn consent in the meantime wins. The recipient allowlist
        // is checked here too, so nothing unapproved reaches SMTP or Resend.
        const email = normalizeEmailAddress(recipient.email);
        const skip = !email
          ? 'INVALID'
          : !allowlist.allows(organizationId, recipient.email)
            ? 'NOT_ALLOWLISTED'
            : facts.suppressed.has(recipient.email)
              ? 'SUPPRESSED'
              : campaign.purpose === 'PROMOTIONAL' && !facts.consented.has(recipient.email)
                ? 'NO_CONSENT'
                : null;
        if (skip) {
          await this.repository.finish(
            attempt,
            this.worker,
            {
              status: 'SKIPPED',
              outcome: 'SKIPPED',
              smtpCode: null,
              response: null,
              skipReason: skip,
              undoAttempt: true,
            },
            now,
          );
          report.skipped++;
          continue;
        }

        const { options } = buildCampaignMessage({
          campaign,
          organizationName,
          mailboxAddress: mailbox.emailAddress,
          fromAddress: mailbox.fromAddress,
          recipient: {
            email: recipient.email,
            displayName: recipient.displayName,
            messageId: recipient.messageId,
            unsubscribeToken: deriveUnsubscribeToken(key, recipient.id).token,
          },
          merge: recipient.mergeData as MergeValues,
          attachments: campaign.assetIds.flatMap((id): MessageAttachment[] => {
            const asset = assets.get(id);
            return asset
              ? [{ fileName: asset.fileName, mimeType: asset.mimeType, data: asset.data }]
              : [];
          }),
          webBaseUrl: this.config.get('WEB_BASE_URL'),
        });

        const outcome: ResendOutcome =
          provider === 'RESEND'
            ? await sendViaResend(
                apiKey!,
                {
                  from: `${displayFrom(organizationName)} <${mailbox.fromAddress ?? mailbox.emailAddress}>`,
                  to: recipient.email,
                  replyTo: mailbox.emailAddress,
                  subject: String(options.subject),
                  html: String(options.html),
                  text: String(options.text),
                  headers: (options.headers ?? {}) as Record<string, string>,
                  attachments: campaign.assetIds.flatMap((id) => {
                    const asset = assets.get(id);
                    return asset
                      ? [
                          {
                            filename: asset.fileName,
                            content: Buffer.from(asset.data).toString('base64'),
                            contentType: asset.mimeType,
                          },
                        ]
                      : [];
                  }),
                  tags: [
                    { name: 'campaign_id', value: campaign.id },
                    { name: 'recipient_id', value: recipient.id },
                  ],
                  // The recipient row: the same message, however many times it is attempted.
                  idempotencyKey: `leadflow-recipient-${recipient.id}`,
                },
                this.mailbox.deps.fetchImpl,
              )
            : await sendOnce(
                account!,
                { from: mailbox.fromAddress ?? mailbox.emailAddress, to: [recipient.email] },
                await composeMessage(options),
                this.mailbox.deps,
              );

        if (outcome.kind === 'MAILBOX') {
          // The account itself is refused: put this and every remaining claim
          // back, stop the organization's campaigns, tell the administrator.
          for (const rest of claimed.slice(index)) {
            await this.repository.finish(
              { id: rest.id, attempt: rest.attempts },
              this.worker,
              {
                status: 'QUEUED',
                outcome: 'MAILBOX_ERROR',
                smtpCode: outcome.code,
                response: outcome.response,
                undoAttempt: true,
              },
              now,
            );
          }
          await this.repository.recordMailboxError(
            mailbox.id,
            provider === 'RESEND'
              ? 'Sending stopped: Resend refused the API key or the sending domain. Check them and test Resend.'
              : 'Sending stopped: the SMTP server refused the account. Check the password and test the connection.',
            now,
          );
          report.paused += await this.repository.pauseSending(
            provider === 'RESEND'
              ? 'Paused: Resend refused the API key or sending domain. Fix it in Email settings, then resume.'
              : 'Paused: the SMTP server refused the email account. Fix it in Email settings, then resume.',
            now,
          );
          return;
        }

        await this.record(recipient, campaign, attempt, outcome, now, report);
      }
    } finally {
      await this.repository.releaseMailboxLease(mailbox.id, this.worker);
    }
  }

  private async record(
    recipient: ClaimedRecipient,
    campaign: EmailCampaign,
    attempt: { id: string; attempt: number },
    outcome: Exclude<ResendOutcome, { kind: 'MAILBOX' }>,
    now: Date,
    report: TickReport,
  ): Promise<void> {
    const history = (type: 'EMAIL_SENT' | 'EMAIL_FAILED', description: string) =>
      recipient.leadId
        ? this.repository.recordEmailActivity({
            leadId: recipient.leadId,
            type,
            description,
            metadata: {
              campaignId: campaign.id,
              campaignName: campaign.name,
              recipientId: recipient.id,
              email: recipient.email,
              subject: campaign.subject,
              outcome: outcome.kind,
              smtpCode: outcome.code,
              serverResponse: outcome.response,
              messageId: recipient.messageId,
            },
          })
        : Promise.resolve();

    switch (outcome.kind) {
      case 'ACCEPTED': {
        if (
          await this.repository.finish(
            attempt,
            this.worker,
            {
              status: 'ACCEPTED',
              outcome: 'ACCEPTED',
              smtpCode: outcome.code,
              response: outcome.response,
              ...(outcome.providerMessageId
                ? { providerMessageId: outcome.providerMessageId }
                : {}),
            },
            now,
          )
        ) {
          await history(
            'EMAIL_SENT',
            `Campaign email "${campaign.subject}" to ${recipient.email} was accepted by the mail server (not proof of inbox delivery).`,
          );
          report.accepted++;
        }
        return;
      }
      case 'RETRY': {
        if (recipient.attempts >= MAX_ATTEMPTS) {
          await this.repository.finish(
            attempt,
            this.worker,
            {
              status: 'FAILED',
              outcome: 'RETRIES_EXHAUSTED',
              smtpCode: outcome.code,
              response: outcome.response,
            },
            now,
          );
          await history(
            'EMAIL_FAILED',
            `Campaign email "${campaign.subject}" to ${recipient.email} was not delivered after ${recipient.attempts} attempts: ${outcome.response}`,
          );
          report.failed++;
          return;
        }
        const delay = BACKOFF_MINUTES[recipient.attempts - 1] ?? BACKOFF_MINUTES.at(-1)!;
        await this.repository.finish(
          attempt,
          this.worker,
          {
            status: 'QUEUED',
            outcome: 'TEMPORARY_FAILURE',
            smtpCode: outcome.code,
            response: outcome.response,
            nextAttemptAt: new Date(now.getTime() + delay * 60_000),
          },
          now,
        );
        report.retried++;
        return;
      }
      case 'PERMANENT': {
        await this.repository.finish(
          attempt,
          this.worker,
          {
            status: 'FAILED',
            outcome: 'PERMANENT_FAILURE',
            smtpCode: outcome.code,
            response: outcome.response,
          },
          now,
        );
        if (outcome.recipientUnknown)
          await this.repository.suppressBounce(recipient.email, campaign.id);
        await history(
          'EMAIL_FAILED',
          `Campaign email "${campaign.subject}" to ${recipient.email} was rejected by the mail server: ${outcome.response}`,
        );
        report.failed++;
        return;
      }
      case 'UNCERTAIN': {
        await this.repository.finish(
          attempt,
          this.worker,
          {
            status: 'UNCERTAIN',
            outcome: 'UNCERTAIN',
            smtpCode: outcome.code,
            response: outcome.response,
          },
          now,
        );
        await history(
          'EMAIL_FAILED',
          `Campaign email "${campaign.subject}" to ${recipient.email}: the connection was lost while sending, so delivery is unknown. It was not sent again.`,
        );
        report.uncertain++;
        return;
      }
    }
  }
}

/** A display name Resend's "Name <address>" format cannot be broken by. */
function displayFrom(name: string): string {
  return (
    name
      .replace(/[\r\n"<>,;:@\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'LeadFlow'
  );
}
