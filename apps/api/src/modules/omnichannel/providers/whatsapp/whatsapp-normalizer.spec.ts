import { parseWebhook } from './whatsapp-normalizer';

/**
 * Reading Meta's payloads.
 *
 * A webhook is an untrusted document from the public internet. These cases are
 * mostly about what happens when it is not the shape the documentation shows —
 * because one malformed element must never cost the valid messages delivered
 * alongside it, and Meta redelivers the whole batch on failure.
 */

function textMessage(overrides: Record<string, unknown> = {}) {
  return {
    from: '447700900123',
    id: 'wamid.HBgLNDQ3NzAwOTAwMTIz',
    timestamp: '1756000000',
    type: 'text',
    text: { body: 'Need pricing for 500kg onion powder.' },
    ...overrides,
  };
}

function webhook(messages: unknown[], extra: Record<string, unknown> = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102290129340398',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15550100000',
                phone_number_id: '106540352242922',
              },
              contacts: [{ profile: { name: 'Rahul Patil' }, wa_id: '447700900123' }],
              messages,
              ...extra,
            },
          },
        ],
      },
    ],
  };
}

describe('parseWebhook', () => {
  describe('a normal text message', () => {
    it('extracts everything ingestion needs', () => {
      const result = parseWebhook(webhook([textMessage()]));

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toMatchObject({
        externalMessageId: 'wamid.HBgLNDQ3NzAwOTAwMTIz',
        externalUserId: '447700900123',
        senderPhone: '+447700900123',
        senderName: 'Rahul Patil',
        messageType: 'TEXT',
        content: 'Need pricing for 500kg onion powder.',
        phoneNumberId: '106540352242922',
      });
    });

    it('converts the provider timestamp from seconds', () => {
      const seconds = 1_756_000_000;
      const result = parseWebhook(webhook([textMessage({ timestamp: String(seconds) })]));

      // Derived, not hand-computed: writing the ISO string out by hand is how
      // a test ends up asserting the author's arithmetic instead of the code's.
      expect(result.messages[0]?.timestamp.getTime()).toBe(seconds * 1000);
    });

    it('carries the business account id for diagnostics', () => {
      const result = parseWebhook(webhook([textMessage()]));
      expect(result.messages[0]?.businessAccountId).toBe('102290129340398');
    });
  });

  describe('batches', () => {
    it('reads several messages from one delivery', () => {
      const result = parseWebhook(
        webhook([
          textMessage({ id: 'wamid.1' }),
          textMessage({ id: 'wamid.2' }),
          textMessage({ id: 'wamid.3' }),
        ]),
      );

      expect(result.messages.map((m) => m.externalMessageId)).toEqual([
        'wamid.1',
        'wamid.2',
        'wamid.3',
      ]);
    });

    it('keeps the good messages when one is unreadable', () => {
      // THE case that matters. Meta redelivers the whole batch on failure, so
      // discarding two valid enquiries because of one broken element would
      // reprocess the two that worked and still never fix the third.
      const result = parseWebhook(
        webhook([textMessage({ id: 'wamid.1' }), { nonsense: true }, textMessage({ id: 'wamid.2' })]),
      );

      expect(result.messages).toHaveLength(2);
      expect(result.malformed).toBe(1);
    });

    it('reads messages across several entries', () => {
      const body = {
        object: 'whatsapp_business_account',
        entry: [
          webhook([textMessage({ id: 'wamid.a' })]).entry[0],
          webhook([textMessage({ id: 'wamid.b' })]).entry[0],
        ],
      };

      expect(parseWebhook(body).messages).toHaveLength(2);
    });
  });

  describe('events that are not messages', () => {
    it('ignores delivery and read receipts', () => {
      const result = parseWebhook(
        webhook([], { statuses: [{ id: 'wamid.1', status: 'delivered' }] }),
      );

      expect(result.messages).toHaveLength(0);
      expect(result.ignored).toBe(1);
    });

    it('ignores non-message fields such as account updates', () => {
      const body = webhook([textMessage()]);
      (body.entry[0] as { changes: { field: string }[] }).changes[0]!.field = 'account_update';

      const result = parseWebhook(body);
      expect(result.messages).toHaveLength(0);
      expect(result.ignored).toBe(1);
    });
  });

  describe('message types this phase does not read', () => {
    it.each([
      ['image', 'IMAGE'],
      ['audio', 'AUDIO'],
      ['document', 'DOCUMENT'],
      ['location', 'LOCATION'],
      ['sticker', 'STICKER'],
    ])('records %s with its real type and no content', (waType, expected) => {
      const result = parseWebhook(
        webhook([textMessage({ type: waType, text: undefined })]),
      );

      expect(result.messages[0]?.messageType).toBe(expected);
      // NOT an empty string dressed as a text message — the conversation shows
      // that something arrived without pretending to know what it said.
      expect(result.messages[0]?.content).toBeNull();
    });

    it('maps an unknown future type to OTHER rather than TEXT', () => {
      const result = parseWebhook(webhook([textMessage({ type: 'hologram' })]));

      expect(result.messages[0]?.messageType).toBe('OTHER');
      expect(result.messages[0]?.content).toBeNull();
    });
  });

  describe('malformed input', () => {
    it.each([null, undefined, 'a string', 42, []])('survives %p', (body) => {
      expect(() => parseWebhook(body)).not.toThrow();
    });

    it('refuses a change with no phone number id', () => {
      const body = webhook([textMessage()]);
      // Without the receiving number there is no way to know which tenant this
      // belongs to, and guessing is what must never happen.
      delete (body.entry[0] as never as { changes: { value: { metadata?: unknown } }[] }).changes[0]!
        .value.metadata;

      const result = parseWebhook(body);
      expect(result.messages).toHaveLength(0);
      expect(result.malformed).toBe(1);
    });

    it('drops a message with no id, which could not be deduplicated', () => {
      const result = parseWebhook(webhook([textMessage({ id: undefined })]));
      expect(result.messages).toHaveLength(0);
      expect(result.malformed).toBe(1);
    });

    it('drops a message with no sender', () => {
      const result = parseWebhook(webhook([textMessage({ from: undefined })]));
      expect(result.messages).toHaveLength(0);
    });

    it('falls back to now rather than losing a message to a bad timestamp', () => {
      const before = Date.now();
      const result = parseWebhook(webhook([textMessage({ timestamp: 'not-a-number' })]));

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]!.timestamp.getTime()).toBeGreaterThanOrEqual(before);
    });

    it('handles a message with no matching profile name', () => {
      const body = webhook([textMessage({ from: '447700900999' })]);
      const result = parseWebhook(body);

      expect(result.messages[0]?.senderName).toBeUndefined();
      expect(result.messages[0]?.externalUserId).toBe('447700900999');
    });
  });
});
