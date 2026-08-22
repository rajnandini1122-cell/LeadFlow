import type { ChannelType, MessageType } from '../../generated/prisma/enums';

/**
 * The single shape every provider normalises into.
 *
 * Nothing downstream of this knows whether a message came from WhatsApp,
 * Messenger or an Instagram DM. That is the whole point of the abstraction:
 * when the Meta integration lands in Phase E it produces these, and the
 * matching and linking below it does not change.
 *
 * `organizationId` is present because the caller has already resolved the
 * integration — a webhook itself carries no tenant, only a provider account id.
 * It is NOT trusted as authorization: ingestion pins the tenant scope to it and
 * the Prisma extension overwrites any organizationId that reaches a write.
 */
export interface NormalizedChannelEvent {
  organizationId: string;
  integrationId: string;
  channel: ChannelType;

  /** Provider ids. Both are required — they are what makes replay safe. */
  externalMessageId: string;
  externalConversationId: string;
  /** The provider's stable id for the person. Present on every channel. */
  externalUserId: string;

  senderName?: string | undefined;
  senderUsername?: string | undefined;
  /** Raw, as the provider gave it. Canonicalised during resolution. */
  senderPhone?: string | undefined;

  content?: string | undefined;
  messageType?: MessageType | undefined;
  timestamp: Date;
}

/** What happened to the contact behind an incoming message. */
export type ContactResolution =
  | { outcome: 'MATCHED'; contactId: string; createdIdentity: boolean }
  /**
   * Nobody could be identified with confidence. Deliberately not an error and
   * deliberately not a new contact: the message is still stored, and a person
   * decides who it is.
   */
  | { outcome: 'UNRESOLVED'; reason: string };

/** The outcome of ingesting one message. Returned for tests and for the UI. */
export interface IngestionResult {
  conversationId: string;
  messageId: string;
  /** False when this exact message had already been ingested. */
  created: boolean;
  contact: ContactResolution;
  leadId: string | null;
  linkState: 'UNLINKED' | 'LINKED' | 'REVIEW_REQUIRED';
  /** Populated only when linkState is REVIEW_REQUIRED. */
  candidateLeadIds: string[];
}
