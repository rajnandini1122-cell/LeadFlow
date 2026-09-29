import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditRepository } from '../../common/audit/audit.repository';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
import { normalizeProviderPhone } from '../../common/utils/phone';
import { IdentityResolutionService } from './identity-resolution.service';
import { OmnichannelRepository } from './omnichannel.repository';
import { selectLead } from './lead-selection';
import { detectBuyingSignals } from './lead-signals';
import type { IngestionResult, NormalizedChannelEvent } from './channel-event';

/**
 * Turning one normalised incoming message into CRM state.
 *
 * The whole path must be safe to run twice. Providers redeliver on any non-2xx
 * response, on timeouts, and sometimes for no reason at all, so "we processed
 * this already" is the normal case rather than the exceptional one. Every step
 * below is therefore a find-or-create keyed on something the provider gave us,
 * never an unconditional insert.
 *
 * What this deliberately does NOT do:
 *   * create leads — it never calls LeadsRepository. A WhatsApp buying enquiry
 *     is handed to the EXISTING intake pipeline as an `integration_intakes`
 *     row, and IntakeProcessingService converts it with the same routing,
 *     dedupe, assignment, follow-up and transaction logic a website enquiry
 *     gets. See offerToAutoLead. Every other message still stops at the review
 *     queue, and that remains the default: the hand-off is opt-in per tenant
 *     and fires only on a buying signal
 *   * assign anybody — ownership follows the lead, and only the lead
 *   * merge contacts — see IdentityResolutionService for why
 */
