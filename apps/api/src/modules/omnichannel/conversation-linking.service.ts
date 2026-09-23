import { Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import { AuditRepository } from '../../common/audit/audit.repository';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { resolveLeadVisibility } from '../leads/lead-visibility';
import { OmnichannelRepository } from './omnichannel.repository';

/**
 * Manual conversation-to-lead linking.
 *
 * Everything here is a person's decision, so unlike ingestion it runs under a
 * real principal and is checked against the lead visibility the rest of the
 * product already uses. A rep who cannot see a lead cannot attach a customer's
 * conversation to it — otherwise linking would be a way to read a colleague's
 * pipeline one lead id at a time.
 *
 * Cross-tenant safety needs no code here. Both lookups go through the scoped
 * repository, so a lead in another organization simply is not found, and the
 * caller gets the same 404 as for an id that never existed. That is the
 * existing convention and it is deliberate: a 403 would confirm the id is real.
 */
@Injectable()
export class ConversationLinkingService {
  constructor(
    private readonly repository: OmnichannelRepository,
    private readonly audit: AuditRepository,
  ) {}

  /** Conversations attached to one lead, for the lead detail screen. */
  async forLead(leadId: string, principal: TenantPrincipal) {
    await this.requireVisibleLead(leadId, principal);
    return this.repository.listConversationsForLead(leadId);
  }

  /**
   * Attach a conversation to a lead.
   *
   * The conversation's owner is set from the lead's existing assignee, and the
   * lead's own assignment is not touched. This is the same rule ingestion
   * follows; it is restated in both places because it is the one invariant of
   * this phase that a reviewer would most easily break.
   */
  async link(conversationId: string, leadId: string, principal: TenantPrincipal) {
    const conversation = await this.repository.findConversationById(conversationId);
    if (!conversation) throw this.notFound();

    const lead = await this.requireVisibleLead(leadId, principal);

    if (conversation.leadId === leadId) return { conversationId, leadId };

    if (conversation.leadId) {
      throw new AppException(
        ERROR_CODES.CONFLICT,
        'This conversation is already linked to another lead. Unlink it first.',
        409,
      );
    }

    await this.repository.linkToLead({
      conversationId,
      leadId,
      // Follows the lead. Never computed, never the person doing the linking.
      ownerId: lead.assignedToId,
      description: `${titleCase(conversation.channel)} conversation linked manually`,
      actorId: principal.userId,
    });

    await this.audit.record({
      action: 'omnichannel.conversation_linked',
      entityType: 'conversation',
      entityId: conversationId,
      after: { leadId, leadNumber: lead.leadNumber, ownerId: lead.assignedToId },
    });

    return { conversationId, leadId };
  }

  /**
   * Detach a conversation from its lead.
   *
   * The messages are untouched and the lead keeps the activity recording that
   * the link once existed — unlinking corrects an association, it does not
   * erase that somebody made one.
   */
  async unlink(conversationId: string, principal: TenantPrincipal) {
    const conversation = await this.repository.findConversationById(conversationId);
    if (!conversation) throw this.notFound();

    if (!conversation.leadId) {
      throw new AppException(
        ERROR_CODES.CONFLICT,
        'This conversation is not linked to a lead.',
        409,
      );
    }

    await this.requireVisibleLead(conversation.leadId, principal);

    await this.repository.unlinkFromLead({
      conversationId,
      leadId: conversation.leadId,
      description: `${titleCase(conversation.channel)} conversation unlinked manually`,
      actorId: principal.userId,
    });

    await this.audit.record({
      action: 'omnichannel.conversation_unlinked',
      entityType: 'conversation',
      entityId: conversationId,
      before: { leadId: conversation.leadId },
    });

    return { conversationId };
  }

  /**
   * The lead, if this caller is allowed to see it.
   *
   * Reuses `resolveLeadVisibility` rather than reimplementing the rule, so a
   * rep restricted to their own leads is restricted here too, automatically,
   * and any future change to visibility applies to conversations for free.
   */
  private async requireVisibleLead(leadId: string, principal: TenantPrincipal) {
    const lead = await this.repository.findLeadById(leadId);
    if (!lead) throw AppException.leadNotFound();

    const visibility = resolveLeadVisibility(principal);
    if (visibility === 'OWN' && lead.assignedToId !== principal.userId) {
      // 404 rather than 403 — see the class comment.
      throw AppException.leadNotFound();
    }

    return lead;
  }

  private notFound(): AppException {
    return AppException.notFound(ERROR_CODES.NOT_FOUND, 'Conversation not found.');
  }
}

function titleCase(channel: string): string {
  return channel.charAt(0) + channel.slice(1).toLowerCase();
}
