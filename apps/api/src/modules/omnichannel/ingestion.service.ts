import { Injectable, Logger } from '@nestjs/common';
import { AuditRepository } from '../../common/audit/audit.repository';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
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
 *   * create leads — that is the existing lead flow's job, and Phase C's queue
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