@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly repository: OmnichannelRepository,
    private readonly identity: IdentityResolutionService,
    private readonly audit: AuditRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Ingest one message.
   *
   * Runs pinned to the event's organization with no acting user, because a
   * webhook has no session behind it. Scoping stays on: the Prisma extension
   * still refuses anything outside that one tenant, so a malformed or forged
   * event cannot reach another organization's data.
   */
  async ingest(event: NormalizedChannelEvent): Promise<IngestionResult> {
    return this.tenantContext.runForOrganization(
      event.organizationId,
      `omnichannel: ingest ${event.channel} message ${event.externalMessageId}`,
      () => this.process(event),
    );
  }

  /**
   * Hands a WhatsApp buying enquiry to the EXISTING intake pipeline.
   *
   * Writes one `integration_intakes` row and stops. Everything that turns that
   * row into a lead — territory resolution, the routing rules, the team's round
   * robin, contact reuse, duplicate refusal, the first follow-up, and the single
   * transaction holding all of it — is IntakeProcessingService, unchanged, the
   * same path a website enquiry takes. This deliberately builds no second
   * lead-creation engine, and this service still never touches LeadsRepository.
   *
   * WHATSAPP ONLY, and the reason is data rather than preference. A wa_id is a
   * real phone number, so a WhatsApp enquiry can be de-duplicated against
   * existing leads by `leads_org_mobile_uniq` — the same index protecting every
   * other lead in the product. Instagram and Messenger give a scoped user id
   * and no number, so the identical automation there would have nothing to
   * de-duplicate on and two DMs from one person would become two leads.
   *
   * Failure here is deliberately SWALLOWED. The conversation, the message and
   * the buying-signal flag are already committed, so the enquiry is visible in
   * the Inbox and the review queue whatever happens next; throwing would turn a
   * non-2xx into an indefinite Meta redelivery of a message already stored.
   * Automation is an accelerator on top of the review queue, never a
   * replacement for it.
   */
  private async offerToAutoLead(
    event: NormalizedChannelEvent,
    conversationId: string,
    messageId: string,
    contactId: string | null,
    signals: string[],
  ): Promise<void> {
    if (event.channel !== 'WHATSAPP') return;

    /*
     * Read per message rather than cached.
     *
     * Turning this off has to take effect on the next message, not whenever a
     * cache expires — somebody switching it off is usually reacting to leads
     * they did not want.
     */
    if (!(await this.repository.whatsappAutoLeadEnabled())) return;

    // The sender's own number, canonicalised the same way identity resolution
    // does it. Not the phone-number-id, which is an opaque account identifier.
    const phone = normalizeProviderPhone(event.senderPhone);

    try {
      const intake = await this.repository.createLeadIntake({
        source: WHATSAPP_INTAKE_SOURCE,
        // The provider's message id IS the idempotency key, and it is the same
        // value the replay guard above uses. Together with the unique index on
        // (organization_id, source, external_event_id), a redelivered webhook
        // can only ever produce one intake.
        externalEventId: event.externalMessageId,
        eventType: WHATSAPP_INTAKE_EVENT_TYPE,
        payloadHash: intakePayloadHash(event),
        ...(event.senderName ? { name: event.senderName } : {}),
        ...(phone ? { phone } : {}),
        ...(event.content ? { message: event.content } : {}),
        ...(contactId ? { matchedContactId: contactId } : {}),
      });

      if (!intake) {
        // The row was already there: this message has been seen. Not an error,
        // and nothing to audit twice.
        this.logger.debug(
          `WhatsApp auto-lead intake already exists for message ${event.externalMessageId}.`,
        );
        return;
      }

      /*
       * Recorded as an intake CREATED, not as a lead created.
       *
       * No lead exists yet and this code cannot know whether one ever will —
       * conversion may legitimately refuse it as a duplicate, or block on
       * routing. The lead's own creation is audited by the conversion pipeline,
       * where the lead id actually exists. Claiming one here would be an audit
       * row asserting something that had not happened.
       */
      await this.audit.record({
        action: 'omnichannel.auto_lead_intake_created',
        entityType: 'conversation',
        entityId: conversationId,
        after: {
          channel: event.channel,
          intakeId: intake.id,
          messageId,
          externalMessageId: event.externalMessageId,
          contactId,
          // The matched words, so somebody reading the trail can see WHY this
          // message was treated as an enquiry and argue with it. Passed in
          // rather than recomputed, so the audit row can never disagree with
          // the decision that produced it.
          signals,
        },
      });

      this.logger.log(
        `WhatsApp buying enquiry queued for conversion (intake ${intake.id}, conversation ${conversationId}).`,
      );
    } catch (error) {
      // Never let automation cost us a stored message. See the note above.
      this.logger.error(
        { err: error, conversationId, channel: event.channel },
        'Could not queue a WhatsApp buying enquiry for automatic conversion; it remains in the review queue.',
      );
    }
  }

  private async process(event: NormalizedChannelEvent): Promise<IngestionResult> {
    /*
     * Replay guard, before anything is written.
     *
     * The unique index on (organization_id, channel, external_message_id) is
     * the real guarantee; this check is what turns the second delivery into a
     * quiet no-op instead of a constraint violation the provider would then
     * retry forever.
     */
    const duplicate = await this.repository.findMessageByExternalId(
      event.channel,
      event.externalMessageId,
    );

    if (duplicate) {
      const conversation = await this.repository.findConversationById(duplicate.conversationId);

      this.logger.debug(
        `Ignoring redelivered ${event.channel} message ${event.externalMessageId}.`,
      );

      return {
        conversationId: duplicate.conversationId,
        messageId: duplicate.id,
        created: false,
        contact: conversation?.contactId
          ? { outcome: 'MATCHED', contactId: conversation.contactId, createdIdentity: false }
          : { outcome: 'UNRESOLVED', reason: 'Already ingested; contact was not resolved.' },
        leadId: conversation?.leadId ?? null,
        linkState: conversation?.linkState ?? 'UNLINKED',
        candidateLeadIds: [],
      };
    }

    // --- who is this? -------------------------------------------------------
    const contact = await this.identity.resolve(event);
    const contactId = contact.outcome === 'MATCHED' ? contact.contactId : null;

    // --- the thread ---------------------------------------------------------
    // Keyed on the provider's conversation id, so a redelivered message that
    // slipped past the guard above still lands in the existing thread.
    const existing = await this.repository.findConversationByExternalId(
      event.channel,
      event.externalConversationId,
    );

    const conversation =
      existing ??
      (await this.repository.createConversation({
        channel: event.channel,
        integrationId: event.integrationId,
        externalConversationId: event.externalConversationId,
        contactId,
        companyName: null,
      }));

    const message = await this.repository.createMessage({
      conversationId: conversation.id,
      channel: event.channel,
      externalMessageId: event.externalMessageId,
      content: event.content ?? null,
      messageType: event.messageType ?? 'TEXT',
      attachments: event.attachments ?? [],
      sentAt: event.timestamp,
    });

    /*
     * Does this read like someone trying to buy something?
     *
     * Only ever changes which pile the conversation lands in for review. No
     * lead is created from a keyword — a queue that manufactures leads from
     * the word "price" fills the pipeline with noise, and the person reviewing
     * it is the one who can tell "what is your price" from "great price!".
     */
    const signals = detectBuyingSignals(event.content);
    if (signals.isPotentialLead) {
      await this.repository.markPotentialLead(conversation.id, signals.signals);
      await this.offerToAutoLead(event, conversation.id, message.id, contactId, signals.signals);
    }

    await this.repository.touchConversation({
      conversationId: conversation.id,
      // Fills in the contact on a thread that started before we could identify
      // the person — the second message often carries what the first did not.
      contactId: conversation.contactId ?? contactId,
      lastMessageAt: event.timestamp,
    });

    // --- which lead, if any? ------------------------------------------------
    if (!contactId) {
      // No person, so no lead. The message is stored and visible; a human
      // decides who it is from.
      return {
        conversationId: conversation.id,
        messageId: message.id,
        created: true,
        contact,
        leadId: null,
        linkState: conversation.linkState,
        candidateLeadIds: [],
      };
    }

    const candidates = await this.repository.findLeadsForContact(contactId);
    const selection = selectLead(candidates, conversation.leadId);

    if (selection.outcome === 'MATCHED') {
      const lead = selection.lead;

      /*
       * OWNER PRESERVATION.
       *
       * The conversation takes the lead's assignee. Nothing computes an owner,
       * nothing reassigns the lead, and the lead's own assignedToId is never
       * written here — a customer choosing to message on Instagram instead of
       * calling is not a reason to move their deal to somebody else.
       */
      const alreadyLinked = conversation.leadId === lead.id;

      if (!alreadyLinked) {
        await this.repository.linkToLead({
          conversationId: conversation.id,
          leadId: lead.id,
          ownerId: lead.assignedToId,
          description: `${titleCase(event.channel)} conversation linked to this lead`,
          actorId: null,
        });
      }

      /*
       * The message itself on the lead's timeline.
       *
       * Guarded by content so a redelivery that somehow reached this far cannot
       * append a second identical line to an append-only log that can never be
       * cleaned up afterwards.
       */
      const description = messageActivityText(event);
      if (!(await this.repository.hasActivity(lead.id, description))) {
        await this.repository.recordLeadActivity({
          leadId: lead.id,
          activityType: 'CHANNEL_MESSAGE_RECEIVED',
          description,
          actorId: null,
        });
      }

      return {
        conversationId: conversation.id,
        messageId: message.id,
        created: true,
        contact,
        leadId: lead.id,
        linkState: 'LINKED',
        candidateLeadIds: [],
      };
    }

    if (selection.outcome === 'AMBIGUOUS') {
      /*
       * Several live leads for one person. Nothing is attached.
       *
       * Recorded in the audit log rather than on a lead timeline, because
       * choosing a lead to write it to is exactly the choice being refused.
       */
      await this.repository.markReviewRequired(conversation.id);

      await this.audit.record({
        action: 'omnichannel.review_required',
        entityType: 'conversation',
        entityId: conversation.id,
        after: {
          channel: event.channel,
          contactId,
          candidateLeadIds: selection.candidates.map((lead) => lead.id),
          reason: 'Multiple active leads matched this contact; no lead was chosen.',
        },
      });

      return {
        conversationId: conversation.id,
        messageId: message.id,
        created: true,
        contact,
        leadId: null,
        linkState: 'REVIEW_REQUIRED',
        candidateLeadIds: selection.candidates.map((lead) => lead.id),
      };
    }

    // A known person with no live lead. Phase C's review queue picks this up;
    // Phase B deliberately stops here rather than inventing assignment logic.
    return {
      conversationId: conversation.id,
      messageId: message.id,
      created: true,
      contact,
      leadId: null,
      linkState: conversation.linkState,
      candidateLeadIds: [],
    };
  }
}

