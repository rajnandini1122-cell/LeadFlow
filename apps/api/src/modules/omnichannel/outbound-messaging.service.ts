import { Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES } from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import { AuditRepository } from '../../common/audit/audit.repository';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { OmnichannelRepository } from './omnichannel.repository';
import { conversationScope } from './conversation-visibility';
import { evaluateSendCapability, MAX_TEXT_LENGTH } from './send-capability';
import { WhatsAppOutboundService } from './providers/whatsapp/whatsapp-outbound.service';

/**
 * Replying to a customer from the inbox.
 *
 * The ordering below is the whole design, and it is deliberate:
 *
 *   authorize → check capability → CLAIM the row → call the provider → record
 *
 * The row is written before Meta is called, not after. That costs a little
 * tidiness — a PENDING row exists for a message that may never be accepted —
 * and buys the property that matters: if the process dies between the provider
 * accepting a message and us recording it, the retry finds the claim and stops.
 * The customer gets one message. The alternative ordering loses the record of a
 * message the customer has already read, and the salesperson sends it twice.
 *
 * Nothing here touches lead ownership or conversation ownership. Replying to a
 * customer is not a claim on their deal, and a rep helping out while a
 * colleague is away must not silently inherit the pipeline.
 */
@Injectable()
export class OutboundMessagingService {
  private readonly logger = new Logger(OutboundMessagingService.name);

  constructor(
    private readonly repository: OmnichannelRepository,
    private readonly whatsapp: WhatsAppOutboundService,
    private readonly audit: AuditRepository,
  ) {}

  async send(
    conversationId: string,
    input: { content: string; idempotencyKey: string },
    principal: TenantPrincipal,
  ) {
    const body = input.content.trim();

    if (!body) {
      throw new AppException(
        ERROR_CODES.VALIDATION_ERROR,
        'A message cannot be empty.',
        400,
      );
    }

    if (body.length > MAX_TEXT_LENGTH) {
      throw new AppException(
        ERROR_CODES.VALIDATION_ERROR,
        `WhatsApp messages are limited to ${MAX_TEXT_LENGTH} characters.`,
        400,
      );
    }

    /*
     * Idempotency, checked before anything else that costs.
     *
     * A retried request — a double click, a browser retry, a client timeout —
     * finds the attempt it already made and gets that back. It never reaches
     * the provider a second time.
     */
    const existing = await this.repository.findMessageByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      /*
       * Whatever state the original reached, including UNCONFIRMED.
       *
       * A message finalised by the recovery sweep may or may not have reached
       * the customer, so replaying its request must return the attempt rather
       * than make a second one. Resending is a decision for a person who can
       * see the conversation, not for a retried HTTP request.
       */
      this.logger.debug(`Idempotent replay of send ${input.idempotencyKey}; returning the original.`);
      return toMessageView(existing);
    }

    // --- authorize ----------------------------------------------------------
    const conversation = await this.repository.findConversationForSend(conversationId);
    if (!conversation) throw this.notFound();

    if (!(await this.mayReply(conversation, principal))) throw this.notFound();

    // --- capability ---------------------------------------------------------
    const integration = await this.repository.findIntegrationForChannel(conversation.channel);
    const lastInboundAt = await this.repository.lastInboundAt(conversationId);

    const capability = evaluateSendCapability({
      channel: conversation.channel,
      integration: integration ? { status: integration.status, enabled: integration.enabled } : null,
      lastInboundAt,
      mayReply: true,
      });

    if (!capability.canSend) {
      // 409 rather than 403: the caller is permitted, the conversation is not
      // currently in a state that allows it. The reason is safe to show.
      throw new AppException(
        ERROR_CODES.CONFLICT,
        capability.sendDisabledReason ?? 'This conversation cannot be replied to right now.',
        409,
      );
    }

    const recipient = await this.repository.recipientFor(conversationId);
    if (!recipient) {
      throw new AppException(
        ERROR_CODES.CONFLICT,
        'This conversation has no WhatsApp number to reply to.',
        409,
      );
    }

    // --- claim --------------------------------------------------------------
    // Written first, on purpose. See the class comment.
    const claimed = await this.repository.claimOutboundMessage({
      conversationId,
      channel: conversation.channel,
      content: body,
      idempotencyKey: input.idempotencyKey,
      sentById: principal.userId,
    });

    if (!claimed) {
      // Two concurrent requests with the same key. The other one won the
      // unique index; return whatever it produced rather than sending again.
      const raced = await this.repository.findMessageByIdempotencyKey(input.idempotencyKey);
      if (raced) return toMessageView(raced);

      throw new AppException(
        ERROR_CODES.CONFLICT,
        'That message is already being sent.',
        409,
      );
    }

    // --- send ---------------------------------------------------------------
    const result = await this.whatsapp.sendText({
      phoneNumberId: integration!.providerAccountId,
      encryptedAccessToken: integration!.encryptedAccessToken,
      // Meta wants digits with no plus.
      recipient: recipient.replace(/^\+/, ''),
      body,
    });

    if (!result.ok) {
      await this.repository.markMessageFailed(claimed.id, result.message);

      /*
       * An uncertain failure keeps the row rather than deleting it.
       *
       * If Meta may have delivered the message, the record of the attempt is
       * the only thing that tells the salesperson to check before resending.
       * Removing it would invite exactly the duplicate it was written to
       * prevent.
       */
      throw new AppException(
        ERROR_CODES.CONFLICT,
        result.message,
        result.uncertain ? 502 : 409,
      );
    }

    const sent = await this.repository.markMessageSent(claimed.id, result.providerMessageId);

    await this.audit.record({
      action: 'omnichannel.message_sent',
      entityType: 'conversation',
      entityId: conversationId,
      after: {
        messageId: claimed.id,
        channel: conversation.channel,
        // Length, not content: a customer's correspondence is not audit fodder.
        length: body.length,
      },
    });

    return toMessageView(sent ?? claimed);
  }

  /**
   * Whether this caller may act on this conversation.
   *
   * The same policy the inbox uses, applied to one row — deliberately not a
   * second rule. Someone who cannot see a conversation must not be able to
   * reply to it by knowing its id.
   */
  private async mayReply(
    conversation: { ownerId: string | null; leadId: string | null },
    principal: TenantPrincipal,
  ): Promise<boolean> {
    const scope = conversationScope(principal, await this.repository.sharedUnassignedQueue());
    if (scope.kind === 'ALL') return true;

    if (conversation.ownerId === scope.userId) return true;

    if (conversation.leadId) {
      const lead = await this.repository.findLeadById(conversation.leadId);
      return lead?.assignedToId === scope.userId;
    }

    return scope.includeUnassigned && conversation.ownerId === null;
  }

  private notFound(): AppException {
    return AppException.notFound(ERROR_CODES.NOT_FOUND, 'Conversation not found.');
  }
}

function toMessageView(message: {
  id: string;
  direction: string;
  senderType: string;
  messageType: string;
  content: string | null;
  deliveryStatus: string | null;
  failureReason: string | null;
  sentAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: message.id,
    direction: message.direction,
    senderType: message.senderType,
    messageType: message.messageType,
    content: message.content,
    deliveryStatus: message.deliveryStatus,
    failureReason: message.failureReason,
    sentAt: message.sentAt?.toISOString() ?? null,
    createdAt: message.createdAt.toISOString(),
  };
}
