import { Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import { AuditRepository } from '../../common/audit/audit.repository';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { resolveLeadVisibility } from '../leads/lead-visibility';
import { OmnichannelRepository } from './omnichannel.repository';
import { selectLead } from './lead-selection';

/**
 * The review queue: conversations waiting on a person to decide something.
 *
 * Everything here is read-only or reversible. Nothing in this service creates a
 * lead — "Create lead" in the UI calls the ordinary POST /leads and then the
 * existing link endpoint, so a lead born from a WhatsApp message goes through
 * exactly the same validation, duplicate detection and assignment rules as one
 * typed in by hand.
 */
@Injectable()
export class ConversationReviewService {
  constructor(
    private readonly repository: OmnichannelRepository,
    private readonly audit: AuditRepository,
  ) {}

  /**
   * What this caller may see.
   *
   * A rep restricted to their own leads gets their own conversations plus the
   * unassigned queue; anyone with team or organization visibility gets
   * everything. Undefined means no restriction.
   */
  private ownerScope(principal: TenantPrincipal): string | undefined {
    return resolveLeadVisibility(principal) === 'OWN' ? principal.userId : undefined;
  }

  async list(
    options: { category?: string; channel?: string; archived?: boolean; limit?: number },
    principal: TenantPrincipal,
  ) {
    const rows = await this.repository.listForReview({
      ownerScope: this.ownerScope(principal),
      channel: options.channel as 'WHATSAPP' | 'FACEBOOK' | 'INSTAGRAM' | undefined,
      category: options.category,
      archived: options.archived ?? false,
      limit: Math.min(options.limit ?? 50, 100),
    });

    return { items: rows.map(toReviewRow), total: rows.length };
  }

  /** The badge count on the navigation item. */
  async pendingCount(principal: TenantPrincipal): Promise<{ count: number }> {
    return { count: await this.repository.countForReview(this.ownerScope(principal)) };
  }

  /**
   * One conversation, its messages, and — when the system refused to choose —
   * the leads it could plausibly belong to.
   *
   * The candidates are recomputed here rather than stored. Storing them would
   * mean a list that silently goes stale as leads are won, lost or reassigned,
   * and the reviewer would be choosing from a snapshot of a pipeline that has
   * moved on.
   */
  async detail(id: string, principal: TenantPrincipal) {
    const conversation = await this.repository.findConversationDetail(id);
    if (!conversation) throw this.notFound();

    // A conversation already attached to a lead is only visible to someone who
    // may see that lead.
    if (conversation.leadId) {
      const visibility = resolveLeadVisibility(principal);
      if (visibility === 'OWN' && conversation.lead?.assignedToId !== principal.userId) {
        throw this.notFound();
      }
    } else if (
      this.ownerScope(principal) &&
      conversation.ownerId &&
      conversation.ownerId !== principal.userId
    ) {
      throw this.notFound();
    }

    const candidates = conversation.contactId
      ? await this.candidatesFor(conversation.contactId, conversation.leadId, principal)
      : [];

    return {
      id: conversation.id,
      channel: conversation.channel,
      status: conversation.status,
      linkState: conversation.linkState,
      potentialLead: conversation.potentialLead,
      potentialLeadSignals: conversation.potentialLeadSignals,
      archivedAt: conversation.archivedAt?.toISOString() ?? null,
      archivedReason: conversation.archivedReason,
      lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
      companyName: conversation.companyName,
      contact: conversation.contact,
      owner: conversation.owner,
      lead: conversation.lead
        ? {
            id: conversation.lead.id,
            leadNumber: conversation.lead.leadNumber,
            status: conversation.lead.status,
          }
        : null,
      integration: conversation.integration,
      /*
       * No sending in this phase, and the UI must not offer it. Reported as a
       * capability rather than assumed, so a "Reply" button can never appear
       * over a channel that cannot actually deliver it.
       */
      canSend: false,
      candidateLeads: candidates,
      messages: conversation.messages.map((message) => ({
        id: message.id,
        direction: message.direction,
        senderType: message.senderType,
        messageType: message.messageType,
        content: message.content,
        attachments: message.attachments,
        sentAt: message.sentAt?.toISOString() ?? null,
        createdAt: message.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Leads this conversation could belong to, filtered to what the caller sees.
   *
   * Runs the same `selectLead` rules the automatic path uses, so the queue
   * shows exactly the ambiguity the system refused to resolve rather than a
   * second, differently-computed opinion.
   */
  private async candidatesFor(
    contactId: string,
    linkedLeadId: string | null,
    principal: TenantPrincipal,
  ) {
    const visibility = resolveLeadVisibility(principal);
    const rows = await this.repository.findVisibleLeadsForContact(
      contactId,
      visibility === 'OWN' ? principal.userId : undefined,
    );

    const selection = selectLead(
      rows.map((lead) => ({
        id: lead.id,
        leadNumber: lead.leadNumber,
        status: lead.status,
        assignedToId: lead.assignedTo?.id ?? null,
        companyName: lead.companyName,
        createdAt: lead.createdAt,
      })),
      linkedLeadId,
    );

    // Only an unresolved choice needs presenting. A single match has already
    // been linked automatically, and none means there is nothing to offer.
    if (selection.outcome !== 'AMBIGUOUS') return [];

    const byId = new Map(rows.map((lead) => [lead.id, lead]));
    return selection.candidates
      .map((candidate) => byId.get(candidate.id))
      .filter((lead): lead is NonNullable<typeof lead> => lead !== undefined)
      .map((lead) => ({
        id: lead.id,
        leadNumber: lead.leadNumber,
        status: lead.status,
        companyName: lead.companyName,
        productInterest: lead.productInterest,
        assignedTo: lead.assignedTo,
        createdAt: lead.createdAt.toISOString(),
        lastActivityAt: lead.lastActivityAt?.toISOString() ?? null,
      }));
  }

  /**
   * Dismiss a conversation from the queue.
   *
   * Nothing is deleted. The thread, its messages and any activity it produced
   * stay exactly where they are — this only takes it out of the pile a person
   * is working through, and it can be put back.
   */
  async archive(id: string, reason: string | null, principal: TenantPrincipal) {
    const conversation = await this.requireVisible(id, principal);

    if (conversation.archivedAt) {
      throw new AppException(
        ERROR_CODES.CONFLICT,
        'This conversation has already been dismissed.',
        409,
      );
    }

    await this.repository.setArchived({
      conversationId: id,
      archivedAt: new Date(),
      actorId: principal.userId,
      reason,
    });

    await this.audit.record({
      action: 'omnichannel.conversation_archived',
      entityType: 'conversation',
      entityId: id,
      after: { reason },
    });

    return { id, archived: true };
  }

  async restore(id: string, principal: TenantPrincipal) {
    const conversation = await this.requireVisible(id, principal);

    if (!conversation.archivedAt) {
      throw new AppException(
        ERROR_CODES.CONFLICT,
        'This conversation is not dismissed.',
        409,
      );
    }

    await this.repository.setArchived({
      conversationId: id,
      archivedAt: null,
      actorId: principal.userId,
      reason: null,
    });

    await this.audit.record({
      action: 'omnichannel.conversation_restored',
      entityType: 'conversation',
      entityId: id,
    });

    return { id, archived: false };
  }

  private async requireVisible(id: string, principal: TenantPrincipal) {
    const conversation = await this.repository.findConversationById(id);
    if (!conversation) throw this.notFound();

    if (
      this.ownerScope(principal) &&
      conversation.ownerId &&
      conversation.ownerId !== principal.userId
    ) {
      throw this.notFound();
    }

    return conversation;
  }

  private notFound(): AppException {
    return AppException.notFound(ERROR_CODES.NOT_FOUND, 'Conversation not found.');
  }
}

function toReviewRow(row: {
  id: string;
  channel: string;
  linkState: string;
  potentialLead: boolean;
  potentialLeadSignals: string[];
  archivedAt: Date | null;
  lastMessageAt: Date | null;
  companyName: string | null;
  contact: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    mobile: string | null;
    email: string | null;
    companyName: string | null;
  } | null;
  owner: { id: string; fullName: string } | null;
  lead: { id: string; leadNumber: string; status: string } | null;
  messages: { content: string | null; createdAt: Date; direction: string }[];
}) {
  const latest = row.messages[0];
  const name = [row.contact?.firstName, row.contact?.lastName].filter(Boolean).join(' ').trim();

  return {
    id: row.id,
    channel: row.channel,
    linkState: row.linkState,
    potentialLead: row.potentialLead,
    potentialLeadSignals: row.potentialLeadSignals,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    contact: row.contact
      ? {
          id: row.contact.id,
          name: name || null,
          mobile: row.contact.mobile,
          email: row.contact.email,
          companyName: row.contact.companyName,
        }
      : null,
    companyName: row.companyName ?? row.contact?.companyName ?? null,
    owner: row.owner,
    lead: row.lead,
    lastMessagePreview: latest?.content ?? null,
  };
}
