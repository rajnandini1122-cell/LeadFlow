import type { MessageType } from '../../../../generated/prisma/enums';

/**
 * WhatsApp Cloud API payloads, turned into events the platform already knows.
 *
 * Everything downstream of this file — identity resolution, lead matching,
 * ownership, the inbox — is channel-agnostic and predates WhatsApp entirely.
 * This is the only place that knows what Meta's JSON looks like, which is what
 * keeps "add Instagram later" a new file rather than a rewrite.
 *
 * Parsed defensively throughout. A webhook is an untrusted document from the
 * public internet: fields are missing, types are unexpected, and one malformed
 * message must not cost the valid ones in the same batch.
 */

/** One inbound message, before a tenant has been established. */
export interface WhatsAppInboundMessage {
  /** Meta's message id — `wamid.*`. The idempotency key. */
  externalMessageId: string;
  /** The customer's WhatsApp id, which is their phone number in E.164 digits. */
  externalUserId: string;
  senderPhone: string;
  senderName?: string | undefined;
  messageType: MessageType;
  /** Present for text; null for types this phase does not read. */
  content: string | null;
  timestamp: Date;
  /** The business number that received it — resolves the tenant. */
  phoneNumberId: string;
  businessAccountId?: string | undefined;
}

export interface ParsedWebhook {
  messages: WhatsAppInboundMessage[];
  /** Events understood but not acted on — delivery receipts, reactions. */
  ignored: number;
  /** Events that could not be read at all. Counted, never guessed at. */
  malformed: number;
}

/**
 * Meta's message `type` to ours.
 *
 * An unmapped type becomes OTHER rather than TEXT. Calling a voice note a text
 * message would put an empty string on a lead's timeline as though the customer
 * had said nothing, which is worse than recording that something arrived we do
 * not yet display.
 */
const MESSAGE_TYPES: Record<string, MessageType> = {
  text: 'TEXT',
  image: 'IMAGE',
  video: 'VIDEO',
  audio: 'AUDIO',
  document: 'DOCUMENT',
  location: 'LOCATION',
  sticker: 'STICKER',
  template: 'TEMPLATE',
};

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
 * Meta sends seconds since the epoch, as a string.
 *
 * A missing or unreadable timestamp falls back to now rather than rejecting the
 * message: losing a customer enquiry over a malformed date field would be the
 * wrong trade, and the message still carries its own provider id.
 */
function parseTimestamp(value: unknown): Date {
  const seconds = Number(asString(value) ?? value);
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date();

  return new Date(seconds * 1000);
}

/**
 * Every inbound message in a webhook body.
 *
 * One request routinely carries several entries, each with several changes,
 * each with several messages — and mixes them with status callbacks that are
 * not messages at all. Each is handled independently so a single unreadable
 * element cannot discard the rest.
 */
export function parseWebhook(body: unknown): ParsedWebhook {
  const result: ParsedWebhook = { messages: [], ignored: 0, malformed: 0 };

  const root = asRecord(body);
  if (!root) {
    result.malformed += 1;
    return result;
  }

  for (const entryValue of asArray(root['entry'])) {
    const entry = asRecord(entryValue);
    if (!entry) {
      result.malformed += 1;
      continue;
    }

    // The WhatsApp Business Account id. Recorded for diagnostics; it is NOT
    // what resolves the tenant — the phone number id is.
    const businessAccountId = asString(entry['id']);

    for (const changeValue of asArray(entry['changes'])) {
      const change = asRecord(changeValue);
      if (!change) {
        result.malformed += 1;
        continue;
      }

      // Meta uses this endpoint for account updates, template reviews and
      // more. Anything that is not a message event is not our business.
      if (asString(change['field']) !== 'messages') {
        result.ignored += 1;
        continue;
      }

      const value = asRecord(change['value']);
      if (!value) {
        result.malformed += 1;
        continue;
      }

      const metadata = asRecord(value['metadata']);
      const phoneNumberId = asString(metadata?.['phone_number_id']);

      // Without the receiving number there is no way to know which tenant this
      // belongs to, and guessing is exactly what must never happen.
      if (!phoneNumberId) {
        result.malformed += 1;
        continue;
      }

      // Profile names arrive alongside, keyed by the customer's wa_id.
      const names = new Map<string, string>();
      for (const contactValue of asArray(value['contacts'])) {
        const contact = asRecord(contactValue);
        const waId = asString(contact?.['wa_id']);
        const profile = asRecord(contact?.['profile']);
        const name = asString(profile?.['name']);
        if (waId && name) names.set(waId, name);
      }

      const messages = asArray(value['messages']);

      // Delivery and read receipts share this shape but carry `statuses`
      // instead. Understood, and deliberately not acted on in this phase.
      if (messages.length === 0) {
        if (asArray(value['statuses']).length > 0) result.ignored += 1;
        continue;
      }

      for (const messageValue of messages) {
        const parsed = parseMessage(messageValue, {
          phoneNumberId,
          ...(businessAccountId ? { businessAccountId } : {}),
          names,
        });

        if (parsed) result.messages.push(parsed);
        else result.malformed += 1;
      }
    }
  }

  return result;
}

function parseMessage(
  raw: unknown,
  context: {
    phoneNumberId: string;
    businessAccountId?: string | undefined;
    names: Map<string, string>;
  },
): WhatsAppInboundMessage | null {
  const message = asRecord(raw);
  if (!message) return null;

  const externalMessageId = asString(message['id']);
  const from = asString(message['from']);

  // Both are required. The id is what makes redelivery safe and the sender is
  // what makes the message attributable; without either it cannot be stored
  // usefully or safely.
  if (!externalMessageId || !from) return null;

  const rawType = asString(message['type']) ?? 'unknown';
  const messageType = MESSAGE_TYPES[rawType] ?? 'OTHER';

  // Only text is read in this phase. Everything else is recorded with its type
  // and no content — the conversation shows that something arrived, without
  // pretending to know what it said.
  let content: string | null = null;
  if (rawType === 'text') {
    content = asString(asRecord(message['text'])?.['body']) ?? null;
  }

  const senderName = context.names.get(from);

  return {
    externalMessageId,
    // wa_id is the customer's number without a plus. It is stable, and it is
    // the identity key the platform already uses for WhatsApp.
    externalUserId: from,
    senderPhone: `+${from.replace(/^\+/, '')}`,
    ...(senderName ? { senderName } : {}),
    messageType,
    content,
    timestamp: parseTimestamp(message['timestamp']),
    phoneNumberId: context.phoneNumberId,
    ...(context.businessAccountId ? { businessAccountId: context.businessAccountId } : {}),
  };
}
