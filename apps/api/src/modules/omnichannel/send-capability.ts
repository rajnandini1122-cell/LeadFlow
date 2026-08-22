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
 * Per-channel messaging policy.
 *
 * All three Meta channels DO enforce a 24-hour window from the customer's last
 * message — that is Meta's rule, not an assumption carried over from WhatsApp.
 * What differs is the escape hatch once it closes, and therefore what we can
 * honestly tell the salesperson:
 *
 *   WhatsApp   an approved message template, which IS implemented. WhatsApp is
 *              the one channel with a working way out of a closed window.
 *   Instagram  a HUMAN_AGENT tag, which extends the window to 7 days but needs
 *              the `human_agent` permission granted through Meta app review.
 *              Not implemented.
 *   Messenger  the same HUMAN_AGENT tag, same review requirement, same 7 days.
 *              Not implemented.
 *
 * So the window is shared and the explanation is not. Encoding the escape hatch
 * per channel is what stops the reason text becoming a lie the moment somebody
 * implements one of them.
 *
 * Text limits are Meta's, and they genuinely differ.
 */
interface ChannelPolicy {
  /** Human name, for reasons the user reads. */
  label: string;
  /** Milliseconds from the customer's last message during which a free reply is allowed. */
  windowMs: number;
  /** Provider's maximum body length for a text message. */
  maxTextLength: number;
  /** What it would take to message outside the window. Shown when it has closed. */
  reopenRequirement: string;
}

export const CHANNEL_POLICIES: Record<string, ChannelPolicy> = {
  WHATSAPP: {
    label: 'WhatsApp',
    windowMs: 24 * 60 * 60 * 1000,
    maxTextLength: 4096,
    reopenRequirement:
      'Send an approved WhatsApp template to reopen the conversation.',
  },
  INSTAGRAM: {
    label: 'Instagram',
    windowMs: 24 * 60 * 60 * 1000,
    maxTextLength: 1000,
    reopenRequirement:
      'Instagram only allows a reply outside that window under a human-agent exemption, ' +
      'which LeadFlow does not have.',
  },
  FACEBOOK: {
    label: 'Facebook Messenger',
    windowMs: 24 * 60 * 60 * 1000,
    maxTextLength: 2000,
    reopenRequirement:
      'Messenger only allows a reply outside that window under a human-agent exemption, ' +
      'which LeadFlow does not have.',
  },
};

/**
 * WhatsApp's customer service window, kept as a named export.
 *
 * Referenced by the existing WhatsApp tests. Left in place deliberately rather
 * than rewriting those tests during a phase that is meant to leave WhatsApp
 * behaviour alone.
 */
export const CUSTOMER_SERVICE_WINDOW_MS = CHANNEL_POLICIES['WHATSAPP']!.windowMs;

/** The longest body any supported channel accepts. Used for a cheap early reject. */
export const MAX_TEXT_LENGTH = 4096;

/** The provider limit for one channel. */
export function maxTextLengthFor(channel: ChannelType): number {
  return CHANNEL_POLICIES[channel]?.maxTextLength ?? MAX_TEXT_LENGTH;
}

export interface SendCapabilityInput {
  channel: ChannelType;
  integration: {
    status: string;
    enabled: boolean;
    /** Whether a credential is actually stored. Never the credential itself. */
    hasCredential?: boolean;
  } | null;
  /** When the customer last wrote. Null when they never have. */
  lastInboundAt: Date | null;
  /** Whether this caller may act on this conversation at all. */
  mayReply: boolean;
  /**
   * Whether this tenant has at least one approved, supported template.
   *
   * Undefined means “not checked” — the many callers that only want the
   * free-form answer need not read the template cache.
   */
  hasSendableTemplate?: boolean | undefined;
  /**
   * Whether the conversation carries a provider identity to reply to.
   *
   * Undefined means "not checked" and is treated as present, so the many
   * callers that only want the policy answer need not resolve a recipient.
   */
  hasRecipient?: boolean | undefined;
  now?: Date;
}

export interface SendCapability {
  /**
   * Whether a FREE-FORM message may be sent.
   *
   * Unchanged in meaning since the outbound phase, and deliberately still
   * named `canSend`: existing clients read it, and templates are an addition
   * to what this type answers rather than a redefinition of it.
   */
  canSend: boolean;
  /** Present only when canSend is false. Safe to show a user verbatim. */
  sendDisabledReason?: string;
  /** When the free-form window closes. Null when it is already shut or N/A. */
  windowExpiresAt?: string | null;
  /** The provider's text limit, so the composer can enforce it before sending. */
  maxTextLength?: number;

  /**
   * Whether an approved WhatsApp template may be sent.
   *
   * A SEPARATE answer from `canSend`, never a fallback for it. Outside the
   * window free-form stays refused and this may be true; inside the window
   * both can be true and the ordinary composer remains the default. Nothing
   * anywhere converts a refused free-form send into a template send.
   */
  canSendTemplate?: boolean;
  /** Why not. Present only when canSendTemplate is false. */
  templateDisabledReason?: string;
}

