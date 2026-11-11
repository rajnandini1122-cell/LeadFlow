import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { AppConfig } from '../../../common/config/config.module';
import { ERROR_CODES } from '@leadflow/api-types';
import { AppException } from '../../../common/errors/app.exception';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service';
import { MailboxService } from '../mailbox/mailbox.service';
import { fetchResendEmailStatus } from '../mailbox/resend-transport';
import { verifySvixSignature } from '../mailbox/svix-signature';
import { ProviderEventsRepository } from './provider-events.repository';
import { BroadcastRepository } from '../broadcast/broadcast.repository';
import { BroadcastService } from '../broadcast/broadcast.service';

export interface ResendEvent {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    broadcast_id?: string;
    message_id?: string;
    /** contact.* events */
    email?: string;
    unsubscribed?: boolean;
    to?: string[];
    subject?: string;
    bounce?: { type?: string; subType?: string; message?: string };
    failed?: { reason?: string };
  };
}

const NOT_FOUND = 'Not found.';

/**
 * What Resend tells us after it accepted a campaign email.
 *
 *   email.sent        the Message-ID the recipient will see (so IMAP can match replies)
 *   email.delivered   handed to the recipient's mail server — still not proof of inbox placement
 *   email.bounced     Permanent: FAILED, suppressed as BOUNCED, recorded on the lead
 *   email.complained  marked as spam: suppressed, eligibility withdrawn, queued mail stopped
 *   email.failed      Resend could not send it: FAILED, recorded on the lead
 *   email.suppressed  Resend refused it (earlier bounce/complaint): FAILED, suppressed
 *
 * Every event is verified (Svix HMAC with the mailbox's own secret, 5-minute
 * window) and applied once (unique per mailbox + event id).
 */
