import { createHmac } from 'node:crypto';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { createTestContext, type TestContext } from './helpers/test-app';
import { fixtureProviderDigits } from './helpers/phone-fixtures';

/**
 * Replying to a WhatsApp customer from the inbox.
 *
 * Meta is stubbed at `fetch`, which is the real boundary: everything above it —
 * authorization, the customer service window, idempotency, status handling —
 * runs exactly as it does in production, and the stub records what would have
 * been sent. A test that mocked the outbound service instead would prove only
 * that the mock was called.
 *
 * The cases that matter most are the ones where NOTHING should reach the
 * provider: an unauthorized user, a disabled channel, a closed window, a
 * retried request. A duplicate here is a second message to a real customer.
 */
describe('WhatsApp outbound', () => {
  let ctx: TestContext;
  let prisma: PrismaService;
  let tenancy: TenantContextService;

  const APP_SECRET = 'test-whatsapp-app-secret';
  const numbers = { a: '206540000000001', b: '206540000000002' };

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  let counter = 0;
  const unique = () => {
    counter += 1;
    return `${Date.now()}${counter}`;
  };

  /** Every Graph API call the code made. */
  let sends: { url: string; body: Record<string, unknown> }[] = [];
  /** What the next send should return. */
  let nextResponse: { status: number; body: unknown } = {
    status: 200,
    body: { messages: [{ id: 'wamid.default' }] },
  };
  let realFetch: typeof globalThis.fetch;

  beforeAll(async () => {
    ctx = await createTestContext();
    prisma = ctx.app.get(PrismaService);
    tenancy = ctx.app.get(TenantContextService);

    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);

      // Only Graph API calls are intercepted; anything else would be a bug.
      if (!url.includes('graph.facebook.com')) return realFetch(input, init);

      if (init?.method === 'POST') {
        sends.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return new Response(JSON.stringify(nextResponse.body), {
          status: nextResponse.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // The setup validation GET.
      return new Response(JSON.stringify({ verified_name: 'Test Business' }), { status: 200 });
    }) as typeof globalThis.fetch;

    for (const [org, number] of [
      [ctx.orgA.id, numbers.a],
      [ctx.orgB.id, numbers.b],
    ] as const) {
      await tenancy.runForOrganization(org, 'test: connect whatsapp', () =>
        prisma.client.channelIntegration.create({
          data: {
            organizationId: org,
            channel: 'WHATSAPP',
            status: 'CONNECTED',
            enabled: true,
            providerAccountId: number,
            displayName: 'Test WhatsApp',
            // A real sealed secret would need the key; the outbound service
            // decrypts it, so this is set through the connect endpoint below
            // where a token round-trip is actually exercised.
            encryptedAccessToken: null,
          },
        }),
      );
    }
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await ctx?.close();
  });

  beforeEach(() => {
    sends = [];
    nextResponse = { status: 200, body: { messages: [{ id: `wamid.${unique()}` }] } };
  });

  function sign(body: string): string {
    return `sha256=${createHmac('sha256', APP_SECRET).update(Buffer.from(body)).digest('hex')}`;
  }

  async function deliverWebhook(payload: unknown) {
    const body = JSON.stringify(payload);
    return ctx
      .http()
      .post('/api/v1/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);
  }

  /** An inbound message, which is what opens the 24-hour window. */
  async function customerWrites(digits: string, text = 'Do you have stock?') {
    return deliverWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '102290129340398',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: numbers.a },
                contacts: [{ profile: { name: 'Rahul' }, wa_id: digits }],
                messages: [
                  {
                    from: digits,
                    id: `wamid.${unique()}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: text },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
  }

  async function conversationFor(digits: string): Promise<string> {
    const conversation = await tenancy.runForOrganization(ctx.orgA.id, 'test: find', () =>
      prisma.client.conversation.findFirst({
        where: { externalConversationId: `${numbers.a}:${digits}` },
      }),
    );
    expect(conversation).not.toBeNull();
    return conversation!.id;
  }

  /** Gives the integration a real encrypted token via the connect endpoint. */
  async function connectWithToken(): Promise<void> {
    const response = await ctx
      .http()
      .post('/api/v1/channel-integrations/whatsapp/connect')
      .set(auth(ctx.orgA.owner.accessToken))
      .send({ phoneNumberId: numbers.a, accessToken: 'EAAG-test-token' });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('CONNECTED');
  }

  function send(conversationId: string, body: Record<string, unknown>, token?: string) {
    return ctx
      .http()
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set(auth(token ?? ctx.orgA.owner.accessToken))
      .send({ idempotencyKey: `key-${unique()}`, ...body });
  }

  // ===========================================================================
  // Capability
  // ===========================================================================

  describe('canSend', () => {
    it('is true inside the customer service window', async () => {
      await connectWithToken();
      const digits = fixtureProviderDigits();
      await customerWrites(digits);

      const detail = await ctx
        .http()
        .get(`/api/v1/conversations/${await conversationFor(digits)}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(detail.body.data.canSend).toBe(true);
      expect(detail.body.data.windowExpiresAt).toBeTruthy();
    });

    it('is false, with a reason, when the channel is switched off', async () => {
      await connectWithToken();
      const digits = fixtureProviderDigits();
      await customerWrites(digits);
      const conversationId = await conversationFor(digits);

      const integration = await tenancy.runForOrganization(ctx.orgA.id, 'test: find', () =>
        prisma.client.channelIntegration.findFirst({ where: { channel: 'WHATSAPP' } }),
      );
      await tenancy.runForOrganization(ctx.orgA.id, 'test: disable', () =>
        prisma.client.channelIntegration.update({
          where: { id: integration!.id },
          data: { enabled: false },
        }),
      );

      const detail = await ctx
        .http()
        .get(`/api/v1/conversations/${conversationId}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(detail.body.data.canSend).toBe(false);
      expect(detail.body.data.sendDisabledReason).toMatch(/switched off/i);

      await tenancy.runForOrganization(ctx.orgA.id, 'test: re-enable', () =>
        prisma.client.channelIntegration.update({
          where: { id: integration!.id },
          data: { enabled: true },
        }),
      );
    });

    it('never leaks a credential through the detail response', async () => {
      await connectWithToken();
      const digits = fixtureProviderDigits();
      await customerWrites(digits);

      const detail = await ctx
        .http()
        .get(`/api/v1/conversations/${await conversationFor(digits)}`)
        .set(auth(ctx.orgA.owner.accessToken));

      const serialised = JSON.stringify(detail.body);
      expect(serialised).not.toContain('EAAG-test-token');
      expect(serialised).not.toContain('encryptedAccessToken');
    });
  });

  // ===========================================================================
  // Sending
  // ===========================================================================

  describe('sending a reply', () => {
    it('reaches the provider and is stored as SENT', async () => {
      await connectWithToken();
      const digits = fixtureProviderDigits();
      await customerWrites(digits);
      const conversationId = await conversationFor(digits);

      const response = await send(conversationId, { content: 'Yes, we have stock.' });

      expect(response.status).toBe(201);
      expect(response.body.data.direction).toBe('OUTGOING');
      expect(response.body.data.deliveryStatus).toBe('SENT');

      expect(sends).toHaveLength(1);
      expect(sends[0]!.body).toMatchObject({
        messaging_product: 'whatsapp',
        to: digits,
        type: 'text',
        text: { preview_url: false, body: 'Yes, we have stock.' },
      });
    });

    it('does not change the lead owner or the conversation owner', async () => {
      await connectWithToken();
      const digits = fixtureProviderDigits();

      const lead = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          firstName: 'Rahul',
          mobile: `+${digits}`,
          assignedToId: ctx.orgA.rep.id,
          nextFollowUpAt: new Date(Date.now() + 86_400_000).toISOString(),
        });
      expect(lead.status).toBe(201);

      await customerWrites(digits);
      const conversationId = await conversationFor(digits);

      // The OWNER replies, while the lead belongs to the rep.
      await send(conversationId, { content: 'Thanks for getting in touch.' });

      const after = await ctx
        .http()
        .get(`/api/v1/leads/${lead.body.data.id}`)
        .set(auth(ctx.orgA.owner.accessToken));
      expect(after.body.data.assignedTo?.id ?? after.body.data.assignedToId).toBe(ctx.orgA.rep.id);

      const conversation = await tenancy.runForOrganization(ctx.orgA.id, 'test: read', () =>
        prisma.client.conversation.findFirst({ where: { id: conversationId } }),
      );
      // Helping out is not a claim on the thread either.
      expect(conversation!.ownerId).toBe(ctx.orgA.rep.id);
    });

    it('appears in the conversation history as outbound', async () => {
      await connectWithToken();
      const digits = fixtureProviderDigits();
      await customerWrites(digits);
      const conversationId = await conversationFor(digits);

      await send(conversationId, { content: 'We will send a quote today.' });

      const detail = await ctx
        .http()
        .get(`/api/v1/conversations/${conversationId}`)
        .set(auth(ctx.orgA.owner.accessToken));

      const outbound = detail.body.data.messages.filter(
        (m: { direction: string }) => m.direction === 'OUTGOING',
      );
      expect(outbound).toHaveLength(1);
      expect(outbound[0].senderType).toBe('AGENT');
    });

    it.each(['', '   ', '\n\t'])('refuses the empty message %p without calling the provider', async (content) => {
      await connectWithToken();
      const digits = fixtureProviderDigits();
      await customerWrites(digits);
      const conversationId = await conversationFor(digits);

      const response = await send(conversationId, { content });

      expect(response.status).toBe(400);
      expect(sends).toHaveLength(0);
    });

    it('refuses a message longer than WhatsApp accepts', async () => {
      await connectWithToken();
      const digits = fixtureProviderDigits();
      await customerWrites(digits);
      const conversationId = await conversationFor(digits);

      const response = await send(conversationId, { content: 'x'.repeat(5000) });

      expect(response.status).toBe(400);
      expect(sends).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Authorization — nothing may reach the provider
  // ===========================================================================

  describe('authorization', () => {
    it('refuses a rep replying on a colleague’s lead, and calls nothing', async () => {
      await connectWithToken();
      const digits = fixtureProviderDigits();

      await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          firstName: 'Rahul',
          mobile: `+${digits}`,
          assignedToId: ctx.orgA.owner.id,
          nextFollowUpAt: new Date(Date.now() + 86_400_000).toISOString(),
        });

      await customerWrites(digits);
      const conversationId = await conversationFor(digits);

      const response = await send(conversationId, { content: 'hello' }, ctx.orgA.rep.accessToken);

      // 404, not 403 — knowing an id must not confirm it exists.
      expect(response.status).toBe(404);
      expect(sends).toHaveLength(0);
    });

    it('refuses organization B replying to organization A’s conversation', async () => {
      await connectWithToken();
      const digits = fixtureProviderDigits();
      await customerWrites(digits);
      const conversationId = await conversationFor(digits);

      const response = await send(conversationId, { content: 'hello' }, ctx.orgB.owner.accessToken);

      expect(response.status).toBe(404);
      expect(sends).toHaveLength(0);
    });

    it('refuses a disabled integration without calling the provider', async () => {
      await connectWithToken();
      const digits = fixtureProviderDigits();
      await customerWrites(digits);
      const conversationId = await conversationFor(digits);

      const integration = await tenancy.runForOrganization(ctx.orgA.id, 'test: find', () =>
        prisma.client.channelIntegration.findFirst({ where: { channel: 'WHATSAPP' } }),
      );
      await tenancy.runForOrganization(ctx.orgA.id, 'test: disable', () =>
        prisma.client.channelIntegration.update({
          where: { id: integration!.id },
          data: { enabled: false },
        }),
      );

      const response = await send(conversationId, { content: 'hello' });

      expect(response.status).toBe(409);
      expect(sends).toHaveLength(0);

      await tenancy.runForOrganization(ctx.orgA.id, 'test: re-enable', () =>
        prisma.client.channelIntegration.update({
          where: { id: integration!.id },
          data: { enabled: true },
        }),
      );
    });

    it('refuses once the customer service window has closed', async () => {
      await connectWithToken();
      const digits = fixtureProviderDigits();
      await customerWrites(digits);
      const conversationId = await conversationFor(digits);

      // Age the customer's message past 24 hours.
      await tenancy.runForOrganization(ctx.orgA.id, 'test: age', () =>
        prisma.client.message.updateMany({
          where: { conversationId, direction: 'INCOMING' },
          data: { sentAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
        }),
      );

      const response = await send(conversationId, { content: 'still there?' });

      expect(response.status).toBe(409);
      expect(response.body.error.message).toMatch(/24 hours/i);
      // Determined locally, so Meta is never asked to refuse it.
      expect(sends).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Idempotency — a duplicate here is a second message to a real customer
  // ===========================================================================

  describe('idempotency', () => {
    it('sends once however many times the request is repeated', async () => {
      await connectWithToken();
      const digits = fixtureProviderDigits();
      await customerWrites(digits);
      const conversationId = await conversationFor(digits);

      const key = `key-${unique()}`;
      const body = { content: 'One reply only.', idempotencyKey: key };

      const first = await ctx
        .http()
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send(body);
      const second = await ctx
        .http()
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send(body);
      const third = await ctx
        .http()
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send(body);

      expect(first.status).toBe(201);
      expect(second.body.data.id).toBe(first.body.data.id);
      expect(third.body.data.id).toBe(first.body.data.id);

      // THE assertion. The customer received one message.
      expect(sends).toHaveLength(1);
    });

    it('stores one message row for a repeated request', async () => {
      await connectWithToken();
      const digits = fixtureProviderDigits();
      await customerWrites(digits);
      const conversationId = await conversationFor(digits);

      const body = { content: 'Only once.', idempotencyKey: `key-${unique()}` };
      await ctx
        .http()
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send(body);
      await ctx
        .http()
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send(body);

      const outbound = await tenancy.runForOrganization(ctx.orgA.id, 'test: count', () =>
        prisma.client.message.count({ where: { conversationId, direction: 'OUTGOING' } }),
      );
      expect(outbound).toBe(1);
    });

    it('lets a genuinely different message through', async () => {
      await connectWithToken();
      const digits = fixtureProviderDigits();
      await customerWrites(digits);
      const conversationId = await conversationFor(digits);

      await send(conversationId, { content: 'First.' });
      await send(conversationId, { content: 'Second.' });

      expect(sends).toHaveLength(2);
    });
  });

  // ===========================================================================
  // Provider failures
  // ===========================================================================

  describe('provider failures', () => {
    it('does not mark a rejected message as sent', async () => {
      await connectWithToken();
      const digits = fixtureProviderDigits();
      await customerWrites(digits);
      const conversationId = await conversationFor(digits);

      nextResponse = { status: 400, body: { error: { code: 131047 } } };

      const response = await send(conversationId, { content: 'will fail' });

      expect(response.status).toBe(409);
      // A safe sentence, not Meta's body.
      expect(JSON.stringify(response.body)).not.toContain('131047');

      const stored = await tenancy.runForOrganization(ctx.orgA.id, 'test: read', () =>
        prisma.client.message.findFirst({
          where: { conversationId, direction: 'OUTGOING' },
          orderBy: { createdAt: 'desc' },
        }),
      );

      expect(stored!.deliveryStatus).toBe('FAILED');
      expect(stored!.externalMessageId).toBeNull();
    });

    it('reports an expired token without revealing it', async () => {
      await connectWithToken();
      const digits = fixtureProviderDigits();
      await customerWrites(digits);
      const conversationId = await conversationFor(digits);

      nextResponse = { status: 401, body: { error: { code: 190 } } };

      const response = await send(conversationId, { content: 'will fail' });

      expect(response.status).toBe(409);
      expect(response.body.error.message).toMatch(/reconnect the channel/i);
      expect(JSON.stringify(response.body)).not.toContain('EAAG-test-token');
    });

    it('keeps the record when the outcome is uncertain, so nobody resends blindly', async () => {
      await connectWithToken();
      const digits = fixtureProviderDigits();
      await customerWrites(digits);
      const conversationId = await conversationFor(digits);

      // Accepted, but no id — we cannot know what happened.
      nextResponse = { status: 200, body: { messages: [] } };

      const response = await send(conversationId, { content: 'uncertain' });

      expect(response.status).toBe(502);

      const stored = await tenancy.runForOrganization(ctx.orgA.id, 'test: read', () =>
        prisma.client.message.findFirst({
          where: { conversationId, direction: 'OUTGOING' },
          orderBy: { createdAt: 'desc' },
        }),
      );

      // The row survives on purpose: it is the only thing telling the
      // salesperson to check before resending.
      expect(stored).not.toBeNull();
      expect(stored!.deliveryStatus).toBe('FAILED');
      expect(stored!.failureReason).toMatch(/check before resending/i);
    });
  });

  // ===========================================================================
  // Delivery receipts
  // ===========================================================================

  describe('status webhooks', () => {
    async function statusEvent(providerMessageId: string, status: string, errorCode?: number) {
      return deliverWebhook({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: '102290129340398',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { phone_number_id: numbers.a },
                  statuses: [
                    {
                      id: providerMessageId,
                      status,
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      recipient_id: '447700900123',
                      ...(errorCode ? { errors: [{ code: errorCode }] } : {}),
                    },
                  ],
                },
              },
            ],
          },
        ],
      });
    }

    async function sendAndCapture(): Promise<{ messageId: string; providerId: string }> {
      await connectWithToken();
      const digits = fixtureProviderDigits();
      await customerWrites(digits);
      const conversationId = await conversationFor(digits);

      const providerId = `wamid.out.${unique()}`;
      nextResponse = { status: 200, body: { messages: [{ id: providerId }] } };

      const response = await send(conversationId, { content: 'tracked' });
      expect(response.status).toBe(201);

      return { messageId: response.body.data.id, providerId };
    }

    async function statusOf(messageId: string): Promise<string | null> {
      const message = await tenancy.runForOrganization(ctx.orgA.id, 'test: read', () =>
        prisma.client.message.findFirst({ where: { id: messageId } }),
      );
      return message?.deliveryStatus ?? null;
    }

    it('advances SENT to DELIVERED to READ', async () => {
      const { messageId, providerId } = await sendAndCapture();

      await statusEvent(providerId, 'delivered');
      expect(await statusOf(messageId)).toBe('DELIVERED');

      await statusEvent(providerId, 'read');
      expect(await statusOf(messageId)).toBe('READ');
    });

    it('ignores a duplicate status event', async () => {
      const { messageId, providerId } = await sendAndCapture();

      await statusEvent(providerId, 'delivered');
      await statusEvent(providerId, 'delivered');

      expect(await statusOf(messageId)).toBe('DELIVERED');
    });

    it('does NOT downgrade a read message when a late delivered arrives', async () => {
      const { messageId, providerId } = await sendAndCapture();

      await statusEvent(providerId, 'read');
      await statusEvent(providerId, 'delivered');

      // Meta gives no ordering guarantee. Downgrading would have a salesperson
      // chase something the customer has already read.
      expect(await statusOf(messageId)).toBe('READ');
    });

    it('records a failure reported after acceptance', async () => {
      const { messageId, providerId } = await sendAndCapture();

      await statusEvent(providerId, 'failed', 131026);

      expect(await statusOf(messageId)).toBe('FAILED');
    });

    it('creates no message and no conversation from a status event', async () => {
      const { providerId } = await sendAndCapture();

      const beforeMessages = await tenancy.runForOrganization(ctx.orgA.id, 'test: count', () =>
        prisma.client.message.count(),
      );
      const beforeConversations = await tenancy.runForOrganization(ctx.orgA.id, 'test: count', () =>
        prisma.client.conversation.count(),
      );

      await statusEvent(providerId, 'delivered');

      expect(
        await tenancy.runForOrganization(ctx.orgA.id, 'test: count', () =>
          prisma.client.message.count(),
        ),
      ).toBe(beforeMessages);
      expect(
        await tenancy.runForOrganization(ctx.orgA.id, 'test: count', () =>
          prisma.client.conversation.count(),
        ),
      ).toBe(beforeConversations);
    });

    it('ignores a status for a provider id nobody sent', async () => {
      const response = await statusEvent(`wamid.unknown.${unique()}`, 'delivered');
      expect(response.status).toBe(200);
    });

    it('mutates nothing when the signature is invalid', async () => {
      const { messageId, providerId } = await sendAndCapture();

      const body = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: '1',
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: numbers.a },
                  statuses: [{ id: providerId, status: 'read', timestamp: '1756000000' }],
                },
              },
            ],
          },
        ],
      });

      const response = await ctx
        .http()
        .post('/api/v1/webhooks/whatsapp')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', 'sha256=deadbeef')
        .send(body);

      expect(response.status).toBe(403);
      expect(await statusOf(messageId)).toBe('SENT');
    });
  });
});
