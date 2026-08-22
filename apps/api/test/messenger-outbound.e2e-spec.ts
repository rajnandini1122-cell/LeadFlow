import { createHmac } from 'node:crypto';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { createTestContext, type TestContext } from './helpers/test-app';

/**
 * Replying on Instagram and Facebook Messenger.
 *
 * Meta is stubbed at `fetch`, which is the real boundary: authorization, the
 * messaging window, idempotency, recipient resolution and failure handling all
 * run exactly as they do in production, and the stub records what would have
 * been sent. A test that mocked the outbound service would prove only that the
 * mock was called.
 *
 * Both channels are covered by the same parameterised cases, because they run
 * through the same outbound flow and the same adapter. Where they genuinely
 * differ — text limits, the recipient shape — the cases say so.
 */
describe('Messenger outbound', () => {
  let ctx: TestContext;
  let prisma: PrismaService;
  let tenancy: TenantContextService;

  const SECRETS = { INSTAGRAM: 'test-instagram-app-secret', FACEBOOK: 'test-facebook-app-secret' };
  const OBJECTS = { INSTAGRAM: 'instagram', FACEBOOK: 'page' };
  const PATHS = { INSTAGRAM: 'instagram', FACEBOOK: 'facebook' };

  /** Business accounts, per channel per organization. */
  const accounts = {
    INSTAGRAM: { a: '17841500000000001', b: '17841500000000002' },
    FACEBOOK: { a: '109875000000001', b: '109875000000002' },
  };

  type Channel = 'INSTAGRAM' | 'FACEBOOK';
  const CHANNELS: Channel[] = ['INSTAGRAM', 'FACEBOOK'];

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  let counter = 0;
  const unique = () => {
    counter += 1;
    return `${Date.now()}${counter}`;
  };

  let sends: { url: string; body: Record<string, unknown> }[] = [];
  let nextResponse: { status: number; body: unknown } = { status: 200, body: { message_id: 'mid.x' } };
  let realFetch: typeof globalThis.fetch;

  beforeAll(async () => {
    ctx = await createTestContext();
    prisma = ctx.app.get(PrismaService);
    tenancy = ctx.app.get(TenantContextService);

    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('graph.facebook.com')) return realFetch(input, init);

      if (init?.method === 'POST') {
        sends.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return new Response(JSON.stringify(nextResponse.body), {
          status: nextResponse.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // The setup validation GET.
      return new Response(JSON.stringify({ username: 'testbiz', name: 'Test Page' }), {
        status: 200,
      });
    }) as typeof globalThis.fetch;

    // Connect both channels for both organizations, with a real encrypted
    // token so the decrypt path is genuinely exercised.
    for (const channel of CHANNELS) {
      for (const [org, token] of [
        [ctx.orgA, ctx.orgA.owner.accessToken],
        [ctx.orgB, ctx.orgB.owner.accessToken],
      ] as const) {
        const accountId = accounts[channel][org === ctx.orgA ? 'a' : 'b'];
        const response = await ctx
          .http()
          .post(`/api/v1/channel-integrations/${PATHS[channel]}/connect`)
          .set(auth(token))
          .send({ accountId, accessToken: `token-${channel}-${accountId}` });

        expect(response.status).toBe(200);
        expect(response.body.data.status).toBe('CONNECTED');
      }
    }
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await ctx?.close();
  });

  beforeEach(() => {
    sends = [];
    nextResponse = { status: 200, body: { message_id: `mid.out.${unique()}` } };
  });

  // ---------------------------------------------------------------- helpers

  function sign(channel: Channel, body: string, secret?: string): string {
    return `sha256=${createHmac('sha256', secret ?? SECRETS[channel]).update(Buffer.from(body)).digest('hex')}`;
  }

  /** Delivers an inbound message, which is what opens the 24-hour window. */
  async function customerWrites(
    channel: Channel,
    accountId: string,
    senderId: string,
    text = 'Do you deliver to Pune?',
    extra: Record<string, unknown> = {},
  ) {
    const payload = {
      object: OBJECTS[channel],
      entry: [
        {
          id: accountId,
          time: Date.now(),
          messaging: [
            {
              sender: { id: senderId },
              recipient: { id: accountId },
              timestamp: Date.now(),
              message: { mid: `mid.in.${unique()}`, text, ...extra },
            },
          ],
        },
      ],
    };

    const body = JSON.stringify(payload);
    return ctx
      .http()
      .post(`/api/v1/webhooks/${PATHS[channel]}`)
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(channel, body))
      .send(body);
  }

  async function conversationFor(accountId: string, senderId: string, organizationId: string) {
    const conversation = await tenancy.runForOrganization(organizationId, 'test: find', () =>
      prisma.client.conversation.findFirst({
        where: { externalConversationId: `${accountId}:${senderId}` },
      }),
    );
    expect(conversation).not.toBeNull();
    return conversation!;
  }

  /** An open conversation on a channel, ready to reply to. */
  async function openConversation(channel: Channel, organizationId = ctx.orgA.id) {
    const accountId = accounts[channel][organizationId === ctx.orgA.id ? 'a' : 'b'];
    const senderId = `psid.${unique()}`;
    await customerWrites(channel, accountId, senderId);

    return { conversation: await conversationFor(accountId, senderId, organizationId), senderId, accountId };
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

  describe.each(CHANNELS)('%s — capability', (channel) => {
    it('reports canSend inside the messaging window', async () => {
      const { conversation } = await openConversation(channel);

      const detail = await ctx
        .http()
        .get(`/api/v1/conversations/${conversation.id}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(detail.body.data.canSend).toBe(true);
      expect(detail.body.data.windowExpiresAt).toBeTruthy();
    });

    it('reports the provider text limit', async () => {
      const { conversation } = await openConversation(channel);

      const detail = await ctx
        .http()
        .get(`/api/v1/conversations/${conversation.id}`)
        .set(auth(ctx.orgA.owner.accessToken));

      // Meta's limits genuinely differ between the two.
      expect(detail.body.data.maxTextLength).toBe(channel === 'INSTAGRAM' ? 1000 : 2000);
    });

    it('never leaks a credential through the detail response', async () => {
      const { conversation } = await openConversation(channel);

      const detail = await ctx
        .http()
        .get(`/api/v1/conversations/${conversation.id}`)
        .set(auth(ctx.orgA.owner.accessToken));

      const serialised = JSON.stringify(detail.body);
      expect(serialised).not.toContain('token-');
      expect(serialised).not.toContain('encryptedAccessToken');
    });
  });

  // ===========================================================================
  // Sending
  // ===========================================================================

  describe.each(CHANNELS)('%s — sending', (channel) => {
    it('reaches the provider and stores the message as SENT', async () => {
      const { conversation, senderId, accountId } = await openConversation(channel);

      const response = await send(conversation.id, { content: 'Yes, we deliver there.' });

      expect(response.status).toBe(201);
      expect(response.body.data.direction).toBe('OUTGOING');
      expect(response.body.data.deliveryStatus).toBe('SENT');

      expect(sends).toHaveLength(1);
      // Addressed to the provider-scoped identity from the inbound message,
      // and sent AS the business account — never the other way round.
      expect(sends[0]!.url).toContain(accountId);
      expect(sends[0]!.body).toMatchObject({
        messaging_type: 'RESPONSE',
        recipient: { id: senderId },
        message: { text: 'Yes, we deliver there.' },
      });
    });

    it('stores the provider message id rather than inventing one', async () => {
      const { conversation } = await openConversation(channel);
      const providerId = `mid.out.${unique()}`;
      nextResponse = { status: 200, body: { message_id: providerId } };

      const response = await send(conversation.id, { content: 'tracked' });
      expect(response.status).toBe(201);

      const stored = await tenancy.runForOrganization(ctx.orgA.id, 'test: read', () =>
        prisma.client.message.findFirst({ where: { id: response.body.data.id } }),
      );
      expect(stored!.externalMessageId).toBe(providerId);
    });

    it('appears in the conversation history as outbound', async () => {
      const { conversation } = await openConversation(channel);
      await send(conversation.id, { content: 'We will send a quote today.' });

      const detail = await ctx
        .http()
        .get(`/api/v1/conversations/${conversation.id}`)
        .set(auth(ctx.orgA.owner.accessToken));

      const outbound = detail.body.data.messages.filter(
        (m: { direction: string }) => m.direction === 'OUTGOING',
      );
      expect(outbound).toHaveLength(1);
      expect(outbound[0].senderType).toBe('AGENT');
    });

    it('does not change the lead owner or the conversation owner', async () => {
      const digits = `4477${unique().slice(-9)}`;
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

      const { conversation } = await openConversation(channel);
      await tenancy.runForOrganization(ctx.orgA.id, 'test: link', () =>
        prisma.client.conversation.update({
          where: { id: conversation.id },
          data: { leadId: lead.body.data.id, ownerId: ctx.orgA.rep.id, linkState: 'LINKED' },
        }),
      );

      // The OWNER replies on a lead belonging to the rep.
      await send(conversation.id, { content: 'Thanks for getting in touch.' });

      const after = await ctx
        .http()
        .get(`/api/v1/leads/${lead.body.data.id}`)
        .set(auth(ctx.orgA.owner.accessToken));
      expect(after.body.data.assignedTo?.id ?? after.body.data.assignedToId).toBe(ctx.orgA.rep.id);

      const conv = await tenancy.runForOrganization(ctx.orgA.id, 'test: read', () =>
        prisma.client.conversation.findFirst({ where: { id: conversation.id } }),
      );
      expect(conv!.ownerId).toBe(ctx.orgA.rep.id);
      expect(conv!.leadId).toBe(lead.body.data.id);
    });

    it('refuses a body longer than this provider accepts, without calling Meta', async () => {
      const { conversation } = await openConversation(channel);
      const overLimit = channel === 'INSTAGRAM' ? 1001 : 2001;

      const response = await send(conversation.id, { content: 'x'.repeat(overLimit) });

      expect(response.status).toBe(400);
      expect(sends).toHaveLength(0);
    });

    it.each(['', '   '])('refuses the empty message %p without calling Meta', async (content) => {
      const { conversation } = await openConversation(channel);

      const response = await send(conversation.id, { content });

      expect(response.status).toBe(400);
      expect(sends).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Authorization and tenant isolation
  // ===========================================================================

  describe.each(CHANNELS)('%s — authorization', (channel) => {
    it('refuses organization B replying on organization A’s conversation', async () => {
      const { conversation } = await openConversation(channel);

      const response = await send(conversation.id, { content: 'hello' }, ctx.orgB.owner.accessToken);

      // 404, not 403 — knowing an id must not confirm it exists.
      expect(response.status).toBe(404);
      expect(sends).toHaveLength(0);
    });

    it('refuses a rep replying on a colleague’s lead', async () => {
      const digits = `4477${unique().slice(-9)}`;
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

      const { conversation } = await openConversation(channel);
      await tenancy.runForOrganization(ctx.orgA.id, 'test: link', () =>
        prisma.client.conversation.update({
          where: { id: conversation.id },
          data: { leadId: lead.body.data.id, ownerId: ctx.orgA.owner.id, linkState: 'LINKED' },
        }),
      );

      const response = await send(conversation.id, { content: 'hi' }, ctx.orgA.rep.accessToken);

      expect(response.status).toBe(404);
      expect(sends).toHaveLength(0);
    });

    it('refuses a conversation id that does not exist', async () => {
      const response = await send('00000000-0000-7000-8000-000000000000', { content: 'hi' });

      expect(response.status).toBe(404);
      expect(sends).toHaveLength(0);
    });

    it('never sends using another organization’s integration', async () => {
      // A conversation in B, replied to by B, must use B's account — never A's.
      const { conversation, accountId } = await openConversation(channel, ctx.orgB.id);

      const response = await send(conversation.id, { content: 'ours' }, ctx.orgB.owner.accessToken);

      expect(response.status).toBe(201);
      expect(sends).toHaveLength(1);
      expect(sends[0]!.url).toContain(accountId);
      expect(sends[0]!.url).not.toContain(accounts[channel].a);
    });
  });

  // ===========================================================================
  // Integration state
  // ===========================================================================

  describe.each(CHANNELS)('%s — integration state', (channel) => {
    async function withIntegration(
      changes: Record<string, unknown>,
      run: () => Promise<void>,
    ): Promise<void> {
      const integration = await tenancy.runForOrganization(ctx.orgA.id, 'test: find', () =>
        prisma.client.channelIntegration.findFirst({ where: { channel } }),
      );
      const before = {
        enabled: integration!.enabled,
        status: integration!.status,
        encryptedAccessToken: integration!.encryptedAccessToken,
      };

      await tenancy.runForOrganization(ctx.orgA.id, 'test: change', () =>
        prisma.client.channelIntegration.update({ where: { id: integration!.id }, data: changes }),
      );

      try {
        await run();
      } finally {
        await tenancy.runForOrganization(ctx.orgA.id, 'test: restore', () =>
          prisma.client.channelIntegration.update({ where: { id: integration!.id }, data: before }),
        );
      }
    }

    it('cannot send while disabled, and does not call Meta', async () => {
      const { conversation } = await openConversation(channel);

      await withIntegration({ enabled: false }, async () => {
        const response = await send(conversation.id, { content: 'hello' });

        expect(response.status).toBe(409);
        expect(sends).toHaveLength(0);
      });
    });

    it.each(['DISCONNECTED', 'CONNECTING', 'ERROR'] as const)(
      'cannot send while %s',
      async (status) => {
        const { conversation } = await openConversation(channel);

        await withIntegration({ status }, async () => {
          const response = await send(conversation.id, { content: 'hello' });

          expect(response.status).toBe(409);
          expect(sends).toHaveLength(0);
        });
      },
    );

    it('cannot send when the credential is missing', async () => {
      const { conversation } = await openConversation(channel);

      // Reachable after a disconnect, which clears the token but keeps the row.
      await withIntegration({ encryptedAccessToken: null }, async () => {
        const response = await send(conversation.id, { content: 'hello' });

        expect(response.status).toBe(409);
        expect(sends).toHaveLength(0);
      });
    });

    it('cannot send once the messaging window has closed', async () => {
      const { conversation } = await openConversation(channel);

      await tenancy.runForOrganization(ctx.orgA.id, 'test: age', () =>
        prisma.client.message.updateMany({
          where: { conversationId: conversation.id, direction: 'INCOMING' },
          data: { sentAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
        }),
      );

      const response = await send(conversation.id, { content: 'still there?' });

      expect(response.status).toBe(409);
      expect(response.body.error.message).toMatch(/24 hours/i);
      // Determined locally, so Meta is never asked to refuse it.
      expect(sends).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Idempotency
  // ===========================================================================

  describe.each(CHANNELS)('%s — idempotency', (channel) => {
    it('sends once however many times the request is repeated', async () => {
      const { conversation } = await openConversation(channel);
      const body = { content: 'One reply only.', idempotencyKey: `key-${unique()}` };

      const first = await ctx
        .http()
        .post(`/api/v1/conversations/${conversation.id}/messages`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send(body);
      const second = await ctx
        .http()
        .post(`/api/v1/conversations/${conversation.id}/messages`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send(body);
      const third = await ctx
        .http()
        .post(`/api/v1/conversations/${conversation.id}/messages`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send(body);

      expect(first.status).toBe(201);
      expect(second.body.data.id).toBe(first.body.data.id);
      expect(third.body.data.id).toBe(first.body.data.id);

      // THE assertion. The customer received one message.
      expect(sends).toHaveLength(1);
    });

    it('lets a genuinely different message through', async () => {
      const { conversation } = await openConversation(channel);

      await send(conversation.id, { content: 'First.' });
      await send(conversation.id, { content: 'Second.' });

      expect(sends).toHaveLength(2);
    });
  });

  // ===========================================================================
  // Provider failures
  // ===========================================================================

  describe.each(CHANNELS)('%s — provider failures', (channel) => {
    it('does not mark a rejected message as sent', async () => {
      const { conversation } = await openConversation(channel);
      nextResponse = { status: 400, body: { error: { code: 10 } } };

      const response = await send(conversation.id, { content: 'will fail' });

      expect(response.status).toBe(409);
      // A safe sentence, not Meta's body.
      expect(JSON.stringify(response.body)).not.toContain('"code":10');

      const stored = await tenancy.runForOrganization(ctx.orgA.id, 'test: read', () =>
        prisma.client.message.findFirst({
          where: { conversationId: conversation.id, direction: 'OUTGOING' },
          orderBy: { createdAt: 'desc' },
        }),
      );

      expect(stored!.deliveryStatus).toBe('FAILED');
      expect(stored!.externalMessageId).toBeNull();
    });

    it('reports rejected credentials without revealing them', async () => {
      const { conversation } = await openConversation(channel);
      nextResponse = { status: 401, body: { error: { code: 190 } } };

      const response = await send(conversation.id, { content: 'will fail' });

      expect(response.status).toBe(409);
      expect(response.body.error.message).toMatch(/reconnect the channel/i);
      expect(JSON.stringify(response.body)).not.toContain('token-');
    });

    it('keeps the record when the outcome is uncertain, so nobody resends blindly', async () => {
      const { conversation } = await openConversation(channel);
      // Accepted, but no message id — we cannot know what happened.
      nextResponse = { status: 200, body: {} };

      const response = await send(conversation.id, { content: 'uncertain' });

      expect(response.status).toBe(502);

      const stored = await tenancy.runForOrganization(ctx.orgA.id, 'test: read', () =>
        prisma.client.message.findFirst({
          where: { conversationId: conversation.id, direction: 'OUTGOING' },
          orderBy: { createdAt: 'desc' },
        }),
      );

      // The row survives on purpose: it is the only thing telling the
      // salesperson to check before resending.
      expect(stored).not.toBeNull();
      expect(stored!.deliveryStatus).toBe('FAILED');
      expect(stored!.failureReason).toMatch(/check before resending/i);
    });

    it('does not resend automatically after an uncertain failure', async () => {
      const { conversation } = await openConversation(channel);
      nextResponse = { status: 200, body: {} };

      await send(conversation.id, { content: 'uncertain' });

      // Exactly one attempt reached Meta. A customer receiving a duplicate is
      // worse than a stale status.
      expect(sends).toHaveLength(1);
    });
  });

  // ===========================================================================
  // Echoes — a message WE sent must never come back as a customer message
  // ===========================================================================

  describe.each(CHANNELS)('%s — echo handling', (channel) => {
    it('does not ingest our own outbound message when Meta echoes it back', async () => {
      const { conversation, senderId, accountId } = await openConversation(channel);

      const providerId = `mid.out.${unique()}`;
      nextResponse = { status: 200, body: { message_id: providerId } };
      await send(conversation.id, { content: 'Our reply.' });

      const before = await tenancy.runForOrganization(ctx.orgA.id, 'test: count', () =>
        prisma.client.message.count({ where: { conversationId: conversation.id } }),
      );

      // Meta reflects the business's own message back on the same webhook,
      // carrying the id we already stored. Ingesting it would create a
      // conversation with the business as the customer.
      const payload = {
        object: OBJECTS[channel],
        entry: [
          {
            id: accountId,
            messaging: [
              {
                sender: { id: accountId },
                recipient: { id: senderId },
                timestamp: Date.now(),
                message: { mid: providerId, text: 'Our reply.', is_echo: true },
              },
            ],
          },
        ],
      };
      const body = JSON.stringify(payload);

      const response = await ctx
        .http()
        .post(`/api/v1/webhooks/${PATHS[channel]}`)
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', sign(channel, body))
        .send(body);

      expect(response.status).toBe(200);

      const after = await tenancy.runForOrganization(ctx.orgA.id, 'test: count', () =>
        prisma.client.message.count({ where: { conversationId: conversation.id } }),
      );
      expect(after).toBe(before);
    });

    it('leaves the outbound message SENT after its echo arrives', async () => {
      const { conversation, senderId, accountId } = await openConversation(channel);

      const providerId = `mid.out.${unique()}`;
      nextResponse = { status: 200, body: { message_id: providerId } };
      const sent = await send(conversation.id, { content: 'Our reply.' });

      const payload = {
        object: OBJECTS[channel],
        entry: [
          {
            id: accountId,
            messaging: [
              {
                sender: { id: accountId },
                recipient: { id: senderId },
                timestamp: Date.now(),
                message: { mid: providerId, text: 'Our reply.', is_echo: true },
              },
            ],
          },
        ],
      };
      const body = JSON.stringify(payload);
      await ctx
        .http()
        .post(`/api/v1/webhooks/${PATHS[channel]}`)
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', sign(channel, body))
        .send(body);

      const stored = await tenancy.runForOrganization(ctx.orgA.id, 'test: read', () =>
        prisma.client.message.findFirst({ where: { id: sent.body.data.id } }),
      );

      // An echo is not delivery evidence. Manufacturing DELIVERED from one
      // would tell a salesperson something Meta never said.
      expect(stored!.deliveryStatus).toBe('SENT');
    });
  });

  // ===========================================================================
  // Cross-channel identity
  // ===========================================================================

  describe('cross-channel safety', () => {
    it('replies to the identity from ITS OWN channel, never the other', async () => {
      const shared = `shared.${unique()}`;

      await customerWrites('INSTAGRAM', accounts.INSTAGRAM.a, shared, 'from instagram');
      await customerWrites('FACEBOOK', accounts.FACEBOOK.a, shared, 'from messenger');

      const ig = await conversationFor(accounts.INSTAGRAM.a, shared, ctx.orgA.id);
      const fb = await conversationFor(accounts.FACEBOOK.a, shared, ctx.orgA.id);

      // Two separate conversations for two provider-scoped identities that
      // merely look alike.
      expect(ig.id).not.toBe(fb.id);

      sends = [];
      await send(ig.id, { content: 'instagram reply' });
      await send(fb.id, { content: 'messenger reply' });

      expect(sends).toHaveLength(2);
      expect(sends[0]!.url).toContain(accounts.INSTAGRAM.a);
      expect(sends[1]!.url).toContain(accounts.FACEBOOK.a);
    });
  });
});
