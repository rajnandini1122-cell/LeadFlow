import type { MessageType } from '../../../../generated/prisma/enums';

/**
 * Instagram Direct Message payloads, turned into events the platform knows.
 *
 * Instagram is NOT WhatsApp wearing a different hat, and copying that
 * normalizer would have been wrong in three ways that all fail quietly:
 *
 *   * the envelope is Messenger-shaped — `entry[].messaging[]`, not
 *     `entry[].changes[].value.messages[]`
 *   * timestamps are MILLISECONDS, where WhatsApp sends seconds as a string.
 *     Reading one as the other puts messages in 1970 or in the year 57000, and
 *     either way the conversation orders itself wrongly
 *   * the business's own outgoing messages come back as echoes on the same
 *     webhook, which WhatsApp does not do at all
 *
 * Everything downstream is unchanged: identity resolution, lead matching,
 * ownership and the review queue never learn that Instagram exists.
 */

/** One inbound DM, before a tenant has been established. */
export interface InstagramInboundMessage {
  /** Meta's message id — `mid.*`. The idempotency key. */
  externalMessageId: string;
  /** The sender's Instagram-scoped id. Stable for this app and this user. */
  externalUserId: string;
  messageType: MessageType;
  /** Present for text; null for anything this phase does not read. */
  content: string | null;
  timestamp: Date;
  /** The business account that received it — resolves the tenant. */
  instagramAccountId: string;
}

export interface ParsedInstagramWebhook {
  messages: InstagramInboundMessage[];
  /**
   * Events understood and deliberately not acted on: echoes of our own
   * messages, reactions, read receipts, deletions.
   */
  ignored: number;
  /** Events that could not be read at all. Counted, never guessed at. */
  malformed: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Instagram sends milliseconds since the epoch, as a number.
 *
 * The single most important difference from the WhatsApp normalizer. Treating
 * these as seconds would place every message roughly fifty thousand years in
 * the future, which sorts a conversation into nonsense and leaves the
 * 24-hour-window arithmetic elsewhere meaningless.
 */
function parseTimestamp(value: unknown): Date {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return new Date();

  return new Date(milliseconds);
}

/**
 * Which of Meta's attachment kinds we can name honestly.
 *
 * Anything absent maps to OTHER rather than TEXT — a shared reel recorded as a
 * text message would appear on a lead's timeline as though the customer had
 * written nothing, which is worse than recording that something arrived we do
 * not yet display.
 */
const ATTACHMENT_TYPES: Record<string, MessageType> = {
  image: 'IMAGE',
  video: 'VIDEO',
  audio: 'AUDIO',
  file: 'DOCUMENT',
  location: 'LOCATION',
};

/**
 * Every inbound DM in a webhook body.
 *
 * One delivery routinely carries several entries, each with several messaging
 * events, mixed with echoes and reactions that are not inbound messages at all.
 * Each is handled independently so one unreadable element cannot discard the
 * rest — Meta redelivers the whole batch on failure, so discarding the good
 * ones means reprocessing them and still never fixing the bad one.
 */
export function parseInstagramWebhook(body: unknown): ParsedInstagramWebhook {
  const result: ParsedInstagramWebhook = { messages: [], ignored: 0, malformed: 0 };

  const root = asRecord(body);
  if (!root) {
    result.malformed += 1;
    return result;
  }

  // Meta sends the same envelope shape for several products. Anything that is
  // not Instagram is not ours to interpret.
  if (asString(root['object']) !== 'instagram') {
    result.ignored += 1;
    return result;
  }

  for (const entryValue of asArray(root['entry'])) {
    const entry = asRecord(entryValue);
    if (!entry) {
      result.malformed += 1;
      continue;
    }

    /*
     * The business's own Instagram account id.
     *
     * This is what resolves the tenant. `recipient.id` on each event carries
     * the same value for an inbound message, but entry.id is the one Meta
     * documents as the subscribed account, so it is the one trusted here.
     */
    const accountId = asString(entry['id']);
    if (!accountId) {
      result.malformed += 1;
      continue;
    }

    for (const eventValue of asArray(entry['messaging'])) {
      const event = asRecord(eventValue);
      if (!event) {
        result.malformed += 1;
        continue;
      }

      const parsed = parseMessagingEvent(event, accountId);

      if (parsed === 'IGNORED') result.ignored += 1;
      else if (parsed === null) result.malformed += 1;
      else result.messages.push(parsed);
    }
  }

  return result;
}

/**
 * One messaging event.
 *
 * @returns the message, `'IGNORED'` for something understood but not acted on,
 *   or `null` for something unreadable.
 */
function parseMessagingEvent(
  event: Record<string, unknown>,
  accountId: string,
): InstagramInboundMessage | 'IGNORED' | null {
  /*
   * Reactions, read receipts and postbacks share this envelope.
   *
   * Understood, and deliberately not stored: a heart on a message is not
   * correspondence, and turning one into a blank message would put noise on a
   * lead's timeline that nobody can act on.
   */
  if (!event['message']) return 'IGNORED';

  const message = asRecord(event['message']);
  if (!message) return null;

  /*
   * Echoes — messages the BUSINESS sent, reflected back.
   *
   * Instagram does this and WhatsApp does not. Ingesting one would create a
   * conversation with the business as the customer, resolve the business's own
   * account as a contact, and potentially open a lead against itself.
   */
  if (message['is_echo'] === true) return 'IGNORED';

  // A deletion is a statement about a message we already stored, not a new
  // one. Acting on it is out of scope; misreading it as a message is not.
  if (message['is_deleted'] === true) return 'IGNORED';

  const sender = asRecord(event['sender']);
  const externalUserId = asString(sender?.['id']);
  const externalMessageId = asString(message['mid']);

  /*
   * Both are required.
   *
   * The mid is what makes redelivery safe; the sender is what makes the
   * message attributable. Without either it cannot be stored usefully, and
   * storing it anyway would create a row nothing can ever deduplicate.
   */
  if (!externalUserId || !externalMessageId) return null;

  const text = asString(message['text']);

  if (text) {
    return {
      externalMessageId,
      externalUserId,
      messageType: 'TEXT',
      content: text,
      timestamp: parseTimestamp(event['timestamp']),
      instagramAccountId: accountId,
    };
  }

  /*
   * Not text: an attachment, a story reply, a shared post.
   *
   * Recorded with its real type and NO content. The conversation shows that
   * something arrived and when, without pretending to know what it said —
   * and without downloading media, which is out of scope for this phase.
   */
  const attachments = asArray(message['attachments']);
  const first = asRecord(attachments[0]);
  const attachmentType = asString(first?.['type']);

  return {
    externalMessageId,
    externalUserId,
    messageType: (attachmentType ? ATTACHMENT_TYPES[attachmentType] : undefined) ?? 'OTHER',
    content: null,
    timestamp: parseTimestamp(event['timestamp']),
    instagramAccountId: accountId,
  };
}
