import { Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES } from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import { AuditRepository } from '../../common/audit/audit.repository';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { OmnichannelRepository } from './omnichannel.repository';
import { conversationScope } from './conversation-visibility';
import { evaluateSendCapability, maxTextLengthFor, MAX_TEXT_LENGTH } from './send-capability';
import { WhatsAppOutboundService } from './providers/whatsapp/whatsapp-outbound.service';
import { WhatsAppTemplateRepository } from './providers/whatsapp/whatsapp-template.repository';
import {
  buildTemplateComponents,
  readStoredComponents,
  renderTemplateText,
  type TemplateParameters,
} from './providers/whatsapp/whatsapp-template';
import { MessengerOutboundService } from './providers/messenger/messenger-outbound.service';
import type { ChannelSender } from './providers/channel-sender';
import {
  detectMimeType,
  toAttachmentViews,
  validateMedia,
  type MessageAttachment,
  type UploadedMedia,
} from './message-attachment';
import type { ChannelType } from '../../generated/prisma/enums';

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
    private readonly templates: WhatsAppTemplateRepository,
    private readonly messenger: MessengerOutboundService,
    private readonly audit: AuditRepository,
  ) {}

  /**
   * Which adapter speaks for a channel.
   *
   * The only place in the outbound flow that knows channels exist. Everything
   * either side of it — authorization, capability, idempotency, failure
   * handling — is identical for all three, which is the point: one outbound
   * path, several providers behind it.
   */
  private senderFor(channel: ChannelType): ChannelSender | null {
    switch (channel) {
      case 'WHATSAPP':
        return this.whatsapp;
      case 'INSTAGRAM':
      case 'FACEBOOK':
        return this.messenger;
      default:
        return null;
    }
  }

  async send(
    conversationId: string,
    input: { content: string; idempotencyKey: string; file?: UploadedMedia },
    principal: TenantPrincipal,
  ) {
    const body = input.content.trim();

    /*
     * A message needs to say something OR carry something.
     *
     * A photo on its own is a complete message, so text is no longer required
     * once a file is attached — but neither is still nothing to send.
     */
    if (!body && !input.file) {
      throw new AppException(
        ERROR_CODES.VALIDATION_ERROR,
        'A message cannot be empty.',
        400,
      );
    }

    /*
     * A cheap upper bound before anything is loaded.
     *
     * The real, channel-specific limit is checked once the conversation is
     * known — Instagram accepts 1000 characters where WhatsApp accepts 4096,
     * and rejecting at the larger bound first keeps an obviously oversized
     * body from costing a database round trip.
     */
    if (body.length > MAX_TEXT_LENGTH) {
      throw new AppException(
        ERROR_CODES.VALIDATION_ERROR,
        `Messages are limited to ${MAX_TEXT_LENGTH} characters.`,
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

    const channelLimit = maxTextLengthFor(conversation.channel);
    if (body.length > channelLimit) {
      throw new AppException(
        ERROR_CODES.VALIDATION_ERROR,
        `Messages on this channel are limited to ${channelLimit} characters.`,
        400,
      );
    }

    // --- capability ---------------------------------------------------------
    const [integration, lastInboundAt, recipient] = await Promise.all([
      this.repository.findIntegrationForChannel(conversation.channel),
      this.repository.lastInboundAt(conversationId),
      this.repository.recipientFor(conversationId),
    ]);

    const capability = evaluateSendCapability({
      channel: conversation.channel,
      integration: integration
        ? {
            status: integration.status,
            enabled: integration.enabled,
            hasCredential: integration.encryptedAccessToken !== null,
          }
        : null,
      lastInboundAt,
      mayReply: true,
      hasRecipient: recipient !== null,
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

    /*
     * --- the file, if there is one ------------------------------------------
     *
     * Validated from its BYTES, before anything is claimed or sent. The
     * browser's Content-Type and the filename extension are both attacker
     * controlled and are the usual way an upload filter gets bypassed, so
     * neither decides what this file is.
     */
    let media: NonNullable<Parameters<ChannelSender['sendMedia']>[0]>['media'] | null = null;

    if (input.file) {
      const detected = detectMimeType(input.file.buffer);
      const check = validateMedia(conversation.channel, detected, input.file.size);

      if (!check.ok) {
        throw new AppException(ERROR_CODES.VALIDATION_ERROR, check.message, 400);
      }

      media = {
        buffer: input.file.buffer,
        // The detected type, not the declared one.
        mimeType: detected as string,
        filename: safeFilename(input.file.originalname),
        kind: check.type as 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT',
      };
    }

    // --- claim --------------------------------------------------------------
    // Written first, on purpose. See the class comment.
    const attachments: MessageAttachment[] = media
      ? [
          {
            // Ours, not the provider's — the id Meta issues during upload is
            // not a durable handle and is not worth storing.
            providerMediaId: null,
            providerUrl: null,
            type: media.kind,
            mimeType: media.mimeType,
            filename: media.filename,
            sizeBytes: input.file?.size ?? null,
          },
        ]
      : [];

    const claimed = await this.repository.claimOutboundMessage({
      conversationId,
      channel: conversation.channel,
      content: body,
      ...(media ? { messageType: media.kind, attachments } : {}),
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
    const sender = this.senderFor(conversation.channel);

    if (!sender) {
      // Unreachable: a channel with no adapter has no policy either, so the
      // capability check above already refused. Handled anyway rather than
      // asserting non-null on something a future channel could break.
      await this.repository.markMessageFailed(claimed.id, 'This channel cannot send messages.');
      throw new AppException(
        ERROR_CODES.CONFLICT,
        'Replying from LeadFlow is not available for this channel yet.',
        409,
      );
    }

    const request = {
      accountId: integration!.providerAccountId,
      encryptedAccessToken: integration!.encryptedAccessToken,
      // Passed as stored. Any provider-specific formatting is the adapter's
      // business — a phone number needs its plus stripped for WhatsApp and a
      // Messenger id must not be touched at all.
      recipient: recipient!,
      body,
    };

    const result = media
      ? await sender.sendMedia({ ...request, media })
      : await sender.sendText(request);

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
        // The fact of a file and its kind. Never its name or its bytes.
        attachment: media ? media.kind : null,
      },
    });

    return toMessageView(sent ?? claimed);
  }

  /**
   * Send an approved WhatsApp template.
   *
   * A SIBLING of `send`, not a fallback for it. Everything that made the
   * free-form path safe is reused deliberately — the same authorization, the
   * same visibility rule, the same claim-before-send ordering, the same message
   * table, the same conversation timeline — and exactly two things differ:
   *
   *   - the window check asks `canSendTemplate` instead of `canSend`, which is
   *     the entire point, since a template is what WhatsApp allows once the
   *     24-hour window has closed;
   *   - the content is built from the STORED definition rather than typed.
   *
   * Nothing routes here automatically. A free-form send refused for a closed
   * window throws and stops; it does not quietly become a template. Sending a
   * customer a templated message they did not expect, because a colleague
   * mistimed a reply, is a worse outcome than a refusal somebody can see.
   */
  async sendTemplate(
    conversationId: string,
    input: {
      templateName: string;
      language: string;
      parameters: TemplateParameters;
      idempotencyKey: string;
    },
    principal: TenantPrincipal,
  ) {
    // Idempotency first, exactly as the free-form path does it.
    const existing = await this.repository.findMessageByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      this.logger.debug(
        `Idempotent replay of template send ${input.idempotencyKey}; returning the original.`,
      );
      return toMessageView(existing);
    }

    // --- authorize ----------------------------------------------------------
    const conversation = await this.repository.findConversationForSend(conversationId);
    if (!conversation) throw this.notFound();

    if (!(await this.mayReply(conversation, principal))) throw this.notFound();

    if (conversation.channel !== 'WHATSAPP') {
      throw new AppException(
        ERROR_CODES.CONFLICT,
        'Templates are only available on WhatsApp.',
        409,
      );
    }

    /*
     * --- the template, as Meta last reported it -----------------------------
     *
     * Read from our cache, and read by NAME AND LANGUAGE through the
     * tenant-scoped client, so a template belonging to another organization is
     * not merely hidden but unreachable. The request supplies a name; it does
     * not supply a definition.
     */
    const row = await this.templates.findByNameAndLanguage(input.templateName, input.language);

    if (!row) {
      throw AppException.notFound(
        ERROR_CODES.NOT_FOUND,
        'That template is not available. Refresh the template list in settings.',
      );
    }

    /*
     * Approval is Meta's answer, never ours.
     *
     * We store what Meta said and re-check it here. A template that has since
     * been paused or rejected will also be refused by Meta itself, so this
     * check does not create the guarantee — it just means the salesperson is
     * told before the send rather than after.
     */
    if (row.status !== 'APPROVED') {
      throw new AppException(
        ERROR_CODES.CONFLICT,
        `That template is ${row.status.toLowerCase()} in Meta and cannot be sent. ` +
          'Templates are approved in Meta, not in LeadFlow.',
        409,
      );
    }

    if (!row.supported) {
      throw new AppException(
        ERROR_CODES.CONFLICT,
        row.unsupportedReason ?? 'LeadFlow cannot send this template.',
        409,
      );
    }

    // --- capability ---------------------------------------------------------
    const [integration, lastInboundAt, recipient] = await Promise.all([
      this.repository.findIntegrationForChannel(conversation.channel),
      this.repository.lastInboundAt(conversationId),
      this.repository.recipientFor(conversationId),
    ]);

    const capability = evaluateSendCapability({
      channel: conversation.channel,
      integration: integration
        ? {
            status: integration.status,
            enabled: integration.enabled,
            hasCredential: integration.encryptedAccessToken !== null,
          }
        : null,
      lastInboundAt,
      mayReply: true,
      hasRecipient: recipient !== null,
      // Known to be true: an approved, supported row was just loaded.
      hasSendableTemplate: true,
    });

    /*
     * `canSendTemplate`, NOT `canSend`.
     *
     * This is the one place the two answers deliberately diverge. Everything
     * else the capability checked — permission, the integration, the
     * credential, a recipient — still has to hold; only the window does not.
     */
    if (!capability.canSendTemplate) {
      throw new AppException(
        ERROR_CODES.CONFLICT,
        capability.templateDisabledReason ??
          'This conversation cannot be sent a template right now.',
        409,
      );
    }

    // --- build, against the stored definition -------------------------------
    const sections = readStoredComponents(row.components);
    const built = buildTemplateComponents(
      {
        ...sections,
        supported: row.supported,
        unsupportedReason: row.unsupportedReason,
      },
      input.parameters,
    );

    if (!built.ok) {
      // 400, not 409: the values submitted are wrong, and re-submitting the
      // same ones will fail again.
      throw new AppException(ERROR_CODES.VALIDATION_ERROR, built.message, 400);
    }

    /*
     * What the customer will actually see, stored as the message content.
     *
     * The timeline shows the rendered text rather than the template name,
     * because "order_ready" is not what arrived on the customer's phone and a
     * salesperson reading the history back needs the words.
     */
    const rendered = renderTemplateText(sections, input.parameters);

    // --- claim --------------------------------------------------------------
    const claimed = await this.repository.claimOutboundMessage({
      conversationId,
      channel: conversation.channel,
      content: rendered,
      messageType: 'TEMPLATE',
      metadata: {
        template: {
          name: row.name,
          language: row.language,
          // The values that were submitted. They are already in the rendered
          // content; keeping them separately is what makes it possible to say
          // later which placeholder held what.
          parameters: input.parameters,
        },
      },
      idempotencyKey: input.idempotencyKey,
      sentById: principal.userId,
    });

    if (!claimed) {
      const raced = await this.repository.findMessageByIdempotencyKey(input.idempotencyKey);
      if (raced) return toMessageView(raced);

      throw new AppException(ERROR_CODES.CONFLICT, 'That message is already being sent.', 409);
    }

    // --- send ---------------------------------------------------------------
    const sender = this.senderFor(conversation.channel);

    if (!sender?.sendTemplate) {
      // Unreachable today — the channel check above already refused anything
      // but WhatsApp — but handled rather than asserted, because the optional
      // method is exactly what a future non-template channel would leave out.
      await this.repository.markMessageFailed(claimed.id, 'This channel cannot send templates.');
      throw new AppException(
        ERROR_CODES.CONFLICT,
        'Templates are only available on WhatsApp.',
        409,
      );
    }

    const result = await sender.sendTemplate({
      accountId: integration!.providerAccountId,
      encryptedAccessToken: integration!.encryptedAccessToken,
      recipient: recipient!,
      template: {
        name: row.name,
        language: row.language,
        components: built.components,
      },
    });

    if (!result.ok) {
      await this.repository.markMessageFailed(claimed.id, result.message);

      // Same treatment as a free-form failure: the row stays, so an uncertain
      // send leaves a trace the salesperson can check before resending.
      throw new AppException(ERROR_CODES.CONFLICT, result.message, result.uncertain ? 502 : 409);
    }

    const sent = await this.repository.markMessageSent(claimed.id, result.providerMessageId);

    await this.audit.record({
      action: 'omnichannel.template_sent',
      entityType: 'conversation',
      entityId: conversationId,
      after: {
        messageId: claimed.id,
        channel: conversation.channel,
        // The template NAME is recorded — unlike message content, it is a
        // business decision about what was sent, not the customer's words.
        template: row.name,
        language: row.language,
        // Counts, not values: the parameters carry customer data.
        parameterCount: input.parameters.header.length + input.parameters.body.length,
        // Whether this reopened a closed conversation, which is the operational
        // question anybody reading this log will have.
        outsideWindow: !capability.canSend,
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

/**
 * A filename safe to hand to a provider.
 *
 * Path separators are the point: the name reaches a multipart part header, and
 * a value like `../../etc/passwd` has no business being echoed anywhere. It is
 * a display hint, so falling back to a neutral name costs nothing.
 */
function safeFilename(name: string | undefined): string {
  const cleaned = (name ?? '')
    .replace(/[/\\]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"]/g, '')
    .trim()
    .slice(0, 120);

  return cleaned.length > 0 ? cleaned : 'attachment';
}

function toMessageView(message: {
  id: string;
  direction: string;
  senderType: string;
  messageType: string;
  content: string | null;
  deliveryStatus: string | null;
  failureReason: string | null;
  attachments?: unknown;
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
    attachments: toAttachmentViews(message.attachments),
    sentAt: message.sentAt?.toISOString() ?? null,
    createdAt: message.createdAt.toISOString(),
  };
}
