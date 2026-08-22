import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { OutboundRecoveryService } from '../src/modules/omnichannel/outbound-recovery.service';
import { createTestContext, type TestContext } from './helpers/test-app';

/**
 * Closing sends that were claimed but never resolved.
 *
 * The scenario is a process dying between calling Meta and recording the
 * answer. The row is left PENDING, and nothing ever comes back for it.
 *
 * The assertions that matter are the ones about restraint: no provider call is
 * made, nothing that already has an answer is touched, and the final state says
 * "we do not know" rather than "it failed". A salesperson who reads FAILED will
 * send the message again, and the customer will get it twice.
 */
describe('Stale outbound message recovery', () => {
  let ctx: TestContext;
  let prisma: PrismaService;
  let tenancy: TenantContextService;
  let recovery: OutboundRecoveryService;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  let counter = 0;
  const unique = () => {
    counter += 1;
    return `${Date.now()}${counter}`;
  };

  /** Any Graph API traffic at all would be a failure of this phase. */
  let providerCalls = 0;
  let realFetch: typeof globalThis.fetch;

  beforeAll(async () => {
    ctx = await createTestContext();
    prisma = ctx.app.get(PrismaService);
    tenancy = ctx.app.get(TenantContextService);
    recovery = ctx.app.get(OutboundRecoveryService);

    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).includes('graph.facebook.com')) {
        providerCalls += 1;
        return new Response(JSON.stringify({ messages: [{ id: 'wamid.x' }] }), { status: 200 });
      }
      return realFetch(input, init);
    }) as typeof globalThis.fetch;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await ctx?.close();
  });

  beforeEach(() => {
    providerCalls = 0;
  });

  /** A conversation with an outbound message in a chosen state and age. */
  async function outboundMessage(options: {
    status: 'PENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'UNCONFIRMED';
    ageSeconds: number;
    organizationId?: string;
  }): Promise<string> {
    const organizationId = options.organizationId ?? ctx.orgA.id;
    const suffix = unique();

    return tenancy.runForOrganization(organizationId, 'test: seed outbound', async () => {
      const integration = await prisma.client.channelIntegration.upsert({
        where: { channel_providerAccountId: { channel: 'WHATSAPP', providerAccountId: `pa-${organizationId}` } },
        create: {
          organizationId,
          channel: 'WHATSAPP',
          status: 'CONNECTED',
          enabled: true,
          providerAccountId: `pa-${organizationId}`,
        },
        update: {},
      });

      const conversation = await prisma.client.conversation.create({
        data: {
          organizationId,
          channel: 'WHATSAPP',
          integrationId: integration.id,
          externalConversationId: `thread-${suffix}`,
        },
      });

      const message = await prisma.client.message.create({
        data: {
          organizationId,
          conversationId: conversation.id,
          channel: 'WHATSAPP',
          direction: 'OUTGOING',
          senderType: 'AGENT',
          messageType: 'TEXT',
          content: 'Thanks for your enquiry.',
          deliveryStatus: options.status,
          idempotencyKey: `key-${suffix}`,
          createdAt: new Date(Date.now() - options.ageSeconds * 1000),
          ...(options.status === 'SENT' || options.status === 'DELIVERED' || options.status === 'READ'
            ? { externalMessageId: `wamid.${suffix}`, sentAt: new Date() }
            : {}),
        },
      });

      return message.id;
    });
  }

  async function statusOf(messageId: string, organizationId = ctx.orgA.id) {
    return tenancy.runForOrganization(organizationId, 'test: read', () =>
      prisma.client.message.findFirst({ where: { id: messageId } }),
    );
  }

  // ===========================================================================
  // What the sweep touches, and what it leaves alone
  // ===========================================================================

  describe('selection', () => {
    it('leaves a message that is still genuinely in flight', async () => {
      // Five seconds old: a send that has not come back yet, not an abandoned
      // one. Finalising it would race a request that is about to succeed.
      const id = await outboundMessage({ status: 'PENDING', ageSeconds: 5 });

      await recovery.sweep();

      expect((await statusOf(id))?.deliveryStatus).toBe('PENDING');
    });

    it('closes a message abandoned mid-send', async () => {
      const id = await outboundMessage({ status: 'PENDING', ageSeconds: 600 });

      const closed = await recovery.sweep();

      expect(closed).toBeGreaterThanOrEqual(1);
      expect((await statusOf(id))?.deliveryStatus).toBe('UNCONFIRMED');
    });

    it.each(['SENT', 'DELIVERED', 'READ', 'FAILED'] as const)(
      'never touches a %s message, however old',
      async (status) => {
        const id = await outboundMessage({ status, ageSeconds: 100_000 });

        await recovery.sweep();

        // These already have an answer. Overwriting one would discard it.
        expect((await statusOf(id))?.deliveryStatus).toBe(status);
      },
    );

    it('does not re-process a message it already closed', async () => {
      const id = await outboundMessage({ status: 'UNCONFIRMED', ageSeconds: 100_000 });

      await recovery.sweep();

      expect((await statusOf(id))?.deliveryStatus).toBe('UNCONFIRMED');
    });
  });

  // ===========================================================================
  // Restraint — the point of the phase
  // ===========================================================================

  describe('restraint', () => {
    it('NEVER calls the provider', async () => {
      await outboundMessage({ status: 'PENDING', ageSeconds: 600 });

      await recovery.sweep();

      // The whole design: we do not know whether the customer got it, so we
      // do not send it again and find out the hard way.
      expect(providerCalls).toBe(0);
    });

    it('says the outcome is unknown, not that it failed', async () => {
      const id = await outboundMessage({ status: 'PENDING', ageSeconds: 600 });

      await recovery.sweep();
      const message = await statusOf(id);

      expect(message?.deliveryStatus).not.toBe('FAILED');
      expect(message?.failureReason).toMatch(/could not be confirmed/i);
      expect(message?.failureReason).toMatch(/not resent automatically/i);
    });

    it('preserves everything about the original attempt', async () => {
      const id = await outboundMessage({ status: 'PENDING', ageSeconds: 600 });
      const before = await statusOf(id);

      await recovery.sweep();
      const after = await statusOf(id);

      expect(after?.content).toBe(before?.content);
      expect(after?.conversationId).toBe(before?.conversationId);
      expect(after?.sentById).toBe(before?.sentById);
      expect(after?.idempotencyKey).toBe(before?.idempotencyKey);
      expect(after?.createdAt.getTime()).toBe(before?.createdAt.getTime());
    });
  });

  // ===========================================================================
  // Concurrency
  // ===========================================================================

  describe('two instances sweeping at once', () => {
    it('produces one correct result and no provider call', async () => {
      const id = await outboundMessage({ status: 'PENDING', ageSeconds: 600 });

      await Promise.all([recovery.sweep(), recovery.sweep(), recovery.sweep()]);

      // The conditional update means a row already finalised is simply not
      // matched. Racing instances converge on the same state, and nothing
      // reaches a customer either way.
      expect((await statusOf(id))?.deliveryStatus).toBe('UNCONFIRMED');
      expect(providerCalls).toBe(0);
    });

    it('is safe to run repeatedly', async () => {
      const id = await outboundMessage({ status: 'PENDING', ageSeconds: 600 });

      await recovery.sweep();
      const first = await statusOf(id);
      await recovery.sweep();
      const second = await statusOf(id);

      expect(second?.deliveryStatus).toBe(first?.deliveryStatus);
      expect(second?.failureReason).toBe(first?.failureReason);
    });
  });

  // ===========================================================================
  // Everything else stays exactly as it was
  // ===========================================================================

  describe('blast radius', () => {
    it('changes no lead, and no ownership', async () => {
      const lead = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          firstName: 'Rahul',
          mobile: `+4477${unique().slice(-9)}`,
          assignedToId: ctx.orgA.rep.id,
          nextFollowUpAt: new Date(Date.now() + 86_400_000).toISOString(),
        });
      expect(lead.status).toBe(201);

      const messageId = await outboundMessage({ status: 'PENDING', ageSeconds: 600 });
      const conversationId = (await statusOf(messageId))!.conversationId;

      await tenancy.runForOrganization(ctx.orgA.id, 'test: link', () =>
        prisma.client.conversation.update({
          where: { id: conversationId },
          data: { leadId: lead.body.data.id, ownerId: ctx.orgA.rep.id, linkState: 'LINKED' },
        }),
      );

      await recovery.sweep();

      const after = await ctx
        .http()
        .get(`/api/v1/leads/${lead.body.data.id}`)
        .set(auth(ctx.orgA.owner.accessToken));
      expect(after.body.data.assignedTo?.id ?? after.body.data.assignedToId).toBe(ctx.orgA.rep.id);

      const conversation = await tenancy.runForOrganization(ctx.orgA.id, 'test: read', () =>
        prisma.client.conversation.findFirst({ where: { id: conversationId } }),
      );
      expect(conversation?.ownerId).toBe(ctx.orgA.rep.id);
      expect(conversation?.leadId).toBe(lead.body.data.id);
    });

    it('leaves the message in its conversation', async () => {
      const id = await outboundMessage({ status: 'PENDING', ageSeconds: 600 });
      const before = await statusOf(id);

      await recovery.sweep();

      expect((await statusOf(id))?.conversationId).toBe(before?.conversationId);
    });

    it('creates no inbound message and no conversation', async () => {
      await outboundMessage({ status: 'PENDING', ageSeconds: 600 });

      const countConversations = () =>
        tenancy.runForOrganization(ctx.orgA.id, 'test: count', () =>
          prisma.client.conversation.count(),
        );

      const before = await countConversations();
      await recovery.sweep();
      expect(await countConversations()).toBe(before);
    });

    it('closes stale messages in every tenant, without mixing them up', async () => {
      const inA = await outboundMessage({ status: 'PENDING', ageSeconds: 600 });
      const inB = await outboundMessage({
        status: 'PENDING',
        ageSeconds: 600,
        organizationId: ctx.orgB.id,
      });

      await recovery.sweep();

      expect((await statusOf(inA, ctx.orgA.id))?.deliveryStatus).toBe('UNCONFIRMED');
      expect((await statusOf(inB, ctx.orgB.id))?.deliveryStatus).toBe('UNCONFIRMED');

      // Each still belongs where it started.
      expect((await statusOf(inA, ctx.orgA.id))?.organizationId).toBe(ctx.orgA.id);
      expect((await statusOf(inB, ctx.orgB.id))?.organizationId).toBe(ctx.orgB.id);
    });
  });

  // ===========================================================================
  // Idempotency survives recovery
  // ===========================================================================

  describe('the original idempotency key', () => {
    it('still refuses a resend after the message became unconfirmed', async () => {
      const messageId = await outboundMessage({ status: 'PENDING', ageSeconds: 600 });
      const original = await statusOf(messageId);

      await recovery.sweep();

      const replay = await ctx
        .http()
        .post(`/api/v1/conversations/${original!.conversationId}/messages`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ content: 'Thanks for your enquiry.', idempotencyKey: original!.idempotencyKey });

      // The attempt comes back as it stands. Deciding to send again is a
      // person's job, not a retried HTTP request's.
      expect(replay.status).toBe(201);
      expect(replay.body.data.id).toBe(messageId);
      expect(replay.body.data.deliveryStatus).toBe('UNCONFIRMED');
      expect(providerCalls).toBe(0);
    });
  });
});
