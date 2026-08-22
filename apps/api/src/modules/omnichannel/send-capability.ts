import type { ChannelType } from '../../generated/prisma/enums';

/**
 * Whether a reply can be sent, and if not, why.
 *
 * Pure, so every combination is cheap to test and the rules are readable in one
 * place. The UI treats the result as authoritative and renders a composer only
 * when `canSend` is true — which is why a wrong answer here is not a cosmetic
 * bug: a composer over a conversation that cannot send lets a salesperson type
 * a reply, watch it fail, and lose the customer to the delay.
 *
 * The reasons are written for the person who has to act on them, and none of
 * them mention a token, an app secret or an internal state name.
 */

/**
 * WhatsApp's customer service window.
 *
 * Meta permits free-form replies for 24 hours after the customer's most recent
 * message. Outside it, only an approved template may be sent — which this phase
 * does not implement, so the window closing means the composer closes with it.
 *
 * Computed locally from the last inbound message rather than asked of Meta:
 * the inbox must stay database-driven, and a provider call per conversation row
 * would make opening the inbox depend on Meta being up.
 */
export const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface SendCapabilityInput {
  channel: ChannelType;
  integration: {
    status: string;
    enabled: boolean;
  } | null;
  /** When the customer last wrote. Null when they never have. */
  lastInboundAt: Date | null;
  /** Whether this caller may act on this conversation at all. */
  mayReply: boolean;
  now?: Date;
}

export interface SendCapability {
  canSend: boolean;
  /** Present only when canSend is false. Safe to show a user verbatim. */
  sendDisabledReason?: string;
  /** When the free-form window closes. Null when it is already shut or N/A. */
  windowExpiresAt?: string | null;
}

export function evaluateSendCapability(input: SendCapabilityInput): SendCapability {
  // Only WhatsApp can send in this phase. Instagram and Facebook conversations
  // are captured and read-only.
  if (input.channel !== 'WHATSAPP') {
    return {
      canSend: false,
      sendDisabledReason: 'Replying from LeadFlow is not available for this channel yet.',
    };
  }

  if (!input.mayReply) {
    return {
      canSend: false,
      sendDisabledReason: 'You do not have permission to reply to this conversation.',
    };
  }

  if (!input.integration) {
    return {
      canSend: false,
      sendDisabledReason: 'WhatsApp is not connected for this organization.',
    };
  }

  if (!input.integration.enabled) {
    return {
      canSend: false,
      sendDisabledReason: 'The WhatsApp channel is switched off in settings.',
    };
  }

  if (input.integration.status !== 'CONNECTED') {
    // CONNECTING has never been validated; ERROR and DISCONNECTED are not
    // operational. None of them can carry a message.
    return {
      canSend: false,
      sendDisabledReason:
        input.integration.status === 'ERROR'
          ? 'The WhatsApp connection needs attention in settings.'
          : 'WhatsApp is not fully connected yet.',
    };
  }

  if (!input.lastInboundAt) {
    // Meta does not allow opening a conversation with a free-form message.
    return {
      canSend: false,
      sendDisabledReason:
        'WhatsApp only allows a free-form reply after the customer has messaged you.',
      windowExpiresAt: null,
    };
  }

  const now = input.now ?? new Date();
  const expiresAt = new Date(input.lastInboundAt.getTime() + CUSTOMER_SERVICE_WINDOW_MS);

  if (now.getTime() >= expiresAt.getTime()) {
    return {
      canSend: false,
      sendDisabledReason:
        'More than 24 hours have passed since the customer last wrote. WhatsApp requires an ' +
        'approved template to reopen the conversation, which LeadFlow cannot send yet.',
      windowExpiresAt: null,
    };
  }

  return { canSend: true, windowExpiresAt: expiresAt.toISOString() };
}

/** Meta's limit for a text message body. */
export const MAX_TEXT_LENGTH = 4096;
