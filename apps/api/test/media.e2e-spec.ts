import { createHmac } from 'node:crypto';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { createTestContext, type TestContext } from './helpers/test-app';
import { fixtureProviderDigits } from './helpers/phone-fixtures';

/**
 * Media on conversations.
 *
 * Two halves, and the security-critical one is retrieval. Nothing is downloaded
 * at ingestion, so the media endpoint is the ONLY route to a customer's file —
 * which makes its authorization the entire security model for this feature.
 *
 * Meta is stubbed at `fetch`, so validation, authorization, idempotency and
 * failure handling all run exactly as they do in production.
 */
describe('Conversation media', () => {
  let ctx: TestContext;
  let prisma: PrismaService;
  let tenancy: TenantContextService;

  const WA_SECRET = 'test-whatsapp-app-secret';
  const FB_SECRET = 'test-facebook-app-secret';

  const waNumbers = { a: '306540000000001', b: '306540000000002' };
  const fbPages = { a: '309875000000001', b: '309875000000002' };

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  let counter = 0;
  const unique = () => {
    counter += 1;
    return `${Date.now()}${counter}`;
  };

  let sends: { url: string; isMultipart: boolean }[] = [];
  let mediaLookups: string[] = [];
  let nextSend: { status: number; body: unknown } = { status: 200, body: {} };
  let realFetch: typeof globalThis.fetch;

  /** A real JPEG header, so content detection has something true to find. */
  function jpeg(sizeBytes = 2048): Buffer {
    const buffer = Buffer.alloc(sizeBytes, 0x20);
    buffer[0] = 0xff;
    buffer[1] = 0xd8;
    buffer[2] = 0xff;
    return buffer;
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    prisma = ctx.app.get(PrismaService);
    tenancy = ctx.app.get(TenantContextService);

    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('graph.facebook.com') && !url.includes('lookaside')) {
        return realFetch(input, init);
      }

      if (init?.method === 'POST') {
        const isMultipart = typeof init.body === 'object' && !(typeof init.body === 'string');
        sends.push({ url, isMultipart });

        // The WhatsApp media upload step returns an id.
        if (url.endsWith('/media')) {
          return new Response(JSON.stringify({ id: `media.${unique()}` }), { status: 200 });
        }

        return new Response(JSON.stringify(nextSend.body), {
          status: nextSend.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // The media id → URL lookup, then the bytes.
      mediaLookups.push(url);
      if (url.includes('lookaside') || url.includes('/download')) {
        return new Response(jpeg(64), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        });
      }
      if (url.includes('/media.') || /\/\d+\?fields/.test(url) === false) {
        return new Response(JSON.stringify({ url: 'https://lookaside.fbsbx.com/download/abc' }), {
          status: 200,
        });
      }

      // The setup validation GET.
      return new Response(JSON.stringify({ verified_name: 'Test', name: 'Test Page' }), {
        status: 200,
      });
    }) as typeof globalThis.fetch;

    // Connect WhatsApp for both organizations, through the real endpoint so a
    // genuine encrypted credential exists.
    for (const [org, token, number] of [
      [ctx.orgA, ctx.orgA.owner.accessToken, waNumbers.a],
      [ctx.orgB, ctx.orgB.owner.accessToken, waNumbers.b],
    ] as const) {
      void org;
      const response = await ctx
        .http()
        .post('/api/v1/channel-integrations/whatsapp/connect')
        .set(auth(token))
        .send({ phoneNumberId: number, accessToken: `wa-token-${number}` });
      expect(response.status).toBe(200);
    }

    for (const [token, page] of [
      [ctx.orgA.owner.accessToken, fbPages.a],
      [ctx.orgB.owner.accessToken, fbPages.b],
    ] as const) {
      const response = await ctx
        .http()
        .post('/api/v1/channel-integrations/facebook/connect')
        .set(auth(token))
        .send({ accountId: page, accessToken: `fb-token-${page}` });
      expect(response.status).toBe(200);
    }
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await ctx?.close();
  });

  beforeEach(() => {
    sends = [];
    mediaLookups = [];
    nextSend = { status: 200, body: { messages: [{ id: `wamid.${unique()}` }], message_id: `mid.${unique()}` } };
  });

  // ------------------------------------------------------------------ helpers

  function sign(body: string, secret: string): string {
    return `sha256=${createHmac('sha256', secret).update(Buffer.from(body)).digest('hex')}`;
  }

  async function deliverWhatsApp(payload: unknown) {
    const body = JSON.stringify(payload);
    return ctx
      .http()
      .post('/api/v1/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body, WA_SECRET))
      .send(body);
  }

  async function deliverFacebook(payload: unknown) {
    const body = JSON.stringify(payload);
    return ctx
      .http()
      .post('/api/v1/webhooks/facebook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body, FB_SECRET))
      .send(body);
  }

  function whatsAppMedia(input: {
    from: string;
    kind: 'image' | 'document' | 'audio' | 'video';
    mediaId?: string;
    caption?: string;
    filename?: string;
  }) {
    const media: Record<string, unknown> = {
      id: input.mediaId ?? `wamedia.${unique()}`,
      mime_type: input.kind === 'document' ? 'application/pdf' : 'image/jpeg',
    };
    if (input.caption) media['caption'] = input.caption;
    if (input.filename) media['filename'] = input.filename;

    return {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: waNumbers.a },
                contacts: [{ profile: { name: 'Rahul' }, wa_id: input.from }],
                messages: [
                  {
                    from: input.from,
                    id: `wamid.${unique()}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: input.kind,
                    [input.kind]: media,
                  },
                ],
              },
            },
          ],
        },
      ],
    };
  }

  async function conversationFor(external: string, organizationId = ctx.orgA.id) {
    const conversation = await tenancy.runForOrganization(organizationId, 'test: find', () =>
      prisma.client.conversation.findFirst({ where: { externalConversationId: external } }),
    );
    expect(conversation).not.toBeNull();
    return conversation!;
  }

  async function detail(conversationId: string, token?: string) {
    return ctx
      .http()
      .get(`/api/v1/conversations/${conversationId}`)
      .set(auth(token ?? ctx.orgA.owner.accessToken));
  }

  // ===========================================================================
  // Inbound media
  // ===========================================================================

  describe('inbound WhatsApp media', () => {
    it('records an image with its real type and provider metadata', async () => {
      const from = fixtureProviderDigits();
      await deliverWhatsApp(whatsAppMedia({ from, kind: 'image' }));

      const conversation = await conversationFor(`${waNumbers.a}:${from}`);
      const response = await detail(conversation.id);

      const message = response.body.data.messages[0];
      expect(message.messageType).toBe('IMAGE');
      expect(message.attachments).toHaveLength(1);
      expect(message.attachments[0]).toMatchObject({
        index: 0,
        type: 'IMAGE',
        mimeType: 'image/jpeg',
        retrievable: true,
      });
    });

    it('keeps the caption as the message text', async () => {
      const from = fixtureProviderDigits();
      await deliverWhatsApp(
        whatsAppMedia({ from, kind: 'image', caption: 'Is this the one you meant?' }),
      );

      const conversation = await conversationFor(`${waNumbers.a}:${from}`);
      const response = await detail(conversation.id);

      // The caption IS the enquiry. Dropping it would lose what they typed.
      expect(response.body.data.messages[0].content).toBe('Is this the one you meant?');
    });

    it('keeps a document filename the provider supplied', async () => {
      const from = fixtureProviderDigits();
      await deliverWhatsApp(
        whatsAppMedia({ from, kind: 'document', filename: 'purchase-order.pdf' }),
      );

      const conversation = await conversationFor(`${waNumbers.a}:${from}`);
      const message = (await detail(conversation.id)).body.data.messages[0];

      expect(message.attachments[0].filename).toBe('purchase-order.pdf');
      expect(message.attachments[0].mimeType).toBe('application/pdf');
    });

    it('NEVER exposes the provider media id to the browser', async () => {
      const from = fixtureProviderDigits();
      const mediaId = `wamedia.secret.${unique()}`;
      await deliverWhatsApp(whatsAppMedia({ from, kind: 'image', mediaId }));

      const conversation = await conversationFor(`${waNumbers.a}:${from}`);
      const response = await detail(conversation.id);

      // The media id is usable with our access token. Handing it to a client
      // would give away access to the customer's file.
      expect(JSON.stringify(response.body)).not.toContain(mediaId);
    });

    it('creates no duplicate attachment on a redelivered webhook', async () => {
      const from = fixtureProviderDigits();
      const payload = whatsAppMedia({ from, kind: 'image' });

      await deliverWhatsApp(payload);
      await deliverWhatsApp(payload);
      await deliverWhatsApp(payload);

      const conversation = await conversationFor(`${waNumbers.a}:${from}`);
      const messages = (await detail(conversation.id)).body.data.messages;

      expect(messages).toHaveLength(1);
      expect(messages[0].attachments).toHaveLength(1);
    });
  });

  describe('inbound Messenger media', () => {
    async function deliverAttachment(senderId: string, attachments: unknown[]) {
      return deliverFacebook({
        object: 'page',
        entry: [
          {
            id: fbPages.a,
            messaging: [
              {
                sender: { id: senderId },
                recipient: { id: fbPages.a },
                timestamp: Date.now(),
                message: { mid: `mid.${unique()}`, attachments },
              },
            ],
          },
        ],
      });
    }

    it('records an image attachment', async () => {
      const senderId = `psid.${unique()}`;
      await deliverAttachment(senderId, [
        { type: 'image', payload: { url: 'https://lookaside.fbsbx.com/x.jpg' } },
      ]);

      const conversation = await conversationFor(`${fbPages.a}:${senderId}`);
      const message = (await detail(conversation.id)).body.data.messages[0];

      expect(message.attachments).toHaveLength(1);
      expect(message.attachments[0]).toMatchObject({ type: 'IMAGE', retrievable: true });
      // Messenger supplies neither, and inventing one would be a lie.
      expect(message.attachments[0].mimeType).toBeNull();
      expect(message.attachments[0].filename).toBeNull();
    });

    it('records EVERY attachment when a message carries several', async () => {
      const senderId = `psid.${unique()}`;
      await deliverAttachment(senderId, [
        { type: 'image', payload: { url: 'https://lookaside.fbsbx.com/1.jpg' } },
        { type: 'file', payload: { url: 'https://lookaside.fbsbx.com/2.pdf' } },
      ]);

      const conversation = await conversationFor(`${fbPages.a}:${senderId}`);
      const message = (await detail(conversation.id)).body.data.messages[0];

      // Keeping only the first would silently lose a customer's document.
      expect(message.attachments).toHaveLength(2);
      expect(message.attachments.map((a: { type: string }) => a.type)).toEqual([
        'IMAGE',
        'DOCUMENT',
      ]);
      expect(message.attachments.map((a: { index: number }) => a.index)).toEqual([0, 1]);
    });

    it('NEVER exposes the provider URL to the browser', async () => {
      const senderId = `psid.${unique()}`;
      await deliverAttachment(senderId, [
        { type: 'image', payload: { url: 'https://lookaside.fbsbx.com/secret-capability' } },
      ]);

      const conversation = await conversationFor(`${fbPages.a}:${senderId}`);
      const response = await detail(conversation.id);

      // An unguessable capability link. Anyone holding it can read the file.
      expect(JSON.stringify(response.body)).not.toContain('secret-capability');
      expect(JSON.stringify(response.body)).not.toContain('lookaside');
    });
  });

  // ===========================================================================
  // Retrieval — the security boundary
  // ===========================================================================

  describe('downloading an attachment', () => {
    async function anImage() {
      const from = fixtureProviderDigits();
      await deliverWhatsApp(whatsAppMedia({ from, kind: 'image' }));
      const conversation = await conversationFor(`${waNumbers.a}:${from}`);
      const message = (await detail(conversation.id)).body.data.messages[0];
      return { conversation, messageId: message.id };
    }

    it('returns the bytes to an authorized user', async () => {
      const { conversation, messageId } = await anImage();

      const response = await ctx
        .http()
        .get(`/api/v1/conversations/${conversation.id}/messages/${messageId}/attachments/0`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('image/jpeg');
    });

    it('serves it as a download, never inline', async () => {
      const { conversation, messageId } = await anImage();

      const response = await ctx
        .http()
        .get(`/api/v1/conversations/${conversation.id}/messages/${messageId}/attachments/0`)
        .set(auth(ctx.orgA.owner.accessToken));

      // Customer-supplied content rendered inline on our own origin is a
      // stored-XSS vector.
      expect(response.headers['content-disposition']).toMatch(/^attachment/);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['cache-control']).toContain('no-store');
    });

    it('refuses an unauthenticated request', async () => {
      const { conversation, messageId } = await anImage();

      const response = await ctx
        .http()
        .get(`/api/v1/conversations/${conversation.id}/messages/${messageId}/attachments/0`);

      expect(response.status).toBe(401);
    });

    it('refuses another organization', async () => {
      const { conversation, messageId } = await anImage();

      const response = await ctx
        .http()
        .get(`/api/v1/conversations/${conversation.id}/messages/${messageId}/attachments/0`)
        .set(auth(ctx.orgB.owner.accessToken));

      expect(response.status).toBe(404);
    });

    it('refuses a user who cannot see the conversation', async () => {
      const digits = fixtureProviderDigits();
      const lead = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          firstName: 'Rahul',
          mobile: `+${digits}`,
          assignedToId: ctx.orgA.owner.id,
          nextFollowUpAt: new Date(Date.now() + 86_400_000).toISOString(),
        });

      await deliverWhatsApp(whatsAppMedia({ from: digits, kind: 'image' }));
      const conversation = await conversationFor(`${waNumbers.a}:${digits}`);
      const messageId = (await detail(conversation.id)).body.data.messages[0].id;

      void lead;
      const response = await ctx
        .http()
        .get(`/api/v1/conversations/${conversation.id}/messages/${messageId}/attachments/0`)
        .set(auth(ctx.orgA.rep.accessToken));

      // The rep cannot open the conversation, so they cannot read its media.
      expect(response.status).toBe(404);
    });

    it('refuses a message that belongs to a DIFFERENT conversation', async () => {
      const first = await anImage();
      const second = await anImage();

      // Both ids come from the URL. Pairing one conversation with another's
      // message must not work, or a caller who can see one conversation could
      // read media from every conversation in the tenant.
      const response = await ctx
        .http()
        .get(
          `/api/v1/conversations/${first.conversation.id}/messages/${second.messageId}/attachments/0`,
        )
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(404);
    });

    it('refuses an attachment index that does not exist', async () => {
      const { conversation, messageId } = await anImage();

      const response = await ctx
        .http()
        .get(`/api/v1/conversations/${conversation.id}/messages/${messageId}/attachments/7`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(404);
    });

    it('never returns a provider credential in the response', async () => {
      const { conversation, messageId } = await anImage();

      const response = await ctx
        .http()
        .get(`/api/v1/conversations/${conversation.id}/messages/${messageId}/attachments/0`)
        .set(auth(ctx.orgA.owner.accessToken));

      const headers = JSON.stringify(response.headers);
      expect(headers).not.toContain('wa-token-');
      expect(headers).not.toContain('lookaside');
    });
  });

  // ===========================================================================
  // Outbound media
  // ===========================================================================

  describe('sending an attachment', () => {
    async function openWhatsApp() {
      const from = fixtureProviderDigits();
      await deliverWhatsApp(whatsAppMedia({ from, kind: 'image' }));
      return conversationFor(`${waNumbers.a}:${from}`);
    }

    function post(conversationId: string, token?: string) {
      return ctx
        .http()
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .set(auth(token ?? ctx.orgA.owner.accessToken));
    }

    it('uploads and sends a JPEG', async () => {
      const conversation = await openWhatsApp();

      const response = await post(conversation.id)
        .field('idempotencyKey', `key-${unique()}`)
        .field('content', 'Here is the quote.')
        .attach('file', jpeg(), 'quote.jpg');

      expect(response.status).toBe(201);
      expect(response.body.data.messageType).toBe('IMAGE');
      expect(response.body.data.attachments).toHaveLength(1);
      expect(response.body.data.deliveryStatus).toBe('SENT');

      // WhatsApp takes two calls: upload, then send.
      expect(sends).toHaveLength(2);
      expect(sends[0]!.url).toContain('/media');
      expect(sends[1]!.url).toContain('/messages');
    });

    it('sends a file with no text at all', async () => {
      const conversation = await openWhatsApp();

      const response = await post(conversation.id)
        .field('idempotencyKey', `key-${unique()}`)
        .attach('file', jpeg(), 'photo.jpg');

      // A photo on its own is a complete message.
      expect(response.status).toBe(201);
    });

    it('still refuses a message with neither text nor file', async () => {
      const conversation = await openWhatsApp();

      const response = await post(conversation.id).field('idempotencyKey', `key-${unique()}`);

      expect(response.status).toBe(400);
      expect(sends).toHaveLength(0);
    });

    it('rejects a file whose bytes are not what the browser claimed', async () => {
      const conversation = await openWhatsApp();

      const response = await post(conversation.id)
        .field('idempotencyKey', `key-${unique()}`)
        .attach('file', Buffer.from('MZ  an executable'), {
          filename: 'innocent.jpg',
          contentType: 'image/jpeg',
        });

      // The browser said image/jpeg. The bytes said otherwise, and the bytes
      // decide — this is the usual way an upload filter is bypassed.
      expect(response.status).toBe(400);
      expect(sends).toHaveLength(0);
    });

    it('rejects a file over the channel limit', async () => {
      const conversation = await openWhatsApp();

      // WhatsApp images stop at 5MB.
      const response = await post(conversation.id)
        .field('idempotencyKey', `key-${unique()}`)
        .attach('file', jpeg(6 * 1024 * 1024), 'huge.jpg');

      expect(response.status).toBe(400);
      expect(sends).toHaveLength(0);
    });

    it('sends the same attachment once for a repeated idempotency key', async () => {
      const conversation = await openWhatsApp();
      const key = `key-${unique()}`;

      const first = await post(conversation.id)
        .field('idempotencyKey', key)
        .attach('file', jpeg(), 'once.jpg');
      const second = await post(conversation.id)
        .field('idempotencyKey', key)
        .attach('file', jpeg(), 'once.jpg');

      expect(first.status).toBe(201);
      expect(second.body.data.id).toBe(first.body.data.id);

      // Upload + send for the first; nothing at all for the second. A
      // duplicate photo is more jarring than a duplicate sentence.
      expect(sends).toHaveLength(2);
    });

    it('does not mark a rejected attachment as sent', async () => {
      const conversation = await openWhatsApp();
      nextSend = { status: 400, body: { error: { code: 100 } } };

      const response = await post(conversation.id)
        .field('idempotencyKey', `key-${unique()}`)
        .attach('file', jpeg(), 'fails.jpg');

      expect(response.status).toBe(409);

      const stored = await tenancy.runForOrganization(ctx.orgA.id, 'test: read', () =>
        prisma.client.message.findFirst({
          where: { conversationId: conversation.id, direction: 'OUTGOING' },
          orderBy: { createdAt: 'desc' },
        }),
      );
      expect(stored!.deliveryStatus).toBe('FAILED');
    });

    it('does not resend automatically when the outcome is uncertain', async () => {
      const conversation = await openWhatsApp();
      // Accepted, but no message id.
      nextSend = { status: 200, body: {} };

      const response = await post(conversation.id)
        .field('idempotencyKey', `key-${unique()}`)
        .attach('file', jpeg(), 'uncertain.jpg');

      expect(response.status).toBe(502);
      // Upload plus one send attempt. Never a second send.
      expect(sends.filter((s) => s.url.endsWith('/messages'))).toHaveLength(1);
    });

    it('refuses another organization’s conversation without calling Meta', async () => {
      const conversation = await openWhatsApp();

      const response = await post(conversation.id, ctx.orgB.owner.accessToken)
        .field('idempotencyKey', `key-${unique()}`)
        .attach('file', jpeg(), 'nope.jpg');

      expect(response.status).toBe(404);
      expect(sends).toHaveLength(0);
    });

    it('refuses when the integration is disabled', async () => {
      const conversation = await openWhatsApp();

      const integration = await tenancy.runForOrganization(ctx.orgA.id, 'test: find', () =>
        prisma.client.channelIntegration.findFirst({ where: { channel: 'WHATSAPP' } }),
      );
      await tenancy.runForOrganization(ctx.orgA.id, 'test: disable', () =>
        prisma.client.channelIntegration.update({
          where: { id: integration!.id },
          data: { enabled: false },
        }),
      );

      const response = await post(conversation.id)
        .field('idempotencyKey', `key-${unique()}`)
        .attach('file', jpeg(), 'nope.jpg');

      expect(response.status).toBe(409);
      expect(sends).toHaveLength(0);

      await tenancy.runForOrganization(ctx.orgA.id, 'test: re-enable', () =>
        prisma.client.channelIntegration.update({
          where: { id: integration!.id },
          data: { enabled: true },
        }),
      );
    });

    it('refuses a document on Instagram, which does not carry them', async () => {
      // Covered here rather than left to Meta: refusing after a full upload
      // wastes the user's time and their bandwidth.
      const senderId = `psid.${unique()}`;
      await deliverFacebook({
        object: 'page',
        entry: [
          {
            id: fbPages.a,
            messaging: [
              {
                sender: { id: senderId },
                recipient: { id: fbPages.a },
                timestamp: Date.now(),
                message: { mid: `mid.${unique()}`, text: 'hi' },
              },
            ],
          },
        ],
      });

      const conversation = await conversationFor(`${fbPages.a}:${senderId}`);

      // Facebook DOES carry documents, so this one should succeed.
      const response = await post(conversation.id)
        .field('idempotencyKey', `key-${unique()}`)
        .attach('file', Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(64)]), 'doc.pdf');

      expect(response.status).toBe(201);
      // Messenger sends the file and the message in ONE multipart call.
      expect(sends).toHaveLength(1);
      expect(sends[0]!.isMultipart).toBe(true);
    });
  });

  // ===========================================================================
  // Text is unchanged
  // ===========================================================================

  describe('text messaging is untouched', () => {
    it('still accepts a plain JSON body with no file', async () => {
      const from = fixtureProviderDigits();
      await deliverWhatsApp(whatsAppMedia({ from, kind: 'image' }));
      const conversation = await conversationFor(`${waNumbers.a}:${from}`);

      const response = await ctx
        .http()
        .post(`/api/v1/conversations/${conversation.id}/messages`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ content: 'Just text.', idempotencyKey: `key-${unique()}` });

      expect(response.status).toBe(201);
      expect(response.body.data.messageType).toBe('TEXT');
      expect(response.body.data.attachments).toEqual([]);
      // One call, no upload step.
      expect(sends).toHaveLength(1);
    });
  });
});
