import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../../../common/config/config.module';
import { TenantContextService } from '../../../../common/tenancy/tenant-context.service';
import { IngestionService } from '../../ingestion.service';
import { WhatsAppIntegrationRepository } from './whatsapp-integration.repository';
import { OmnichannelRepository } from '../../omnichannel.repository';
import { nextDeliveryStatus, parseProviderStatus } from '../../message-status';
import {
  parseWebhook,
  type WhatsAppInboundMessage,
  type WhatsAppStatusEvent,
} from './whatsapp-normalizer';
import { verifySubscription, verifyWebhookSignature } from '../meta-webhook-signature';

/**
 * The gate between Meta and the platform.
 *
 * Its whole job is to establish, in order, that a request is genuine, which
 * tenant it belongs to, and whether that tenant wants it — and then to hand the
 * result to the ingestion service that has existed since Phase B. There is no
 * lead logic here, no contact matching and no ownership: putting any of it in a
 * webhook handler would be a second pipeline, and the two would drift.
 *
 * Processing is synchronous. The application has no queue wired up — BullMQ is
 * deferred — and introducing one for this would be new infrastructure to
 * operate for a handler that does a handful of indexed queries. Every step is
 * idempotent, so Meta's retries are safe; if throughput ever makes this the
 * wrong trade, the same normalized events can be enqueued instead without
 * touching anything downstream.
 */

export type WebhookOutcome =
  | { status: 'PROCESSED'; ingested: number; skipped: number }
  | { status: 'REJECTED'; reason: string };

@Injectable()
export class WhatsAppWebhookService {
  private readonly logger = new Logger(WhatsAppWebhookService.name);

  constructor(
    private readonly config: AppConfig,
    private readonly repository: WhatsAppIntegrationRepository,
    private readonly ingestion: IngestionService,
    private readonly tenantContext: TenantContextService,
    private readonly conversations: OmnichannelRepository,
  ) {}

  /** Meta's subscription handshake. Returns the challenge, or null to refuse. */
  verifySubscription(params: {
    mode?: string | undefined;
    token?: string | undefined;
    challenge?: string | undefined;
  }): string | null {
    return verifySubscription(params, this.config.get('WHATSAPP_VERIFY_TOKEN'));
  }

