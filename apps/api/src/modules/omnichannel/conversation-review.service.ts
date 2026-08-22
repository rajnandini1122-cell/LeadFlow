import { Injectable } from '@nestjs/common';
import { ERROR_CODES, PERMISSIONS } from '@leadflow/api-types';
import type { ChannelType } from '../../generated/prisma/enums';
import { AppException } from '../../common/errors/app.exception';
import { AuditRepository } from '../../common/audit/audit.repository';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { resolveLeadVisibility } from '../leads/lead-visibility';
import { OmnichannelRepository } from './omnichannel.repository';
import { conversationScope, conversationScopeFilter } from './conversation-visibility';
import { evaluateSendCapability } from './send-capability';
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
   * The caller's conversation scope, as a query fragment.
   *
   * Reads the organization's shared-queue setting, because whether a rep may
   * see unowned threads is a tenant decision — see conversation-visibility.ts.
   */
  private async scopeFilter(principal: TenantPrincipal) {
    const shared = await this.repository.sharedUnassignedQueue();
    return conversationScopeFilter(conversationScope(principal, shared));
  }

  async list(
    options: {
      category?: string;
      channel?: string;
      archived?: boolean;
      limit?: number;
      cursor?: string;
      inboxFilter?: 'MINE' | 'UNASSIGNED';
      /** The inbox shows linked threads too; the review queue does not. */
      includeLinked?: boolean;
    },
    principal: TenantPrincipal,
  ) {
    const limit = Math.min(options.limit ?? 50, 100);

    const { rows, hasMore } = await this.repository.listConversations({
      scopeFilter: await this.scopeFilter(principal),
      channel: options.channel as 'WHATSAPP' | 'FACEBOOK' | 'INSTAGRAM' | undefined,
      category: options.category,
      inboxFilter: options.inboxFilter,
      userId: principal.userId,
      archived: options.archived ?? false,
      excludeLinked: options.includeLinked !== true,
      limit,
      cursor: options.cursor,
    });

    const items = rows.map(toReviewRow);
    return {
      items,
      hasMore,
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  }

  /** The badge count on the navigation item. */
  async pendingCount(principal: TenantPrincipal): Promise<{ count: number }> {
    return {
      count: await this.repository.countConversations({
        scopeFilter: await this.scopeFilter(principal),
        archived: false,
        excludeLinked: true,
      }),
    };
  }

  /** Counts for the inbox tabs. Cheap, and scoped exactly like the lists. */
  async inboxCounts(principal: TenantPrincipal) {
    const scopeFilter = await this.scopeFilter(principal);
    const base = { scopeFilter, archived: false, excludeLinked: false } as const;

    const [all, mine, unassigned, review] = await Promise.all([
      this.repository.countConversations(base),
      this.repository.countConversations({
        ...base,
        inboxFilter: 'MINE',
        userId: principal.userId,
      }),
      this.repository.countConversations({ ...base, inboxFilter: 'UNASSIGNED' }),
      this.repository.countConversations({ scopeFilter, archived: false, excludeLinked: true }),
    ]);

    return { all, mine, unassigned, review };
  }

  /**
   * Hand a conversation to someone, or take it back off them.
   *
   * Conversation ownership only. The linked lead's assignee is not read, not
   * written and not consulted — passing a thread to a colleague is not the same
   * act as passing them the deal.
   */
  async assign(
    conversationId: string,
    userId: string | null,
    principal: TenantPrincipal,
  ) {
    const conversation = await this.requireVisible(conversationId, principal);

    if (userId) {
      const member = await this.repository.findAssignableMember(userId);
      if (!member) {
        throw AppException.notFound(
          ERROR_CODES.USER_NOT_FOUND,
          'That person is not an active member of this organization.',
        );
      }
    }

    await this.repository.setConversationOwner(conversationId, userId);

    await this.audit.record({
      action: 'omnichannel.conversation_assigned',
      entityType: 'conversation',
      entityId: conversationId,
      before: { ownerId: conversation.ownerId },
      after: { ownerId: userId },
    });

    return { id: conversationId, ownerId: userId };
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

    if (!(await this.canSee(conversation, principal))) throw this.notFound();

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
       * Calculated, never assumed.
       *
       * The UI renders a composer only when this is true, so a wrong answer
       * lets a salesperson type a reply and watch it fail — losing the customer
       * to the delay. The reason is written to be shown verbatim and names no
       * token, secret or internal state.
       */
      ...(await this.sendCapability(conversation, principal)),
      candidateLeads: candidates,
      messages: conversation.messages.map((message) => ({
        id: message.id,
        direction: message.direction,
        senderType: message.senderType,
        messageType: message.messageType,
        content: message.content,
        attachments: message.attachments,
        deliveryStatus: message.deliveryStatus,
        failureReason: message.failureReason,
        sentAt: message.sentAt?.toISOString() ?? null,
        createdAt: message.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Whether this caller can reply, and if not, why.
   *
   * Database-driven throughout: the integration state is read from the row we
   * already store and the 24-hour window from the last inbound message. Asking
   * Meta would make opening a conversation depend on their availability, and
   * would put a provider call behind a screen a salesperson opens constantly.
   */
  private async sendCapability(
    conversation: { id: string; channel: ChannelType; ownerId: string | null; leadId: string | null },
    principal: TenantPrincipal,
  ) {
    const [integration, lastInboundAt] = await Promise.all([
      this.repository.findIntegrationForChannel(conversation.channel),
      this.repository.lastInboundAt(conversation.id),
    ]);

    // Reading a conversation and replying to it are different permissions, so
    // someone may legitimately see this screen with no composer on it.
    const mayReply = principal.permissions.includes(PERMISSIONS.LEAD_UPDATE);

    return evaluateSendCapability({
      channel: conversation.channel,
      integration: integration
        ? { status: integration.status, enabled: integration.enabled }
        : null,
      lastInboundAt,
      mayReply,
    });
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
    if (!(await this.canSee(conversation, principal))) throw this.notFound();

    return conversation;
  }

  /**
   * Whether one conversation is within the caller's scope.
   *
   * The same policy the list queries use, applied to a single row. Written
   * against `conversationScope` rather than re-deriving the rule, so a change
   * to who sees what lands here and in the inbox together — the two disagreeing
   * is precisely how a detail endpoint becomes the hole in a list filter.
   */
  private async canSee(
    conversation: { ownerId: string | null; leadId: string | null },
    principal: TenantPrincipal,
  ): Promise<boolean> {
    const scope = conversationScope(principal, await this.repository.sharedUnassignedQueue());
    if (scope.kind === 'ALL') return true;

    if (conversation.ownerId === scope.userId) return true;

    // Attached to a lead: the lead's own visibility decides, so a rep keeps
    // sight of the conversation on their deal however the thread is owned.
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
