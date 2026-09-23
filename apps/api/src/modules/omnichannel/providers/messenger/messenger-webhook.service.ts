import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../../../common/config/config.module';
import { TenantContextService } from '../../../../common/tenancy/tenant-context.service';
import { IngestionService } from '../../ingestion.service';
import { verifySubscription, verifyWebhookSignature } from '../meta-webhook-signature';
import { MessengerIntegrationRepository } from './messenger-integration.repository';
import { parseMessengerWebhook, type MessengerInboundMessage } from './messenger-normalizer';
import type { MessengerChannelConfig } from './messenger-channels';

/**
 * The gate between Meta's Messenger channels and the platform.
 *
 * Prove the request is genuine, establish which tenant it belongs to, check
 * that tenant wants it, then hand it to the ingestion service that has existed
 * since Phase B. What is NOT here is any lead logic, contact matching or
 * ownership: this is a provider adapter, and the moment one of those appears
 * in it there are two pipelines.
 *
 * One service for both Instagram and Facebook, driven by a channel descriptor.
 * The alternative was two copies of this file differing in four constants —
 * and two copies of a security check do not stay identical.
 *
 * Synchronous, like the WhatsApp adapter. No queue exists here and a handful
 * of indexed queries does not justify introducing one; every step is
 * idempotent, so Meta's retries are safe.
 */

export type MessengerWebhookOutcome =
  | { status: 'PROCESSED'; ingested: number; skipped: number }
  | { status: 'REJECTED'; reason: string };

@Injectable()
export class MessengerWebhookService {
  private readonly logger = new Logger(MessengerWebhookService.name);

  constructor(
    private readonly config: AppConfig,
    private readonly repository: MessengerIntegrationRepository,
    private readonly ingestion: IngestionService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Meta's subscription handshake. Returns the challenge, or null to refuse. */
  verifySubscription(
    channel: MessengerChannelConfig,
    params: {
      mode?: string | undefined;
      token?: string | undefined;
      challenge?: string | undefined;
    },
  ): string | null {
    return verifySubscription(params, this.config.get(channel.verifyTokenKey));
  }

  async handle(
    channel: MessengerChannelConfig,
    rawBody: Buffer | undefined,
    signatureHeader: string | undefined,
    body: unknown,
  ): Promise<MessengerWebhookOutcome> {
    /*
     * STEP 1 — authenticity, before a single field is read.
     *
     * Until this passes, the account id and everything else in the payload are
     * attacker-controlled strings. Resolving a tenant from an unverified body
     * is how a forged request writes into somebody else's CRM.
     *
     * Each channel has its own app secret: the two products can live in
     * different Meta apps, and sharing one by accident would mean a leak of
     * either compromised both.
     */
    const signature = verifyWebhookSignature(
      rawBody,
      signatureHeader,
      this.config.get(channel.appSecretKey),
    );

    if (!signature.valid) {
      this.logger.warn(`Rejected ${channel.label} webhook: signature ${signature.reason}.`);
      return { status: 'REJECTED', reason: signature.reason };
    }

    const parsed = parseMessengerWebhook(body, channel.webhookObject);

    if (parsed.malformed > 0) {
      this.logger.warn(
        `${channel.label} webhook contained ${parsed.malformed} unreadable event(s).`,
      );
    }

    let ingested = 0;
    let skipped = 0;

    // Each message independently: one unknown account or one failure must not
    // discard the rest, since Meta redelivers the whole batch.
    for (const message of parsed.messages) {
      try {
        const handled = await this.ingestOne(channel, message);
        if (handled) ingested += 1;
        else skipped += 1;
      } catch (error) {
        skipped += 1;
        // Never the message body: a customer's message is not log material.
        this.logger.error(
          `Failed to ingest ${channel.label} message ${message.externalMessageId}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }

    return { status: 'PROCESSED', ingested, skipped: skipped + parsed.ignored };
  }

  /**
   * One message: resolve the tenant, check it wants this, then ingest.
   *
   * Returns false for anything deliberately not ingested. All of those are
   * acknowledged rather than errored — Meta retries a failure for hours, and
   * there is nothing here a retry would fix.
   */
  private async ingestOne(
    channel: MessengerChannelConfig,
    message: MessengerInboundMessage,
  ): Promise<boolean> {
    /*
     * STEP 2 — which tenant?
     *
     * By provider account id alone, through a globally unique index. Nothing
     * in the payload names an organization, and nothing in it would be trusted
     * if it did.
     */
    const integration = await this.repository.findByAccountId(channel.channel, message.accountId);

    if (!integration) {
      this.logger.warn(
        `${channel.label} webhook for unrecognised account ${message.accountId}; ignored.`,
      );
      return false;
    }

    // STEP 3 — does this tenant actually want it?
    if (!integration.enabled) {
      this.logger.log(
        `${channel.label} integration ${integration.id} is disabled; message ignored ` +
          `(organization ${integration.organizationId}).`,
      );
      return false;
    }

    if (integration.status !== 'CONNECTED') {
      // A webhook arriving is not evidence that setup succeeded.
      this.logger.log(
        `${channel.label} integration ${integration.id} is ${integration.status}; message ignored.`,
      );
      return false;
    }

    /*
     * STEP 4 — the existing pipeline.
     *
     * organizationId comes from the integration just resolved, never from the
     * payload. Everything past this line is Phase B, unchanged and unaware
     * that Messenger exists.
     *
     * NOTE what is deliberately absent: `senderPhone`. Neither channel
     * discloses a phone number, so identity resolution falls through to its
     * channel-identity key and, failing that, returns UNRESOLVED. That is the
     * correct outcome — guessing that a Facebook sender is the same person as
     * a WhatsApp number would merge two customers' histories, and there is no
     * undo for that.
     */
    await this.ingestion.ingest({
      organizationId: integration.organizationId,
      integrationId: integration.id,
      channel: channel.channel,
      externalMessageId: message.externalMessageId,
      /*
       * Neither channel has a thread id: one customer talking to one business
       * account IS the thread.
       *
       * The account id is part of the key so that a customer who messages two
       * different Pages of the same organization gets two conversations, which
       * is what actually happened — merging them would put one Page's
       * correspondence into another's.
       */
      externalConversationId: `${message.accountId}:${message.externalUserId}`,
      externalUserId: message.externalUserId,
      content: message.content ?? undefined,
      messageType: message.messageType,
      ...(message.attachments.length > 0 ? { attachments: message.attachments } : {}),
      timestamp: message.timestamp,
    });

    // A verified message on a working integration is real evidence of health,
    // unlike its mere arrival, which proved nothing before the checks above.
    await this.tenantContext.runForOrganization(
      integration.organizationId,
      `${channel.channel.toLowerCase()}: record integration activity`,
      () => this.repository.clearError(integration.id),
    );

    return true;
  }
}