  /**
   * Handle one webhook delivery.
   *
   * @param rawBody the exact bytes received, for the signature check.
   */
  async handle(
    rawBody: Buffer | undefined,
    signatureHeader: string | undefined,
    body: unknown,
  ): Promise<WebhookOutcome> {
    /*
     * STEP 1 — authenticity, before anything in the payload is read.
     *
     * Until this passes, the phone number id and every other field are
     * attacker-controlled strings. Resolving a tenant from an unverified body
     * is how a forged request writes into someone else's CRM.
     */
    const signature = verifyWebhookSignature(
      rawBody,
      signatureHeader,
      this.config.get('WHATSAPP_APP_SECRET'),
    );

    if (!signature.valid) {
      // Category, never the header or the secret.
      this.logger.warn(`Rejected WhatsApp webhook: signature ${signature.reason}.`);
      return { status: 'REJECTED', reason: signature.reason };
    }

    // STEP 2 — read the payload defensively.
    const parsed = parseWebhook(body);

    if (parsed.malformed > 0) {
      this.logger.warn(`WhatsApp webhook contained ${parsed.malformed} unreadable event(s).`);
    }

    let ingested = 0;
    let skipped = 0;

    /*
     * Each message independently. One unknown number, one disabled tenant or
     * one failure must not discard the others in the same batch — Meta would
     * redeliver the whole thing, and the messages that DID work would be
     * reprocessed instead of the one that did not.
     */
    for (const message of parsed.messages) {
      try {
        const handled = await this.ingestOne(message);
        if (handled) ingested += 1;
        else skipped += 1;
      } catch (error) {
        skipped += 1;
        // Never the message body: a customer's enquiry is not log material.
        this.logger.error(
          `Failed to ingest WhatsApp message ${message.externalMessageId}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }

    /*
     * Delivery receipts, after the messages.
     *
     * These only ever UPDATE an outbound message we already sent. They never
     * create a message, never create a conversation, and never touch a lead —
     * a receipt is not correspondence.
     */
    for (const status of parsed.statuses) {
      try {
        await this.applyStatus(status);
      } catch (error) {
        this.logger.error(
          `Failed to apply WhatsApp status for ${status.providerMessageId}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }

    return { status: 'PROCESSED', ingested, skipped: skipped + parsed.ignored };
  }

  /**
   * Apply one delivery receipt.
   *
   * Resolved to a tenant exactly as an inbound message is — by phone number id,
   * through the global unique index — and then applied only to an OUTGOING
   * message inside that tenant. A status event for a provider id we do not
   * recognise is ignored rather than acted on.
   */
  private async applyStatus(event: WhatsAppStatusEvent): Promise<void> {
    const incoming = parseProviderStatus(event.status);
    // `accepted` and `deleted` mean neither progress nor failure.
    if (!incoming) return;

    const integration = await this.repository.findByPhoneNumberId(event.phoneNumberId);
    if (!integration) return;

    // Disabled tenants still get their receipts applied: the message was
    // genuinely sent while the channel was on, and leaving it stuck at SENT
    // would misreport what happened to the customer.
    await this.tenantContext.runForOrganization(
      integration.organizationId,
      `whatsapp: apply delivery status ${event.status}`,
      async () => {
        const message = await this.conversations.findOutboundByProviderId(
          event.providerMessageId,
        );
        if (!message) return;

        const next = nextDeliveryStatus(message.deliveryStatus, incoming);
        // Duplicate, or a late event that would move the status backwards.
        if (!next) return;

        await this.conversations.updateDeliveryStatus({
          id: message.id,
          status: next,
          ...(next === 'FAILED'
            ? {
                failureReason:
                  message.failureReason ??
                  `WhatsApp could not deliver this message${
                    event.errorCode ? ` (code ${event.errorCode})` : ''
                  }.`,
              }
            : {}),
        });
      },
    );
  }

  /**
   * One message: resolve the tenant, check it wants this, then ingest.
   *
   * Returns false when the message was deliberately not ingested — an unknown
   * number, a disabled integration, one that was never validated. All of those
   * are acknowledged rather than errored, because Meta retries a failure
   * indefinitely and there is nothing to retry.
   */
  private async ingestOne(message: WhatsAppInboundMessage): Promise<boolean> {
    /*
     * STEP 3 — which tenant?
     *
     * By phone number id alone, through a globally unique index. That
     * uniqueness is what makes this lookup total: one number cannot belong to
     * two organizations, so there is never a choice to make. Nothing in the
     * payload names an organization, and nothing in the payload would be
     * trusted if it did.
     */
    const integration = await this.repository.findByPhoneNumberId(message.phoneNumberId);

    if (!integration) {
      // Deliberately not an error. A webhook for a number nobody has connected
      // is a misconfiguration at Meta's end, and no tenant is a safer answer
      // than a guessed one.
      this.logger.warn(
        `WhatsApp webhook for unrecognised phone number id ${message.phoneNumberId}; ignored.`,
      );
      return false;
    }

    // STEP 4 — does this tenant actually want it?
    if (!integration.enabled) {
      this.logger.log(
        `Integration ${integration.id} is disabled; message ignored (organization ${integration.organizationId}).`,
      );
      return false;
    }

    if (integration.status !== 'CONNECTED') {
      // CONNECTING has never been validated; DISCONNECTED and ERROR are not
      // operational. A webhook arriving is not evidence that setup succeeded,
      // so none of them start ingesting on their own.
      this.logger.log(
        `Integration ${integration.id} is ${integration.status}; message ignored.`,
      );
      return false;
    }

    /*
     * STEP 5 — hand over to the pipeline that already exists.
     *
     * organizationId comes from the integration we just resolved, never from
     * the payload. Everything after this line is Phase B: identity resolution,
     * lead matching, owner preservation, the review queue.
     */
    await this.ingestion.ingest({
      organizationId: integration.organizationId,
      integrationId: integration.id,
      channel: 'WHATSAPP',
      externalMessageId: message.externalMessageId,
      // WhatsApp has no thread id — a conversation with one customer on one
      // business number IS the thread, so their wa_id identifies it.
      externalConversationId: `${message.phoneNumberId}:${message.externalUserId}`,
      externalUserId: message.externalUserId,
      ...(message.senderName ? { senderName: message.senderName } : {}),
      senderPhone: message.senderPhone,
      content: message.content ?? undefined,
      messageType: message.messageType,
      ...(message.attachments.length > 0 ? { attachments: message.attachments } : {}),
      timestamp: message.timestamp,
    });

    // A verified message on a working integration is real evidence of health —
    // unlike its mere arrival, which proved nothing before the checks above.
    await this.tenantContext.runForOrganization(
      integration.organizationId,
      'whatsapp: record integration activity',
      () => this.repository.clearError(integration.id),
    );

    return true;
  }
}