@Injectable()
export class ProviderEventsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ProviderEventsService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repository: ProviderEventsRepository,
    private readonly tenantContext: TenantContextService,
    private readonly mailbox: MailboxService,
    private readonly config: AppConfig,
    private readonly broadcasts: BroadcastRepository,
    private readonly broadcastService: BroadcastService,
  ) {}

  /** Reconciliation runs where the dispatcher runs, every 10 minutes. */
  onApplicationBootstrap(): void {
    if (!this.config.get('EMAIL_DISPATCH_ENABLED')) return;
    this.timer = setInterval(
      () =>
        void Promise.all([this.reconcile(), this.broadcastService.reconcile()]).catch((e) =>
          this.logger.error(`reconcile failed: ${(e as Error).message}`),
        ),
      10 * 60_000,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async handleResend(
    mailboxId: string,
    headers: { id?: string; timestamp?: string; signature?: string },
    rawBody: Buffer | undefined,
    event: ResendEvent,
  ): Promise<{ applied: boolean }> {
    const mailbox = await this.repository.mailboxById(mailboxId);
    // An unknown mailbox and a mailbox without a webhook secret look the same from outside.
    if (
      !mailbox ||
      mailbox.sendingProvider !== 'RESEND' ||
      !mailbox.encryptedWebhookSecret ||
      !rawBody
    ) {
      throw AppException.notFound(ERROR_CODES.NOT_FOUND, NOT_FOUND);
    }
    // During a secret rotation, the previous secret is accepted for 24 hours.
    const secrets = [
      this.mailbox.resendWebhookSecret(mailbox)!,
      this.mailbox.resendPreviousWebhookSecret(mailbox),
    ].filter((s): s is string => Boolean(s));
    const results = secrets.map((secret) =>
      verifySvixSignature({
        secret,
        id: headers.id,
        timestamp: headers.timestamp,
        signature: headers.signature,
        rawBody,
      }),
    );
    const verified = results.find((r) => r.ok) ?? results[0]!;
    if (!verified.ok) {
      this.logger.warn(`Rejected a Resend webhook for mailbox ${mailboxId}: ${verified.reason}`);
      throw AppException.unauthorized('Invalid signature.');
    }

    return this.tenantContext.runForOrganization(
      mailbox.organizationId,
      'resend webhook',
      async () => {
        const now = new Date();
        await this.repository.touchMailbox(mailbox.id, now);
        const type = String(event.type ?? 'unknown').slice(0, 40);

        // Contact events: only an unsubscribe changes anything, and it is permanent.
        if (type.startsWith('contact.')) {
          const claimedContact = await this.repository.claimEvent({
            mailboxId: mailbox.id,
            eventId: headers.id!,
            type,
            providerMessageId: null,
            recipientId: null,
          });
          const email =
            typeof event.data?.email === 'string' ? event.data.email.trim().toLowerCase() : null;
          if (!claimedContact || !email) return { applied: false };
          if (type === 'contact.updated' && event.data?.unsubscribed === true) {
            await this.broadcasts.suppressUnsubscribed(email, null);
            await this.broadcasts.recordUnsubscribed(mailbox.id, email, now, true);
            return { applied: true };
          }
          // contact.created / contact.deleted / resubscribed: never turns a LeadFlow unsubscribe back on.
          return { applied: false };
        }

        // Email events. Resend's email_id is its own id; the RFC Message-ID header
        // arrives separately (data.message_id) and is the one replies refer to.
        const providerMessageId = event.data?.email_id ?? null;
        let recipient = providerMessageId
          ? await this.repository.recipientByProviderId(providerMessageId)
          : null;
        if (!recipient && event.data?.broadcast_id && providerMessageId) {
          // A broadcast email: Resend chose the id, so find the row by this
          // organization's broadcast and the address, then remember the id.
          const to = (event.data.to ?? [])[0]?.trim().toLowerCase();
          recipient = to
            ? await this.repository.recipientByBroadcast(
                event.data.broadcast_id,
                to,
                providerMessageId,
              )
            : null;
        }
        const claimed = await this.repository.claimEvent({
          mailboxId: mailbox.id,
          eventId: headers.id!,
          type,
          providerMessageId,
          recipientId: recipient?.id ?? null,
        });
        if (!claimed || !recipient) return { applied: false };
        await this.apply(event, recipient, now);
        return { applied: true };
      },
    );
  }

  private async apply(
    event: ResendEvent,
    recipient: NonNullable<Awaited<ReturnType<ProviderEventsRepository['recipientByProviderId']>>>,
    now: Date,
  ): Promise<void> {
    const history = (description: string, extra: Record<string, unknown> = {}) =>
      recipient.leadId
        ? this.repository.addActivity(recipient.leadId, description, {
            campaignId: recipient.campaignId,
            campaignName: recipient.campaign.name,
            recipientId: recipient.id,
            email: recipient.email,
            provider: 'RESEND',
            event: event.type ?? null,
            ...extra,
          })
        : Promise.resolve();

    switch (event.type) {
      case 'email.sent': {
        const messageId = event.data?.message_id;
        if (
          messageId &&
          /^<[^<>\s]{1,250}>$/.test(messageId) &&
          messageId !== recipient.messageId
        ) {
          await this.repository.adoptProviderMessageId(recipient.id, messageId);
        }
        // A broadcast recipient becomes ACCEPTED here: until now only the broadcast was.
        if (recipient.status === 'SENDING') {
          await this.repository.updateRecipient(recipient.id, {
            status: 'ACCEPTED',
            acceptedAt: now,
          });
          await this.repository.addSentActivity(
            recipient.leadId,
            `Campaign email "${recipient.campaign.subject}" to ${recipient.email} was accepted by Resend (not proof of inbox delivery).`,
            {
              campaignId: recipient.campaignId,
              campaignName: recipient.campaign.name,
              recipientId: recipient.id,
              email: recipient.email,
              provider: 'RESEND',
              providerEmailId: event.data?.email_id ?? null,
              messageId: messageId ?? null,
            },
          );
        }
        return;
      }
      case 'email.delivered':
        await this.repository.updateRecipient(recipient.id, { deliveredAt: now });
        return;
      case 'email.bounced': {
        const bounce = event.data?.bounce ?? {};
        const detail = [bounce.type, bounce.subType, bounce.message]
          .filter(Boolean)
          .join(' · ')
          .slice(0, 400);
        if (bounce.type && bounce.type !== 'Permanent') {
          await this.repository.updateRecipient(recipient.id, {
            lastResponse: `Temporary bounce: ${detail}`,
          });
          return;
        }
        await this.repository.updateRecipient(recipient.id, {
          status: 'FAILED',
          failedAt: now,
          lastResponse: `Bounced: ${detail}`.slice(0, 500),
        });
        await this.repository.suppress(recipient.email, 'BOUNCED', recipient.campaignId);
        await history(
          `Campaign email "${recipient.campaign.subject}" to ${recipient.email} bounced: ${detail || 'permanent bounce'}`,
          { serverResponse: detail },
        );
        return;
      }
      case 'email.complained':
        await this.repository.updateRecipient(recipient.id, { complainedAt: now });
        await this.repository.suppress(recipient.email, 'COMPLAINT', recipient.campaignId);
        await this.repository.stopMarketingTo(recipient.email);
        await history(
          `${recipient.email} marked the campaign email "${recipient.campaign.subject}" as spam. They will receive no more campaign email.`,
        );
        return;
      case 'email.failed': {
        const reason = String(event.data?.failed?.reason ?? 'Resend could not send it').slice(
          0,
          300,
        );
        await this.repository.updateRecipient(recipient.id, {
          status: 'FAILED',
          failedAt: now,
          lastResponse: `Failed: ${reason}`,
        });
        await history(
          `Campaign email "${recipient.campaign.subject}" to ${recipient.email} was not sent: ${reason}`,
          {
            serverResponse: reason,
          },
        );
        return;
      }
      case 'email.suppressed':
        await this.repository.updateRecipient(recipient.id, {
          status: 'FAILED',
          failedAt: now,
          lastResponse: 'Resend suppressed this address (earlier bounce or complaint).',
        });
        await this.repository.suppress(recipient.email, 'BOUNCED', recipient.campaignId);
        await history(
          `Campaign email "${recipient.campaign.subject}" to ${recipient.email} was not sent: the address is on Resend's suppression list.`,
        );
        return;
      default:
        // delivery_delayed, opened, clicked, …: recorded as received, nothing to change.
        return;
    }
  }

  /**
   * For messages accepted more than an hour ago with no final event — a missed
   * or not-yet-configured webhook — ask Resend. A sending-only key may not be
   * allowed to read; then this does nothing and the webhook remains the source.
   */
  async reconcile(now = new Date()): Promise<{ checked: number; updated: number }> {
    let checked = 0;
    let updated = 0;
    for (const organizationId of await this.repository.organizationsUsingResend()) {
      await this.tenantContext.runForOrganization(
        organizationId,
        'resend reconciliation',
        async () => {
          const mailbox = await this.repository.mailboxForOrg();
          if (!mailbox?.encryptedApiKey) return;
          const apiKey = this.mailbox.resendApiKey(mailbox);
          const pending = await this.repository.awaitingOutcome(
            new Date(now.getTime() - 3_600_000),
            new Date(now.getTime() - 7 * 86_400_000),
            50,
          );
          for (const row of pending) {
            const status = await fetchResendEmailStatus(
              apiKey,
              row.providerMessageId!,
              this.mailbox.deps.fetchImpl,
            );
            checked++;
            if (status.status === 401 || status.status === 403) return; // the key may only send
            if (status.status !== 200 || !status.lastEvent) continue;
            const recipient = await this.repository.recipientByProviderId(row.providerMessageId!);
            if (!recipient) continue;
            const type = `email.${status.lastEvent}`;
            // Applied once, exactly as if the webhook had arrived.
            const claimed = await this.repository.claimEvent({
              mailboxId: mailbox.id,
              eventId: `reconcile:${row.providerMessageId}:${status.lastEvent}`,
              type,
              providerMessageId: row.providerMessageId,
              recipientId: recipient.id,
            });
            if (claimed) {
              await this.apply(
                { type, data: { email_id: row.providerMessageId! } },
                recipient,
                now,
              );
              updated++;
            }
          }
        },
      );
    }
    return { checked, updated };
  }
}
