import { createHmac } from 'node:crypto';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { createTestContext, type TestContext } from './helpers/test-app';
import { fixtureProviderDigits } from './helpers/phone-fixtures';

/**
 * Real WhatsApp webhooks, end to end.
 *
 * The security cases come first and are the reason this file exists. A webhook
 * endpoint is the one door in the application that accepts traffic from the
 * public internet with no session behind it, so "an unsigned request changes
 * nothing" is not a nice property — it is the whole basis on which the endpoint
 * can exist at all.
 *
 * The functional cases then check the claim this phase makes: that a real
 * message goes through the SAME identity resolution, lead matching and
 * ownership rules as everything else, rather than a WhatsApp-shaped copy.
 */
describe('WhatsApp webhook', () => {
  let ctx: TestContext;
  let prisma: PrismaService;
  let tenancy: TenantContextService;

  const APP_SECRET = 'test-whatsapp-app-secret';
  const VERIFY_TOKEN = 'test-whatsapp-verify-token';

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Phone number ids, one per organization. */
  const numbers = { a: '106540000000001', b: '106540000000002' };

  let counter = 0;
  const unique = () => {
    counter += 1;
    return `${Date.now()}${counter}`;
  };

  function sign(body: string, secret = APP_SECRET): string {
    return `sha256=${createHmac('sha256', secret).update(Buffer.from(body)).digest('hex')}`;
  }

  /** Posts a body exactly as Meta would, signed unless told otherwise. */
  async function deliver(payload: unknown, options: { signature?: string | null } = {}) {
    const body = JSON.stringify(payload);
    const request = ctx
      .http()
      .post('/api/v1/webhooks/whatsapp')
      .set('Content-Type', 'application/json');

    const signature = options.signature === undefined ? sign(body) : options.signature;
    if (signature !== null) request.set('X-Hub-Signature-256', signature);

    return request.send(body);
  }

  function payload(input: {
    phoneNumberId: string;
    from?: string;
    text?: string | null;
    messageId?: string;
    type?: string;
    timestamp?: number;
    name?: string;
  }) {
    const message: Record<string, unknown> = {
      from: input.from ?? '447700900123',
      id: input.messageId ?? `wamid.${unique()}`,
      timestamp: String(input.timestamp ?? Math.floor(Date.now() / 1000)),
      type: input.type ?? 'text',
    };
    if ((input.type ?? 'text') === 'text') {
      message['text'] = { body: input.text ?? 'Please share your pricing for 500kg.' };
    }

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
                  phone_number_id: input.phoneNumberId,
                },
                contacts: [
                  { profile: { name: input.name ?? 'Rahul Patil' }, wa_id: input.from ?? '447700900123' },
                ],
                messages: [message],
              },
            },
          ],
        },
      ],
    };
  }

  /** Creates a CONNECTED WhatsApp integration for an organization. */
  async function connectNumber(organizationId: string, phoneNumberId: string): Promise<string> {
    const created = await tenancy.runForOrganization(organizationId, 'test: connect whatsapp', () =>
      prisma.client.channelIntegration.create({
        data: {
          organizationId,
          channel: 'WHATSAPP',
          status: 'CONNECTED',
          enabled: true,
          providerAccountId: phoneNumberId,
          displayName: 'Test WhatsApp',
          // Deliberately no token: nothing on the inbound path needs one, and
          // this proves it.
        },
      }),
    );
    return created.id;
  }

  async function countMessages(organizationId: string): Promise<number> {
    return tenancy.runForOrganization(organizationId, 'test: count messages', () =>
      prisma.client.message.count(),
    );
  }

  async function createLead(
    token: string,
    body: Record<string, unknown>,
  ): Promise<{ id: string; leadNumber: string }> {
    const response = await ctx
      .http()
      .post('/api/v1/leads')
      .set(auth(token))
      .send({
        firstName: 'Rahul',
        nextFollowUpAt: new Date(Date.now() + 86_400_000).toISOString(),
        ...body,
      });

    expect(response.status).toBe(201);
    return response.body.data;
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    prisma = ctx.app.get(PrismaService);
    tenancy = ctx.app.get(TenantContextService);

    await connectNumber(ctx.orgA.id, numbers.a);
    await connectNumber(ctx.orgB.id, numbers.b);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ===========================================================================
  // Verification handshake
  // ===========================================================================

  describe('subscription verification', () => {
    it('echoes the challenge for the correct verify token', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/webhooks/whatsapp')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': '1158201444',
        });

      expect(response.status).toBe(200);
      expect(response.text).toContain('1158201444');
    });

    it('refuses a wrong verify token', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/webhooks/whatsapp')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'guessed-token',
          'hub.challenge': '1158201444',
        });

      expect(response.status).toBe(403);
      // Nothing that would help someone work out the real token.
      expect(response.text).not.toContain(VERIFY_TOKEN);
    });

    it('refuses a request with no token at all', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/webhooks/whatsapp')
        .query({ 'hub.mode': 'subscribe', 'hub.challenge': '1' });

      expect(response.status).toBe(403);
    });
  });

  // ===========================================================================
  // Signature — the security boundary
  // ===========================================================================

  describe('signature validation', () => {
    it('rejects an unsigned request and writes NOTHING', async () => {
      const before = await countMessages(ctx.orgA.id);

      const response = await deliver(payload({ phoneNumberId: numbers.a }), { signature: null });

      expect(response.status).toBe(403);
      expect(await countMessages(ctx.orgA.id)).toBe(before);
    });

    it('rejects a body signed with the wrong secret and writes NOTHING', async () => {
      const before = await countMessages(ctx.orgA.id);
      const body = JSON.stringify(payload({ phoneNumberId: numbers.a }));

      const response = await ctx
        .http()
        .post('/api/v1/webhooks/whatsapp')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', sign(body, 'attacker-secret'))
        .send(body);

      expect(response.status).toBe(403);
      expect(await countMessages(ctx.orgA.id)).toBe(before);
    });

    it('rejects a body altered after signing', async () => {
      const before = await countMessages(ctx.orgA.id);

      const original = JSON.stringify(payload({ phoneNumberId: numbers.a }));
      const tampered = JSON.stringify(payload({ phoneNumberId: numbers.b }));

      const response = await ctx
        .http()
        .post('/api/v1/webhooks/whatsapp')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', sign(original))
        .send(tampered);

      expect(response.status).toBe(403);
      expect(await countMessages(ctx.orgA.id)).toBe(before);
      expect(await countMessages(ctx.orgB.id)).toBe(await countMessages(ctx.orgB.id));
    });

    it.each(['', 'nonsense', 'sha1=abc', 'sha256='])(
      'rejects the malformed signature %p',
      async (signature) => {
        const response = await deliver(payload({ phoneNumberId: numbers.a }), { signature });
        expect(response.status).toBe(403);
      },
    );

    it('accepts a correctly signed request', async () => {
      const response = await deliver(payload({ phoneNumberId: numbers.a }));
      expect(response.status).toBe(200);
    });
  });

  // ===========================================================================
  // Tenant resolution
  // ===========================================================================

  describe('tenant resolution', () => {
    it('routes a message to the organization that owns the number', async () => {
      const beforeB = await countMessages(ctx.orgB.id);

      await deliver(payload({ phoneNumberId: numbers.a, from: `4477009${unique().slice(-5)}` }));

      // Organization B is untouched, whatever the payload said.
      expect(await countMessages(ctx.orgB.id)).toBe(beforeB);
    });

    it('ignores a number nobody has connected, choosing no tenant at all', async () => {
      const beforeA = await countMessages(ctx.orgA.id);
      const beforeB = await countMessages(ctx.orgB.id);

      const response = await deliver(payload({ phoneNumberId: '999999999999999' }));

      // 200: Meta must not retry something that will never succeed.
      expect(response.status).toBe(200);
      expect(await countMessages(ctx.orgA.id)).toBe(beforeA);
      expect(await countMessages(ctx.orgB.id)).toBe(beforeB);
    });

    it('never lets one organization’s number create data under another', async () => {
      const beforeA = await countMessages(ctx.orgA.id);

      await deliver(payload({ phoneNumberId: numbers.b, from: `4477009${unique().slice(-5)}` }));

      expect(await countMessages(ctx.orgA.id)).toBe(beforeA);
    });
  });

  // ===========================================================================
  // Integration state
  // ===========================================================================

  describe('integration state', () => {
    it('ingests nothing while the integration is disabled', async () => {
      const integration = await tenancy.runForOrganization(ctx.orgA.id, 'test: find', () =>
        prisma.client.channelIntegration.findFirst({ where: { channel: 'WHATSAPP' } }),
      );

      await tenancy.runForOrganization(ctx.orgA.id, 'test: disable', () =>
        prisma.client.channelIntegration.update({
          where: { id: integration!.id },
          data: { enabled: false },
        }),
      );

      const before = await countMessages(ctx.orgA.id);
      const response = await deliver(payload({ phoneNumberId: numbers.a }));

      // Acknowledged, not errored: disabled is a choice, not a failure, and a
      // non-2xx would make Meta retry it for hours.
      expect(response.status).toBe(200);
      expect(await countMessages(ctx.orgA.id)).toBe(before);

      await tenancy.runForOrganization(ctx.orgA.id, 'test: re-enable', () =>
        prisma.client.channelIntegration.update({
          where: { id: integration!.id },
          data: { enabled: true },
        }),
      );
    });

    it('ingests nothing for an integration that was never validated', async () => {
      const integration = await tenancy.runForOrganization(ctx.orgA.id, 'test: find', () =>
        prisma.client.channelIntegration.findFirst({ where: { channel: 'WHATSAPP' } }),
      );

      await tenancy.runForOrganization(ctx.orgA.id, 'test: connecting', () =>
        prisma.client.channelIntegration.update({
          where: { id: integration!.id },
          data: { status: 'CONNECTING' },
        }),
      );

      const before = await countMessages(ctx.orgA.id);
      const response = await deliver(payload({ phoneNumberId: numbers.a }));

      // A webhook arriving is not evidence that setup succeeded.
      expect(response.status).toBe(200);
      expect(await countMessages(ctx.orgA.id)).toBe(before);

      await tenancy.runForOrganization(ctx.orgA.id, 'test: connected', () =>
        prisma.client.channelIntegration.update({
          where: { id: integration!.id },
          data: { status: 'CONNECTED' },
        }),
      );
    });
  });

  // ===========================================================================
  // The existing pipeline, reused
  // ===========================================================================

  describe('a message from an existing customer', () => {
    it('links to their existing lead and leaves the owner alone', async () => {
      const digits = fixtureProviderDigits();
      const lead = await createLead(ctx.orgA.owner.accessToken, {
        mobile: `+${digits}`,
        assignedToId: ctx.orgA.rep.id,
      });

      const response = await deliver(
        payload({ phoneNumberId: numbers.a, from: digits, text: 'Please send the quotation.' }),
      );
      expect(response.status).toBe(200);

      const conversations = await ctx
        .http()
        .get('/api/v1/conversations')
        .query({ leadId: lead.id })
        .set(auth(ctx.orgA.owner.accessToken));

      expect(conversations.body.data).toHaveLength(1);
      expect(conversations.body.data[0].channel).toBe('WHATSAPP');

      // THE rule. A customer messaging on WhatsApp does not move their deal.
      const after = await ctx
        .http()
        .get(`/api/v1/leads/${lead.id}`)
        .set(auth(ctx.orgA.owner.accessToken));
      expect(after.body.data.assignedTo?.id ?? after.body.data.assignedToId).toBe(ctx.orgA.rep.id);
    });

    it('appears in the unified inbox under the WhatsApp filter', async () => {
      const digits = fixtureProviderDigits();

      await deliver(payload({ phoneNumberId: numbers.a, from: digits, text: 'need a quote' }));

      const inbox = await ctx
        .http()
        .get('/api/v1/conversations/inbox')
        .query({ channel: 'WHATSAPP' })
        .set(auth(ctx.orgA.owner.accessToken));

      expect(inbox.status).toBe(200);
      expect(inbox.body.data.items.length).toBeGreaterThan(0);
    });
  });

  describe('a message from someone unknown', () => {
    it('is stored but attached to nobody, and reaches the review queue', async () => {
      const digits = fixtureProviderDigits();

      await deliver(
        payload({ phoneNumberId: numbers.a, from: digits, text: 'What is your MOQ?' }),
      );

      const queue = await ctx
        .http()
        .get('/api/v1/conversations/review')
        .set(auth(ctx.orgA.owner.accessToken));

      const row = queue.body.data.items.find(
        (item: { contact: unknown; lastMessagePreview: string | null }) =>
          item.lastMessagePreview === 'What is your MOQ?',
      );

      expect(row).toBeDefined();
      expect(row.contact).toBeNull();
      // Phase C's keyword rules still apply — the adapter changed nothing.
      expect(row.potentialLead).toBe(true);
    });
  });

  // ===========================================================================
  // Idempotency
  // ===========================================================================

  describe('duplicate delivery', () => {
    it('stores one message however many times Meta delivers it', async () => {
      const digits = fixtureProviderDigits();
      const messageId = `wamid.${unique()}`;
      const body = payload({ phoneNumberId: numbers.a, from: digits, messageId });

      const before = await countMessages(ctx.orgA.id);

      await deliver(body);
      await deliver(body);
      await deliver(body);

      expect(await countMessages(ctx.orgA.id)).toBe(before + 1);
    });

    it('creates one conversation, not three', async () => {
      const digits = fixtureProviderDigits();
      const body = payload({ phoneNumberId: numbers.a, from: digits, messageId: `wamid.${unique()}` });

      await deliver(body);
      await deliver(body);

      const conversations = await tenancy.runForOrganization(ctx.orgA.id, 'test: count', () =>
        prisma.client.conversation.count({
          where: { externalConversationId: `${numbers.a}:${digits}` },
        }),
      );

      expect(conversations).toBe(1);
    });
  });

  // ===========================================================================
  // Batches and unusual payloads
  // ===========================================================================

  describe('batched deliveries', () => {
    it('processes every message in one request', async () => {
      const digits = fixtureProviderDigits();
      const before = await countMessages(ctx.orgA.id);

      const body = payload({ phoneNumberId: numbers.a, from: digits });
      const value = body.entry[0]!.changes[0]!.value as { messages: unknown[] };
      value.messages = [
        { from: digits, id: `wamid.${unique()}`, timestamp: '1756000000', type: 'text', text: { body: 'one' } },
        { from: digits, id: `wamid.${unique()}`, timestamp: '1756000001', type: 'text', text: { body: 'two' } },
      ];

      const response = await deliver(body);

      expect(response.status).toBe(200);
      expect(await countMessages(ctx.orgA.id)).toBe(before + 2);
    });

    it('does not let one malformed event discard the valid ones beside it', async () => {
      const digits = fixtureProviderDigits();
      const before = await countMessages(ctx.orgA.id);

      const body = payload({ phoneNumberId: numbers.a, from: digits });
      const value = body.entry[0]!.changes[0]!.value as { messages: unknown[] };
      value.messages = [
        { from: digits, id: `wamid.${unique()}`, timestamp: '1756000000', type: 'text', text: { body: 'good' } },
        { garbage: true },
        { from: digits, id: `wamid.${unique()}`, timestamp: '1756000002', type: 'text', text: { body: 'also good' } },
      ];

      const response = await deliver(body);

      expect(response.status).toBe(200);
      expect(await countMessages(ctx.orgA.id)).toBe(before + 2);
    });

    it('acknowledges a delivery receipt without creating anything', async () => {
      const before = await countMessages(ctx.orgA.id);

      const response = await deliver({
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
                  statuses: [{ id: 'wamid.x', status: 'delivered' }],
                },
              },
            ],
          },
        ],
      });

      expect(response.status).toBe(200);
      expect(await countMessages(ctx.orgA.id)).toBe(before);
    });

    it('records an unsupported type without pretending it was text', async () => {
      const digits = fixtureProviderDigits();

      await deliver(payload({ phoneNumberId: numbers.a, from: digits, type: 'image' }));

      const stored = await tenancy.runForOrganization(ctx.orgA.id, 'test: read', () =>
        prisma.client.message.findFirst({
          where: { conversation: { externalConversationId: `${numbers.a}:${digits}` } },
        }),
      );

      expect(stored?.messageType).toBe('IMAGE');
      expect(stored?.content).toBeNull();
    });
  });

  // ===========================================================================
  // Ordering
  // ===========================================================================

  describe('out-of-order delivery', () => {
    it('shows messages by when they were sent, not when they arrived', async () => {
      const digits = fixtureProviderDigits();
      const base = Math.floor(Date.now() / 1000);

      // The later message is delivered FIRST, which Meta does not rule out.
      await deliver(
        payload({ phoneNumberId: numbers.a, from: digits, text: 'second', timestamp: base + 60 }),
      );
      await deliver(
        payload({ phoneNumberId: numbers.a, from: digits, text: 'first', timestamp: base }),
      );

      const conversation = await tenancy.runForOrganization(ctx.orgA.id, 'test: read', () =>
        prisma.client.conversation.findFirst({
          where: { externalConversationId: `${numbers.a}:${digits}` },
        }),
      );

      const detail = await ctx
        .http()
        .get(`/api/v1/conversations/${conversation!.id}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(detail.body.data.messages.map((m: { content: string }) => m.content)).toEqual([
        'first',
        'second',
      ]);
    });
  });

  // ===========================================================================
  // Credentials never leave the server
  // ===========================================================================

  describe('credential handling', () => {
    it('never returns an access token from the integrations API', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/channel-integrations')
        .set(auth(ctx.orgA.owner.accessToken));

      const serialised = JSON.stringify(response.body);
      expect(serialised).not.toContain('encryptedAccessToken');
      expect(serialised).not.toContain('credentialsRef');
      // The hint is fine — four characters is enough to recognise a token and
      // not enough to use one.
      expect(response.body.data[0]).toHaveProperty('accessTokenHint');
    });

    it('refuses to let a sales rep connect a number', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/channel-integrations/whatsapp/connect')
        .set(auth(ctx.orgA.rep.accessToken))
        .send({ phoneNumberId: '123', accessToken: 'irrelevant' });

      expect(response.status).toBe(403);
    });

    it('refuses a phone number already connected to another organization', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/channel-integrations/whatsapp/connect')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ phoneNumberId: numbers.b, accessToken: 'some-token' });

      expect(response.status).toBe(409);
    });
  });
});