/**
 * The intake `source` for a WhatsApp enquiry.
 *
 * Free text, exactly like WEBSITE, because `integration_intakes.source` is a
 * VARCHAR chosen so a second source needs no migration. The unique key is
 * (organization_id, source, external_event_id), so a WEBSITE submission and a
 * WHATSAPP message may carry the same external id without colliding.
 */
export const WHATSAPP_INTAKE_SOURCE = 'WHATSAPP';

/** Matches the website path's vocabulary: this is an enquiry, not a status ping. */
export const WHATSAPP_INTAKE_EVENT_TYPE = 'ENQUIRY';

/**
 * A deterministic fingerprint of the normalised event.
 *
 * The column exists so a retry can be told from a collision: the same event id
 * with the same hash is the same message, while the same id with a DIFFERENT
 * hash means two different payloads are claiming one identity — which for a
 * provider id would be a bug worth seeing rather than silently overwriting.
 *
 * Built from the normalised fields rather than the raw webhook body on purpose.
 * Meta may re-serialise a redelivery — key order and whitespace are not
 * guaranteed stable — so hashing raw bytes would make the same message look
 * like a different one. The fields below are what we actually stored.
 *
 * Nothing secret goes in: ids, the sender's number, the message text and a
 * timestamp. No access token, no app secret, and the digest is one-way anyway.
 */
function intakePayloadHash(event: NormalizedChannelEvent): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        event.channel,
        event.externalMessageId,
        event.externalConversationId,
        event.externalUserId,
        event.senderPhone ?? null,
        event.content ?? null,
        event.timestamp.toISOString(),
      ]),
    )
    .digest('hex');
}

function titleCase(channel: string): string {
  return channel.charAt(0) + channel.slice(1).toLowerCase();
}

/**
 * The timeline line for an incoming message.
 *
 * Includes a truncated excerpt so the lead's history is readable without
 * opening the thread, and the provider's message id so the line is traceable
 * back to a specific delivery.
 */
function messageActivityText(event: NormalizedChannelEvent): string {
  const body = (event.content ?? '').trim().replace(/\s+/g, ' ');
  const excerpt = body.length > 160 ? `${body.slice(0, 157)}...` : body;

  return excerpt
    ? `${titleCase(event.channel)} message received: "${excerpt}"`
    : `${titleCase(event.channel)} ${(event.messageType ?? 'TEXT').toLowerCase()} received`;
}
