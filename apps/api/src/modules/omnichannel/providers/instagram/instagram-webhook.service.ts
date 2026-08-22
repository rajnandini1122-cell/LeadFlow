import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../../../common/config/config.module';
import { TenantContextService } from '../../../../common/tenancy/tenant-context.service';
import { IngestionService } from '../../ingestion.service';
import { verifySubscription, verifyWebhookSignature } from '../meta-webhook-signature';
import { InstagramIntegrationRepository } from './instagram-integration.repository';
import { parseInstagramWebhook, type InstagramInboundMessage } from './instagram-normalizer';

/**
 * The gate between Instagram and the platform.
 *
 * Structurally the same job as the WhatsApp webhook service — prove the request
 * is genuine, establish which tenant it belongs to, check that tenant wants it,
 * then hand it to the ingestion service that has existed since Phase B. What is
 * NOT here is any lead logic, contact matching or ownership: this is a provider
 * adapter, and the moment one of those appears in it, there are two pipelines.
 *
 * Synchronous, like its sibling. No queue exists in this deployment and a
 * handful of indexed queries does not justify introducing one; every step is
 * idempotent, so Meta's retries are safe.
 */

export type InstagramWebhookOutcome =
  | { status: 'PROCESSED'; ingested: number; skipped: number }
  | { status: 'REJECTED'; reason: string };

@Injectable()
export class InstagramWebhookService {
  private readonly logger = new Logger(InstagramWebhookService.name);

  constructor(
    private readonly config: AppConfig,
    private readonly repository: InstagramIntegrationRepository,
    private readonly ingestion: IngestionService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Meta's subscription handshake. Returns the challenge, or null to refuse. */
  verifySubscription(params: {
    mode?: string | undefined;
    token?: string | undefined;
    challenge?: string | undefined;
  }): string | null {
    return verifySubscription(params, this.config.get('INSTAGRAM_VERIFY_TOKEN'));
  }

  async handle(
    rawBody: Buffer | undefined,
    signatureHeader: string | undefined,
    body: unknown,
  ): Promise<InstagramWebhookOutcome> {
    /*
     * STEP 1 — authenticity, before a single field is read.
     *
     * Until this passes, the account id and everything else in the payload are
     * attacker-controlled strings. Resolving a tenant from an unverified body
     * is how a forged request writes into somebody else's CRM.
     */
    const signature = verifyWebhookSignature(
      rawBody,
      signatureHeader,
      this.config.get('INSTAGRAM_APP_SECRET'),
    );

    if (!signature.valid) {
      this.logger.warn(`Rejected Instagram webhook: signature ${signature.reason}.`);
      return { status: 'REJECTED', reason: signature.reason };
    }

    const parsed = parseInstagramWebhook(body);

    if (parsed.malformed > 0) {
      this.logger.warn(`Instagram webhook contained ${parsed.malformed} unreadable event(s).`);
    }

    let ingested = 0;
    let skipped = 0;

    // Each message independently: one unknown account or one failure must not
    // discard the rest, since Meta redelivers the whole batch.
    for (const message of parsed.messages) {
      try {
        const handled = await this.ingestOne(message);
        if (handled) ingested += 1;
        else skipped += 1;
      } catch (error) {
        skipped += 1;
        // Never the message body: a customer's DM is not log material.
        this.logger.error(
          `Failed to ingest Instagram message ${message.externalMessageId}: ${
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
   * there is nothing here that a retry would fix.
   */
  private async ingestOne(message: InstagramInboundMessage): Promise<boolean> {
    /*
     * STEP 2 — which tenant?
     *
     * By Instagram account id alone, through a globally unique index. Nothing
     * in the payload names an organization, and nothing in it would be trusted
     * if it did.
     */
    const integration = await this.repository.findByAccountId(message.instagramAccountId);

    if (!integration) {
      this.logger.warn(
        `Instagram webhook for unrecognised account ${message.instagramAccountId}; ignored.`,
      );
      return false;
    }

    // STEP 3 — does this tenant actually want it?
    if (!integration.enabled) {
      this.logger.log(
        `Instagram integration ${integration.id} is disabled; message ignored ` +
          `(organization ${integration.organizationId}).`,
      );
      return false;
    }

    if (integration.status !== 'CONNECTED') {
      // A webhook arriving is not evidence that setup succeeded.
      this.logger.log(
        `Instagram integration ${integration.id} is ${integration.status}; message ignored.`,
      );
      return false;
    }

    /*
     * STEP 4 — the existing pipeline.
     *
     * organizationId comes from the integration just resolved, never from the
     * payload. Everything past this line is Phase B, unchanged and unaware
     * that Instagram exists.
     *
     * NOTE what is deliberately absent: `senderPhone`. Instagram discloses no
     * phone number, so identity resolution falls through to its channel-identity
     * key and, failing that, returns UNRESOLVED. That is the correct outcome —
     * guessing that an Instagram handle is the same person as a WhatsApp number
     * would merge two customers' histories, and there is no undo for that.
     */
    await this.ingestion.ingest({
      organizationId: integration.organizationId,
      integrationId: integration.id,
      channel: 'INSTAGRAM',
      externalMessageId: message.externalMessageId,
      // Instagram has no thread id: one customer talking to one business
      // account IS the thread, so their scoped id identifies it.
      externalConversationId: `${message.instagramAccountId}:${message.externalUserId}`,
      externalUserId: message.externalUserId,
      content: message.content ?? undefined,
      messageType: message.messageType,
      timestamp: message.timestamp,
    });

    // A verified message on a working integration is real evidence of health,
    // unlike its mere arrival, which proved nothing before the checks above.
    await this.tenantContext.runForOrganization(
      integration.organizationId,
      'instagram: record integration activity',
      () => this.repository.clearError(integration.id),
    );

    return true;
  }
}
