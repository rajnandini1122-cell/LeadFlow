import { parseInstagramWebhook } from './instagram-normalizer';

/**
 * Reading Instagram's payloads.
 *
 * These cases exist mostly to pin down the ways Instagram differs from
 * WhatsApp — a Messenger-shaped envelope, millisecond timestamps, and echoes of
 * the business's own messages arriving on the same webhook. Each of those fails
 * quietly rather than loudly if it is got wrong.
 */

const ACCOUNT_ID = '17841400008460056';
const SENDER_ID = '1234567890123456';

function messagingEvent(overrides: Record<string, unknown> = {}) {
  return {
    sender: { id: SENDER_ID },
    recipient: { id: ACCOUNT_ID },
    timestamp: 1756000000000,
    message: { mid: 'mid.abc123', text: 'Need pricing for 500kg onion powder.' },
    ...overrides,
  };
}

function webhook(events: unknown[], accountId = ACCOUNT_ID, object = 'instagram') {
  return {
    object,
    entry: [{ id: accountId, time: 1756000000000, messaging: events }],
  };
}

describe('parseInstagramWebhook', () => {
  describe('a normal text DM', () => {
    it('extracts everything ingestion needs', () => {
      const result = parseInstagramWebhook(webhook([messagingEvent()]));

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual({
        externalMessageId: 'mid.abc123',
        externalUserId: SENDER_ID,
        messageType: 'TEXT',
        content: 'Need pricing for 500kg onion powder.',
        timestamp: new Date(1756000000000),
        instagramAccountId: ACCOUNT_ID,
      });
    });

    it('reads the timestamp as MILLISECONDS, not seconds', () => {
      const millis = 1_756_000_000_000;
      const result = parseInstagramWebhook(
        webhook([messagingEvent({ timestamp: millis })]),
      );

      // The difference from WhatsApp that fails most quietly: read as seconds
      // this lands roughly fifty thousand years in the future.
      expect(result.messages[0]?.timestamp.getTime()).toBe(millis);
      expect(result.messages[0]?.timestamp.getUTCFullYear()).toBe(2025);
    });

    it('takes the tenant key from the entry, not from the payload elsewhere', () => {
      const result = parseInstagramWebhook(webhook([messagingEvent()], '17841400009999999'));
      expect(result.messages[0]?.instagramAccountId).toBe('17841400009999999');
    });
  });

  describe('events that are not inbound messages', () => {
    it('ignores an echo of a message the business sent', () => {
      // Instagram reflects our own outgoing messages back. Ingesting one would
      // create a conversation with the business as the customer.
      const result = parseInstagramWebhook(
        webhook([
          messagingEvent({
            sender: { id: ACCOUNT_ID },
            recipient: { id: SENDER_ID },
            message: { mid: 'mid.echo', text: 'Thanks for your enquiry.', is_echo: true },
          }),
        ]),
      );

      expect(result.messages).toHaveLength(0);
      expect(result.ignored).toBe(1);
    });

    it('ignores a deletion', () => {
      const result = parseInstagramWebhook(
        webhook([messagingEvent({ message: { mid: 'mid.x', is_deleted: true } })]),
      );

      expect(result.messages).toHaveLength(0);
      expect(result.ignored).toBe(1);
    });

    it.each([
      ['a reaction', { reaction: { mid: 'mid.x', action: 'react', emoji: '❤' } }],
      ['a read receipt', { read: { mid: 'mid.x' } }],
      ['a postback', { postback: { mid: 'mid.x', title: 'Get started' } }],
    ])('ignores %s', (_label, extra) => {
      const event = { sender: { id: SENDER_ID }, recipient: { id: ACCOUNT_ID }, timestamp: 1, ...extra };
      const result = parseInstagramWebhook(webhook([event]));

      expect(result.messages).toHaveLength(0);
      expect(result.ignored).toBe(1);
    });

    it('ignores a webhook for a different Meta product entirely', () => {
      const result = parseInstagramWebhook(
        webhook([messagingEvent()], ACCOUNT_ID, 'whatsapp_business_account'),
      );

      expect(result.messages).toHaveLength(0);
      expect(result.ignored).toBe(1);
    });
  });

  describe('message types this phase does not read', () => {
    it.each([
      ['image', 'IMAGE'],
      ['video', 'VIDEO'],
      ['audio', 'AUDIO'],
      ['file', 'DOCUMENT'],
    ])('records a %s attachment with its real type and no content', (type, expected) => {
      const result = parseInstagramWebhook(
        webhook([
          messagingEvent({
            message: { mid: 'mid.att', attachments: [{ type, payload: { url: 'https://x' } }] },
          }),
        ]),
      );

      expect(result.messages[0]?.messageType).toBe(expected);
      // NOT an empty string dressed as a text message.
      expect(result.messages[0]?.content).toBeNull();
    });

    it('records a story reply as OTHER rather than guessing', () => {
      const result = parseInstagramWebhook(
        webhook([
          messagingEvent({
            message: { mid: 'mid.story', reply_to: { story: { id: 's1', url: 'https://x' } } },
          }),
        ]),
      );

      expect(result.messages[0]?.messageType).toBe('OTHER');
      expect(result.messages[0]?.content).toBeNull();
    });

    it('records an unknown future attachment type as OTHER', () => {
      const result = parseInstagramWebhook(
        webhook([messagingEvent({ message: { mid: 'mid.new', attachments: [{ type: 'hologram' }] } })]),
      );

      expect(result.messages[0]?.messageType).toBe('OTHER');
    });

    it('does not download anything for an attachment', () => {
      // Nothing in the normalizer touches the network. The payload URL is read
      // for its type and otherwise left alone.
      const result = parseInstagramWebhook(
        webhook([
          messagingEvent({
            message: { mid: 'mid.att', attachments: [{ type: 'image', payload: { url: 'https://x' } }] },
          }),
        ]),
      );

      expect(JSON.stringify(result.messages[0])).not.toContain('https://x');
    });
  });

  describe('batches', () => {
    it('reads several events from one delivery', () => {
      const result = parseInstagramWebhook(
        webhook([
          messagingEvent({ message: { mid: 'mid.1', text: 'one' } }),
          messagingEvent({ message: { mid: 'mid.2', text: 'two' } }),
        ]),
      );

      expect(result.messages.map((m) => m.externalMessageId)).toEqual(['mid.1', 'mid.2']);
    });

    it('keeps the good events when one is unreadable', () => {
      const result = parseInstagramWebhook(
        webhook([
          messagingEvent({ message: { mid: 'mid.1', text: 'one' } }),
          // Not an object at all — genuinely unreadable.
          'garbage',
          messagingEvent({ message: { mid: 'mid.2', text: 'two' } }),
        ]),
      );

      expect(result.messages).toHaveLength(2);
      expect(result.malformed).toBe(1);
    });

    it('treats an event shape it does not recognise as ignored, not malformed', () => {
      // An object with no `message` is indistinguishable from the reactions and
      // receipts we deliberately skip. Both must be no-ops, and neither is a
      // parsing failure worth alerting on.
      const result = parseInstagramWebhook(
        webhook([
          messagingEvent({ message: { mid: 'mid.1', text: 'one' } }),
          { some_future_event: { id: 'x' } },
        ]),
      );

      expect(result.messages).toHaveLength(1);
      expect(result.ignored).toBe(1);
      expect(result.malformed).toBe(0);
    });

    it('separates an echo from a real message in the same batch', () => {
      const result = parseInstagramWebhook(
        webhook([
          messagingEvent({ message: { mid: 'mid.echo', text: 'ours', is_echo: true } }),
          messagingEvent({ message: { mid: 'mid.real', text: 'theirs' } }),
        ]),
      );

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.externalMessageId).toBe('mid.real');
      expect(result.ignored).toBe(1);
    });

    it('reads events across several entries', () => {
      const result = parseInstagramWebhook({
        object: 'instagram',
        entry: [
          { id: ACCOUNT_ID, messaging: [messagingEvent({ message: { mid: 'mid.a', text: 'a' } })] },
          { id: ACCOUNT_ID, messaging: [messagingEvent({ message: { mid: 'mid.b', text: 'b' } })] },
        ],
      });

      expect(result.messages).toHaveLength(2);
    });
  });

  describe('malformed input', () => {
    it.each([null, undefined, 'a string', 42, []])('survives %p', (body) => {
      expect(() => parseInstagramWebhook(body)).not.toThrow();
    });

    it('refuses an entry with no account id, rather than guessing a tenant', () => {
      const result = parseInstagramWebhook({
        object: 'instagram',
        entry: [{ messaging: [messagingEvent()] }],
      });

      expect(result.messages).toHaveLength(0);
      expect(result.malformed).toBe(1);
    });

    it('drops a message with no mid, which could not be deduplicated', () => {
      const result = parseInstagramWebhook(
        webhook([messagingEvent({ message: { text: 'hello' } })]),
      );

      expect(result.messages).toHaveLength(0);
      expect(result.malformed).toBe(1);
    });

    it('drops a message with no sender', () => {
      const result = parseInstagramWebhook(webhook([messagingEvent({ sender: undefined })]));

      expect(result.messages).toHaveLength(0);
      expect(result.malformed).toBe(1);
    });

    it('falls back to now rather than losing a message to a bad timestamp', () => {
      const before = Date.now();
      const result = parseInstagramWebhook(
        webhook([messagingEvent({ timestamp: 'not-a-number' })]),
      );

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]!.timestamp.getTime()).toBeGreaterThanOrEqual(before);
    });
  });
});