export function evaluateSendCapability(input: SendCapabilityInput): SendCapability {
  const policy = CHANNEL_POLICIES[input.channel];

  // A channel with no policy has no implementation. Nothing else to check.
  if (!policy) {
    return {
      canSend: false,
      sendDisabledReason: 'Replying from LeadFlow is not available for this channel yet.',
      canSendTemplate: false,
      templateDisabledReason: 'Templates are only available on WhatsApp.',
    };
  }

  const maxTextLength = policy.maxTextLength;

  if (!input.mayReply) {
    return {
      canSend: false,
      sendDisabledReason: 'You do not have permission to reply to this conversation.',
      maxTextLength,
      canSendTemplate: false,
      templateDisabledReason: 'You do not have permission to reply to this conversation.',
    };
  }

  if (!input.integration) {
    return {
      canSend: false,
      sendDisabledReason: `${policy.label} is not connected for this organization.`,
      maxTextLength,
      canSendTemplate: false,
      templateDisabledReason: `${policy.label} is not connected for this organization.`,
    };
  }

  if (!input.integration.enabled) {
    return {
      canSend: false,
      sendDisabledReason: `The ${policy.label} channel is switched off in settings.`,
      maxTextLength,
      canSendTemplate: false,
      templateDisabledReason: `The ${policy.label} channel is switched off in settings.`,
    };
  }

  if (input.integration.status !== 'CONNECTED') {
    // CONNECTING has never been validated; ERROR and DISCONNECTED are not
    // operational. None of them can carry a message.
    return {
      canSend: false,
      sendDisabledReason:
        input.integration.status === 'ERROR'
          ? `The ${policy.label} connection needs attention in settings.`
          : `${policy.label} is not fully connected yet.`,
      maxTextLength,
      canSendTemplate: false,
      templateDisabledReason:
        input.integration.status === 'ERROR'
          ? `The ${policy.label} connection needs attention in settings.`
          : `${policy.label} is not fully connected yet.`,
    };
  }

  /*
   * A connected integration with no stored credential cannot actually send.
   *
   * Reachable after a disconnect, which clears the token but keeps the row.
   * Checking it here means the salesperson is told before typing rather than
   * after the provider refuses.
   */
  if (input.integration.hasCredential === false) {
    return {
      canSend: false,
      sendDisabledReason: `${policy.label} needs reconnecting in settings.`,
      maxTextLength,
      canSendTemplate: false,
      templateDisabledReason: `${policy.label} needs reconnecting in settings.`,
    };
  }

  /*
   * Somebody to reply TO.
   *
   * The provider-scoped identity comes from the inbound message that opened
   * the conversation. Without it there is no valid recipient, and guessing one
   * from a phone number or a handle would address the reply to the wrong
   * person — see OmnichannelRepository.recipientFor.
   */
  if (input.hasRecipient === false) {
    return {
      canSend: false,
      sendDisabledReason: 'This conversation has no address to reply to.',
      maxTextLength,
      canSendTemplate: false,
      templateDisabledReason: 'This conversation has no address to reply to.',
    };
  }

  if (!input.lastInboundAt) {
    // No Meta channel allows opening a conversation with a free-form message.
    return {
      canSend: false,
      sendDisabledReason: `${policy.label} only allows a reply after the customer has messaged you.`,
      windowExpiresAt: null,
      maxTextLength,
      // The one refusal that does NOT also refuse templates: a template is
      // exactly how WhatsApp permits opening a conversation.
      ...templateCapability(input),
    };
  }

  const now = input.now ?? new Date();
  const expiresAt = new Date(input.lastInboundAt.getTime() + policy.windowMs);

  if (now.getTime() >= expiresAt.getTime()) {
    return {
      canSend: false,
      sendDisabledReason: `More than 24 hours have passed since the customer last wrote. ${policy.reopenRequirement}`,
      windowExpiresAt: null,
      maxTextLength,
      ...templateCapability(input),
    };
  }

  return {
    canSend: true,
    windowExpiresAt: expiresAt.toISOString(),
    maxTextLength,
    ...templateCapability(input),
  };
}

/**
 * Whether a template may be sent, given everything already checked above.
 *
 * Only called once permission, the integration and the credential have all
 * passed, so it adds exactly the two conditions templates have of their own:
 * the channel must support them, and the tenant must actually have one.
 */
function templateCapability(
  input: SendCapabilityInput,
): Pick<SendCapability, 'canSendTemplate' | 'templateDisabledReason'> {
  if (input.channel !== 'WHATSAPP') {
    // Instagram and Messenger have no template concept in their messaging
    // APIs. Offering one would be offering an action certain to fail.
    return {
      canSendTemplate: false,
      templateDisabledReason: 'Templates are only available on WhatsApp.',
    };
  }

  if (input.hasSendableTemplate === false) {
    return {
      canSendTemplate: false,
      templateDisabledReason:
        'No approved templates are available. Templates are created and approved in Meta, ' +
        'then loaded in settings.',
    };
  }

  return { canSendTemplate: true };
}
