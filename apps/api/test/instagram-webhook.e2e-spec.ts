import { createHmac } from 'node:crypto';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { createTestContext, type TestContext } from './helpers/test-app';

/**
 * Instagram Direct Messages, end to end.
 *
 * The point of this suite is that Instagram is a PROVIDER, not a product. A DM
 * should reach the same conversation store, the same review queue and the same
 * lead rules as a WhatsApp message, without a single line of Instagram-specific
 * CRM behaviour behind it.
 *
 * The security cases come first, for the same reason as WhatsApp: this is an
 * endpoint that accepts traffic from the public internet with no session behind
 * it, so "an unsigned request changes nothing" is the basis on which it can
 * exist at all.
 */
describe('Instagram webhook', () => {
  let ctx: TestContext;
  let prisma: PrismaService;
  let tenancy: TenantContextService;

  const APP_SECRET = 'test-instagram-app-secret';
  const VERIFY_TOKEN = 'test-instagram-verify-token';

  /** Instagram professional account ids, one per organization. */
  const accounts = { a: '17841400000000001', b: '17841400000000002' };

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  let counter = 0;
  const unique = () => {
    counter += 1;
    return `${Date.now()}${counter}`;
  };

  function sign(body: string, secret = APP_SECRET): string {
    return `sha256=${createHmac('sha256', secret).update(Buffer.from(body)).digest('hex')}`;
  }

  async function deliver(payload: unknown, options: { signature?: string | null } = {}) {
    const body = JSON.stringify(payload);
    const request = ctx
      .http()
      .post('/api/v1/webhooks/instagram')
      .set('Content-Type', 'application/json');

    const signature = options.signature === undefined ? sign(body) : options.signature;
    if (signature !== null) request.set('X-Hub-Signature-256', signature);

    return request.send(body);
  }

  function payload(input: {
    accountId: string;
    senderId?: string;
    text?: string;
    mid?: string;
    extra?: Record<string, unknown>;
  }) {
    const message: Record<string, unknown> = {
      mid: input.mid ?? `mid.${unique()}`,
      ...(input.text !== undefined ? { text: input.text } : { text: 'Do you ship to Pune?' }),
      ...(input.extra ?? {}),
    };

    return {
      object: 'instagram',
      entry: [
        {
          id: input.accountId,
          time: Date.now(),
          messaging: [
            {
              sender: { id: input.senderId ?? `igsid.${unique()}` },
              recipient: { id: input.accountId },
              timestamp: Date.now(),
              message,
            },
          ],
        },
      ],
    };
  }

  async function connect(organizationId: string, accountId: string): Promise<string> {
    const created = await tenancy.runForOrganization(organizationId, 'test: connect instagram', () =>
      prisma.client.channelIntegration.create({
        data: {
          organizationId,
          channel: 'INSTAGRAM',
          status: 'CONNECTED',
          enabled: true,
          providerAccountId: accountId,
          displayName: '@testbusiness',
        },
      }),
    );
    return created.id;
  }

  async function countMessages(organizationId: string): Promise<number> {
    return tenancy.runForOrganization(organizationId, 'test: count', () =>
      prisma.client.message.count({ where: { channel: 'INSTAGRAM' } }),
    );
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    prisma = ctx.app.get(PrismaService);
    tenancy = ctx.app.get(TenantContextService);

    await connect(ctx.orgA.id, accounts.a);
    await connect(ctx.orgB.id, accounts.b);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ===========================================================================
  // Verification and signature
  // ===========================================================================

  describe('subscription verification', () => {
    it('echoes the challenge for the correct verify token', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/webhooks/instagram')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': '99887766',
        });

      expect(response.status).toBe(200);
      expect(response.text).toContain('99887766');
    });

    it('refuses a wrong verify token without hinting at the real one', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/webhooks/instagram')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'guessed',
          'hub.challenge': '99887766',
        });

      expect(response.status).toBe(403);
      expect(response.text).not.toContain(VERIFY_TOKEN);
    });

    it('does not accept the WhatsApp verify token', async () => {
      // Separate products, separate secrets. Sharing one by accident would
      // mean a leak of either compromised both.
      const response = await ctx
        .http()
        .get('/api/v1/webhooks/instagram')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'test-whatsapp-verify-token',
          'hub.challenge': '1',
        });

      expect(response.status).toBe(403);
    });
  });

  describe('signature validation', () => {
    it('rejects an unsigned request and writes NOTHING', async () => {
      const before = await countMessages(ctx.orgA.id);

      const response = await deliver(payload({ accountId: accounts.a }), { signature: null });

      expect(response.status).toBe(403);
      expect(await countMessages(ctx.orgA.id)).toBe(before);
    });

    it('rejects a body signed with the WhatsApp secret', async () => {
      const before = await countMessages(ctx.orgA.id);
      const body = JSON.stringify(payload({ accountId: accounts.a }));

      const response = await ctx
        .http()
        .post('/api/v1/webhooks/instagram')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', sign(body, 'test-whatsapp-app-secret'))
        .send(body);

      expect(response.status).toBe(403);
      expect(await countMessages(ctx.orgA.id)).toBe(before);
    });

    it('rejects a body altered after signing', async () => {
      const before = await countMessages(ctx.orgA.id);
      const original = JSON.stringify(payload({ accountId: accounts.a }));
      const tampered = JSON.stringify(payload({ accountId: accounts.b }));

      const response = await ctx
        .http()
        .post('/api/v1/webhooks/instagram')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', sign(original))
        .send(tampered);

      expect(response.status).toBe(403);
      expect(await countMessages(ctx.orgA.id)).toBe(before);
    });

    it('accepts a correctly signed request', async () => {
      const response = await deliver(payload({ accountId: accounts.a }));
      expect(response.status).toBe(200);
    });
  });

  // ===========================================================================
  // Tenant resolution
  // ===========================================================================

  describe('tenant resolution', () => {
    it('routes a DM to the organization that owns the account', async () => {
      const beforeB = await countMessages(ctx.orgB.id);

      await deliver(payload({ accountId: accounts.a }));

      expect(await countMessages(ctx.orgB.id)).toBe(beforeB);
    });

    it('ignores an account nobody has connected, choosing no tenant at all', async () => {
      const beforeA = await countMessages(ctx.orgA.id);
      const beforeB = await countMessages(ctx.orgB.id);

      const response = await deliver(payload({ accountId: '17841499999999999' }));

      // 200: Meta must not retry something that will never succeed.
      expect(response.status).toBe(200);
      expect(await countMessages(ctx.orgA.id)).toBe(beforeA);
      expect(await countMessages(ctx.orgB.id)).toBe(beforeB);
    });

    it('never lets one organization’s account create data under another', async () => {
      const beforeA = await countMessages(ctx.orgA.id);

      await deliver(payload({ accountId: accounts.b }));

      expect(await countMessages(ctx.orgA.id)).toBe(beforeA);
    });
  });

  // ===========================================================================
  // Integration state
  // ===========================================================================

  describe('integration state', () => {
    async function withStatus(
      changes: Record<string, unknown>,
      run: () => Promise<void>,
    ): Promise<void> {
      const integration = await tenancy.runForOrganization(ctx.orgA.id, 'test: find', () =>
        prisma.client.channelIntegration.findFirst({ where: { channel: 'INSTAGRAM' } }),
      );

      await tenancy.runForOrganization(ctx.orgA.id, 'test: change', () =>
        prisma.client.channelIntegration.update({ where: { id: integration!.id }, data: changes }),
      );

      try {
        await run();
      } finally {
        await tenancy.runForOrganization(ctx.orgA.id, 'test: restore', () =>
          prisma.client.channelIntegration.update({
            where: { id: integration!.id },
            data: { enabled: true, status: 'CONNECTED' },
          }),
        );
      }
    }

    it('ingests nothing while the integration is disabled', async () => {
      await withStatus({ enabled: false }, async () => {
        const before = await countMessages(ctx.orgA.id);
        const response = await deliver(payload({ accountId: accounts.a }));

        // Acknowledged, not errored: disabled is a choice, not a failure.
        expect(response.status).toBe(200);
        expect(await countMessages(ctx.orgA.id)).toBe(before);
      });
    });

    it.each(['CONNECTING', 'DISCONNECTED', 'ERROR'] as const)(
      'ingests nothing while the integration is %s',
      async (status) => {
        await withStatus({ status }, async () => {
          const before = await countMessages(ctx.orgA.id);
          const response = await deliver(payload({ accountId: accounts.a }));

          expect(response.status).toBe(200);
          expect(await countMessages(ctx.orgA.id)).toBe(before);
        });
      },
    );
  });

  // ===========================================================================
  // The existing pipeline, reused
  // ===========================================================================

  describe('a DM from someone unknown', () => {
    it('is stored, resolves to nobody, and reaches the review queue', async () => {
      const text = 'What is your MOQ for onion powder?';

      await deliver(payload({ accountId: accounts.a, text }));

      const queue = await ctx
        .http()
        .get('/api/v1/conversations/review')
        .set(auth(ctx.orgA.owner.accessToken));

      const row = queue.body.data.items.find(
        (item: { lastMessagePreview: string | null }) => item.lastMessagePreview === text,
      );

      expect(row).toBeDefined();
      expect(row.channel).toBe('INSTAGRAM');
      // Instagram gives no phone number, so identity resolution correctly
      // declines to guess who this is.
      expect(row.contact).toBeNull();
      // Phase C's keyword rules applied without knowing about Instagram.
      expect(row.potentialLead).toBe(true);
      expect(row.potentialLeadSignals).toEqual(expect.arrayContaining(['moq']));
    });

    it('does NOT merge an Instagram sender with an existing WhatsApp contact', async () => {
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

      await deliver(payload({ accountId: accounts.a, text: 'pricing please' }));

      const conversations = await ctx
        .http()
        .get('/api/v1/conversations')
        .query({ leadId: lead.body.data.id })
        .set(auth(ctx.orgA.owner.accessToken));

      // A false identity merge is worse than a duplicate identity: it puts one
      // customer's messages into another customer's history, permanently.
      expect(conversations.body.data).toHaveLength(0);
    });
  });

  describe('a returning Instagram sender', () => {
    it('reuses the same conversation rather than creating a second', async () => {
      const senderId = `igsid.${unique()}`;

      await deliver(payload({ accountId: accounts.a, senderId, text: 'first' }));
      await deliver(payload({ accountId: accounts.a, senderId, text: 'second' }));

      const conversations = await tenancy.runForOrganization(ctx.orgA.id, 'test: count', () =>
        prisma.client.conversation.count({
          where: { externalConversationId: `${accounts.a}:${senderId}` },
        }),
      );

      expect(conversations).toBe(1);
    });

    it('appears in the unified inbox under the Instagram filter', async () => {
      await deliver(payload({ accountId: accounts.a, text: 'quote please' }));

      const inbox = await ctx
        .http()
        .get('/api/v1/conversations/inbox')
        .query({ channel: 'INSTAGRAM' })
        .set(auth(ctx.orgA.owner.accessToken));

      expect(inbox.status).toBe(200);
      expect(inbox.body.data.items.length).toBeGreaterThan(0);
      expect(inbox.body.data.items.every((i: { channel: string }) => i.channel === 'INSTAGRAM')).toBe(
        true,
      );
    });
  });

  // ===========================================================================
  // Replying is not supported
  // ===========================================================================

  describe('canSend', () => {
    it('is false, with a channel-appropriate reason', async () => {
      const senderId = `igsid.${unique()}`;
      await deliver(payload({ accountId: accounts.a, senderId, text: 'hello' }));

      const conversation = await tenancy.runForOrganization(ctx.orgA.id, 'test: find', () =>
        prisma.client.conversation.findFirst({
          where: { externalConversationId: `${accounts.a}:${senderId}` },
        }),
      );

      const detail = await ctx
        .http()
        .get(`/api/v1/conversations/${conversation!.id}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(detail.body.data.canSend).toBe(false);
      expect(detail.body.data.sendDisabledReason).toMatch(/not available for this channel/i);
    });

    it('refuses an attempt to send anyway', async () => {
      const senderId = `igsid.${unique()}`;
      await deliver(payload({ accountId: accounts.a, senderId, text: 'hello' }));

      const conversation = await tenancy.runForOrganization(ctx.orgA.id, 'test: find', () =>
        prisma.client.conversation.findFirst({
          where: { externalConversationId: `${accounts.a}:${senderId}` },
        }),
      );

      const response = await ctx
        .http()
        .post(`/api/v1/conversations/${conversation!.id}/messages`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ content: 'we ship everywhere', idempotencyKey: `key-${unique()}` });

      // Hiding the composer is presentation; the API is what enforces it.
      expect(response.status).toBe(409);
    });
  });

  // ===========================================================================
  // Idempotency and batches
  // ===========================================================================

  describe('duplicate delivery', () => {
    it('stores one message however many times Meta delivers it', async () => {
      const before = await countMessages(ctx.orgA.id);
      const body = payload({ accountId: accounts.a, mid: `mid.${unique()}` });

      await deliver(body);
      await deliver(body);
      await deliver(body);

      expect(await countMessages(ctx.orgA.id)).toBe(before + 1);
    });
  });

  describe('unusual payloads', () => {
    it('ignores an echo of the business’s own message', async () => {
      const before = await countMessages(ctx.orgA.id);

      const response = await deliver(
        payload({
          accountId: accounts.a,
          senderId: accounts.a,
          extra: { is_echo: true },
        }),
      );

      // Ingesting one would open a conversation with the business as the
      // customer, and potentially a lead against itself.
      expect(response.status).toBe(200);
      expect(await countMessages(ctx.orgA.id)).toBe(before);
    });

    it('records an attachment with its real type and no content', async () => {
      const senderId = `igsid.${unique()}`;

      await deliver({
        object: 'instagram',
        entry: [
          {
            id: accounts.a,
            messaging: [
              {
                sender: { id: senderId },
                recipient: { id: accounts.a },
                timestamp: Date.now(),
                message: {
                  mid: `mid.${unique()}`,
                  attachments: [{ type: 'image', payload: { url: 'https://example.test/i.jpg' } }],
                },
              },
            ],
          },
        ],
      });

      const stored = await tenancy.runForOrganization(ctx.orgA.id, 'test: read', () =>
        prisma.client.message.findFirst({
          where: { conversation: { externalConversationId: `${accounts.a}:${senderId}` } },
        }),
      );

      expect(stored?.messageType).toBe('IMAGE');
      // Not an empty text message, and no media downloaded.
      expect(stored?.content).toBeNull();
    });

    it('processes every event in one delivery', async () => {
      const before = await countMessages(ctx.orgA.id);
      const senderId = `igsid.${unique()}`;

      await deliver({
        object: 'instagram',
        entry: [
          {
            id: accounts.a,
            messaging: [
              {
                sender: { id: senderId },
                recipient: { id: accounts.a },
                timestamp: Date.now(),
                message: { mid: `mid.${unique()}`, text: 'one' },
              },
              {
                sender: { id: senderId },
                recipient: { id: accounts.a },
                timestamp: Date.now(),
                message: { mid: `mid.${unique()}`, text: 'two' },
              },
            ],
          },
        ],
      });

      expect(await countMessages(ctx.orgA.id)).toBe(before + 2);
    });
  });

  // ===========================================================================
  // Visibility and setup permissions
  // ===========================================================================

  describe('visibility and setup', () => {
    it('obeys the existing conversation visibility policy', async () => {
      const senderId = `igsid.${unique()}`;
      await deliver(payload({ accountId: accounts.a, senderId, text: 'unowned enquiry' }));

      const conversation = await tenancy.runForOrganization(ctx.orgA.id, 'test: find', () =>
        prisma.client.conversation.findFirst({
          where: { externalConversationId: `${accounts.a}:${senderId}` },
        }),
      );

      // Unowned and unlinked, with the shared queue off by default — invisible
      // to a rep, exactly as a WhatsApp conversation in the same state.
      const asRep = await ctx
        .http()
        .get(`/api/v1/conversations/${conversation!.id}`)
        .set(auth(ctx.orgA.rep.accessToken));
      expect(asRep.status).toBe(404);

      const asOwner = await ctx
        .http()
        .get(`/api/v1/conversations/${conversation!.id}`)
        .set(auth(ctx.orgA.owner.accessToken));
      expect(asOwner.status).toBe(200);
    });

    it('does not show organization B an organization A conversation', async () => {
      const senderId = `igsid.${unique()}`;
      await deliver(payload({ accountId: accounts.a, senderId, text: 'private' }));

      const conversation = await tenancy.runForOrganization(ctx.orgA.id, 'test: find', () =>
        prisma.client.conversation.findFirst({
          where: { externalConversationId: `${accounts.a}:${senderId}` },
        }),
      );

      const peek = await ctx
        .http()
        .get(`/api/v1/conversations/${conversation!.id}`)
        .set(auth(ctx.orgB.owner.accessToken));

      expect(peek.status).toBe(404);
    });

    it('reports Instagram as connectable but never returns a credential', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/channel-integrations')
        .set(auth(ctx.orgA.owner.accessToken));

      const instagram = response.body.data.find(
        (row: { channel: string }) => row.channel === 'INSTAGRAM',
      );

      expect(instagram.connectable).toBe(true);
      expect(JSON.stringify(response.body)).not.toContain('encryptedAccessToken');
    });

    it('refuses a sales rep the ability to connect an account', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/channel-integrations/instagram/connect')
        .set(auth(ctx.orgA.rep.accessToken))
        .send({ instagramAccountId: '123', accessToken: 'irrelevant' });

      expect(response.status).toBe(403);
    });

    it('refuses an account already connected to another organization', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/channel-integrations/instagram/connect')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ instagramAccountId: accounts.b, accessToken: 'some-token' });

      expect(response.status).toBe(409);
    });
  });

  // ===========================================================================
  // WhatsApp is untouched
  // ===========================================================================

  describe('WhatsApp is unaffected', () => {
    it('still rejects an Instagram-signed body on the WhatsApp endpoint', async () => {
      const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

      const response = await ctx
        .http()
        .post('/api/v1/webhooks/whatsapp')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', sign(body, APP_SECRET))
        .send(body);

      expect(response.status).toBe(403);
    });

    it('still verifies its own subscription token', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/webhooks/whatsapp')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'test-whatsapp-verify-token',
          'hub.challenge': '424242',
        });

      expect(response.status).toBe(200);
      expect(response.text).toContain('424242');
    });
  });
});
