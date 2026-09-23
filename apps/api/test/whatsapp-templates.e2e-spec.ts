import { createHmac } from 'node:crypto';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { createTestContext, type TestContext } from './helpers/test-app';
import { fixtureProviderDigits } from './helpers/phone-fixtures';

/**
 * WhatsApp template messaging.
 *
 * Meta is stubbed at `fetch`, so everything above that boundary runs for real:
 * authorization, the template cache, the 24-hour rule, parameter validation,
 * idempotency and the claim-before-send ordering. The stub records what would
 * have reached the provider.
 *
 * Two properties are worth more than all the others here, and most of the
 * cases below exist to defend one of them:
 *
 *   1. A template is only ever sent because a person chose one. Nothing falls
 *      back to a template when a free-form send is refused, and no request that
 *      merely carries text can produce one.
 *
 *   2. Meta decides what is approved. LeadFlow stores that answer and re-checks
 *      it; it never manufactures one.
 *
 * The valuable assertions are therefore the ones where NOTHING reaches the
 * provider, and the one where the free-form composer stays refused even while
 * a template is available.
 */
describe('WhatsApp templates', () => {
  let ctx: TestContext;
  let prisma: PrismaService;
  let tenancy: TenantContextService;

  const APP_SECRET = 'test-whatsapp-app-secret';
  /*
   * Distinct from every other spec's numbers.
   *
   * (channel, provider_account_id) is unique ACROSS tenants — one WhatsApp
   * number belongs to one organization — and the E2E database is shared by
   * every spec file, so reusing another file's number collides on that index
   * rather than testing anything.
   */
  const numbers = { a: '206540000000011', b: '206540000000012' };
  const WABA = { a: '900000000000001', b: '900000000000002' };

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  let counter = 0;
  const unique = () => {
    counter += 1;
    return `${Date.now()}${counter}`;
  };

  /** Every POST the code made to Graph. */
  let sends: { url: string; body: Record<string, unknown> }[] = [];
  /** Every template-list GET the code made, with the bearer it presented. */
  let listCalls: { url: string; authorization: string | null }[] = [];
  /** What the next template-list GET should return. */
  let templateResponse: { status: number; body: unknown } = { status: 200, body: { data: [] } };
  /** What the next send POST should return. */
  let sendResponse: { status: number; body: unknown } = {
    status: 200,
    body: { messages: [{ id: 'wamid.default' }] },
  };
  let realFetch: typeof globalThis.fetch;

  const BODY_TEXT = 'Hi {{1}}, your order {{2}} is ready for collection.';

  /** One template in the shape Meta's Graph API returns. */
  const metaTemplate = (overrides: Record<string, unknown> = {}) => ({
    id: '11111111',
    name: 'order_ready',
    language: 'en_US',
    category: 'UTILITY',
    status: 'APPROVED',
    components: [{ type: 'BODY', text: BODY_TEXT }],
    ...overrides,
  });

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
        return new Response(JSON.stringify(sendResponse.body), {
          status: sendResponse.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.includes('/message_templates')) {
        const headers = new Headers(init?.headers ?? {});
        listCalls.push({ url, authorization: headers.get('authorization') });
        return new Response(JSON.stringify(templateResponse.body), {
          status: templateResponse.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // The connect-time validation GET.
      return new Response(JSON.stringify({ verified_name: 'Test Business' }), { status: 200 });
    }) as typeof globalThis.fetch;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await ctx?.close();
  });

  beforeEach(() => {
    sends = [];
    listCalls = [];
    templateResponse = { status: 200, body: { data: [metaTemplate()] } };
    sendResponse = { status: 200, body: { messages: [{ id: `wamid.${unique()}` }] } };
  });

  // --- fixtures --------------------------------------------------------------

  function sign(body: string): string {
    return `sha256=${createHmac('sha256', APP_SECRET).update(Buffer.from(body)).digest('hex')}`;
  }

  /** An inbound message, which is what opens the 24-hour window. */
  async function customerWrites(digits: string, phoneNumberId = numbers.a) {
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '102290129340398',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: phoneNumberId },
                contacts: [{ profile: { name: 'Rahul' }, wa_id: digits }],
                messages: [
                  {
                    from: digits,
                    id: `wamid.${unique()}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: 'Do you have stock?' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    return ctx
      .http()
      .post('/api/v1/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);
  }

  async function conversationFor(digits: string, phoneNumberId = numbers.a): Promise<string> {
    const org = phoneNumberId === numbers.a ? ctx.orgA.id : ctx.orgB.id;
    const conversation = await tenancy.runForOrganization(org, 'test: find', () =>
      prisma.client.conversation.findFirst({
        where: { externalConversationId: `${phoneNumberId}:${digits}` },
      }),
    );
    expect(conversation).not.toBeNull();
    return conversation!.id;
  }

  /** Connects WhatsApp with a real encrypted token and a business account id. */
  async function connect(
    org: 'a' | 'b' = 'a',
    overrides: Record<string, unknown> = {},
  ): Promise<void> {
    const seeded = org === 'a' ? ctx.orgA : ctx.orgB;
    const response = await ctx
      .http()
      .post('/api/v1/channel-integrations/whatsapp/connect')
      .set(auth(seeded.owner.accessToken))
      .send({
        phoneNumberId: org === 'a' ? numbers.a : numbers.b,
        businessAccountId: org === 'a' ? WABA.a : WABA.b,
        accessToken: `EAAG-test-token-${org}`,
        ...overrides,
      });

    expect(response.status).toBe(200);
  }

  function syncTemplates(org: 'a' | 'b' = 'a', token?: string) {
    const seeded = org === 'a' ? ctx.orgA : ctx.orgB;
    return ctx
      .http()
      .post('/api/v1/channel-integrations/whatsapp/templates/sync')
      .set(auth(token ?? seeded.owner.accessToken))
      .send({});
  }

  function listTemplates(org: 'a' | 'b' = 'a', token?: string) {
    const seeded = org === 'a' ? ctx.orgA : ctx.orgB;
    return ctx
      .http()
      .get('/api/v1/channel-integrations/whatsapp/templates')
      .set(auth(token ?? seeded.owner.accessToken));
  }

  function sendTemplate(
    conversationId: string,
    body: Record<string, unknown>,
    token?: string,
  ) {
    return ctx
      .http()
      .post(`/api/v1/conversations/${conversationId}/template-messages`)
      .set(auth(token ?? ctx.orgA.owner.accessToken))
      .send({
        templateName: 'order_ready',
        language: 'en_US',
        bodyParameters: ['Rahul', 'A-1024'],
        idempotencyKey: `tpl-${unique()}`,
        ...body,
      });
  }

  /** Moves the customer's last message back beyond the 24-hour window. */
  async function closeWindow(conversationId: string, org = ctx.orgA.id): Promise<void> {
    const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await tenancy.runForOrganization(org, 'test: age the window', () =>
      prisma.client.message.updateMany({
        where: { conversationId, direction: 'INCOMING' },
        data: { sentAt: past, createdAt: past },
      }),
    );
  }

  // ===========================================================================
  // Discovery
  // ===========================================================================

  describe('loading templates from Meta', () => {
    it('stores what Meta reported and reports the counts', async () => {
      await connect();
      const response = await syncTemplates();

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ total: 1, supported: 1, approved: 1 });
      expect(listCalls).toHaveLength(1);
      expect(listCalls[0]!.url).toContain(WABA.a);
    });

    it('asks Meta for the business ACCOUNT, not the phone number', async () => {
      // Templates belong to the WhatsApp Business Account. Asking against the
      // phone number id returns nothing at all, which would look like "you have
      // no templates" rather than a misconfiguration.
      await connect();
      await syncTemplates();

      expect(listCalls[0]!.url).not.toContain(numbers.a);
    });

    it('refuses when no business account id was provided', async () => {
      await connect('a', { businessAccountId: undefined });
      const response = await syncTemplates();

      expect(response.status).toBe(409);
      // Actionable: it names the setting to fill in.
      expect(response.body.error.message).toMatch(/business account id/i);
      expect(listCalls).toHaveLength(0);
    });

    it('refuses before WhatsApp is connected', async () => {
      await ctx
        .http()
        .post('/api/v1/channel-integrations/whatsapp/disconnect')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({});

      const response = await syncTemplates();

      expect(response.status).toBe(409);
      expect(listCalls).toHaveLength(0);
    });

    it('does not create or approve anything of its own', async () => {
      // There is no endpoint for it, and this is the assertion that says so.
      await connect();
      const create = await ctx
        .http()
        .post('/api/v1/channel-integrations/whatsapp/templates')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ name: 'invented', language: 'en_US', status: 'APPROVED' });

      expect(create.status).toBe(404);
    });

    describe('what Meta says is what is stored', () => {
      it.each(['PENDING', 'REJECTED', 'PAUSED', 'DISABLED'])(
        'keeps a %s template as %s rather than hiding it',
        async (status) => {
          // Shown, but not sendable. Hiding it would leave an owner wondering
          // where the template they created in Meta went.
          await connect();
          templateResponse = { status: 200, body: { data: [metaTemplate({ status })] } };
          await syncTemplates();

          const list = await listTemplates();
          expect(list.body.data.items).toHaveLength(1);
          expect(list.body.data.items[0].status).toBe(status);
        },
      );

      it('treats a status it does not recognise as DISABLED', async () => {
        // Failing closed. An unknown status must never become permission.
        await connect();
        templateResponse = {
          status: 200,
          body: { data: [metaTemplate({ status: 'SOMETHING_NEW' })] },
        };
        await syncTemplates();

        const list = await listTemplates();
        expect(list.body.data.items[0].status).toBe('DISABLED');
      });

      it('marks a media-header template unsupported, with a reason', async () => {
        await connect();
        templateResponse = {
          status: 200,
          body: {
            data: [
              metaTemplate({
                components: [
                  { type: 'HEADER', format: 'IMAGE' },
                  { type: 'BODY', text: BODY_TEXT },
                ],
              }),
            ],
          },
        };
        await syncTemplates();

        const list = await listTemplates();
        expect(list.body.data.items[0].supported).toBe(false);
        expect(list.body.data.items[0].unsupportedReason).toMatch(/image/i);
      });
    });

    it('removes a template that has disappeared from Meta', async () => {
      await connect();
      await syncTemplates();
      expect((await listTemplates()).body.data.items).toHaveLength(1);

      // Withdrawn at Meta. Leaving it would offer a send certain to fail.
      templateResponse = { status: 200, body: { data: [] } };
      await syncTemplates();

      expect((await listTemplates()).body.data.items).toHaveLength(0);
    });

    it('does not duplicate rows when synced twice', async () => {
      await connect();
      await syncTemplates();
      await syncTemplates();

      expect((await listTemplates()).body.data.items).toHaveLength(1);
    });

    it('surfaces a credential rejection as something to act on', async () => {
      await connect();
      templateResponse = { status: 401, body: { error: { code: 190 } } };

      const response = await syncTemplates();

      expect(response.status).toBe(409);
      expect(response.body.error.message).toMatch(/permission|credential/i);
    });

    it('never puts a provider body or a token into the response', async () => {
      await connect();
      templateResponse = {
        status: 400,
        body: { error: { message: 'access_token=EAAG-test-token-a is invalid', code: 100 } },
      };

      const response = await syncTemplates();
      const serialised = JSON.stringify(response.body);

      expect(serialised).not.toContain('EAAG-test-token');
      expect(serialised).not.toContain('access_token');
    });
  });

  // ===========================================================================
  // Authorization and isolation
  // ===========================================================================

  describe('who may do what', () => {
    it('lets a sales rep READ the list, because replying needs it', async () => {
      await connect();
      await syncTemplates();

      const response = await listTemplates('a', ctx.orgA.rep.accessToken);
      expect(response.status).toBe(200);
    });

    it('refuses a sales rep the sync, which spends the organization credential', async () => {
      await connect();
      const response = await syncTemplates('a', ctx.orgA.rep.accessToken);

      expect(response.status).toBe(403);
      expect(listCalls).toHaveLength(0);
    });

    it('never shows one organization another organization templates', async () => {
      await connect('a');
      await syncTemplates('a');

      await connect('b');
      templateResponse = {
        status: 200,
        body: { data: [metaTemplate({ name: 'org_b_only' })] },
      };
      await syncTemplates('b');

      const listA = await listTemplates('a');
      const names = listA.body.data.items.map((item: { name: string }) => item.name);

      expect(names).toEqual(['order_ready']);
      expect(names).not.toContain('org_b_only');
    });

    it('cannot send another organization template by naming it', async () => {
      // The name is what the send API takes, so this is the case that matters:
      // knowing a name must not be enough.
      await connect('a');
      templateResponse = { status: 200, body: { data: [] } };
      await syncTemplates('a');

      await connect('b');
      templateResponse = {
        status: 200,
        body: { data: [metaTemplate({ name: 'org_b_only' })] },
      };
      await syncTemplates('b');

      const digits = fixtureProviderDigits();
      await customerWrites(digits);
      const conversationId = await conversationFor(digits);

      const response = await sendTemplate(conversationId, { templateName: 'org_b_only' });

      expect(response.status).toBe(404);
      expect(sends).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Capability
  // ===========================================================================

  describe('canSendTemplate', () => {
    it('is true once the window has closed, while canSend stays false', async () => {
      /*
       * The central case of the whole feature. If `canSend` ever becomes true
       * here, the 24-hour rule has been weakened; if `canSendTemplate` is
       * false, there is no way out of a closed conversation.
       */
      await connect();
      await syncTemplates();

      const digits = fixtureProviderDigits();
      await customerWrites(digits);
      const conversationId = await conversationFor(digits);
      await closeWindow(conversationId);

      const detail = await ctx
        .http()
        .get(`/api/v1/conversations/${conversationId}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(detail.body.data.canSend).toBe(false);
      expect(detail.body.data.sendDisabledReason).toMatch(/24 hours/i);
      expect(detail.body.data.canSendTemplate).toBe(true);
    });

    it('is false when the organization has loaded no approved template', async () => {
      await connect();
      templateResponse = { status: 200, body: { data: [] } };
      await syncTemplates();

      const digits = fixtureProviderDigits();
      await customerWrites(digits);
      const conversationId = await conversationFor(digits);
      await closeWindow(conversationId);

      const detail = await ctx
        .http()
        .get(`/api/v1/conversations/${conversationId}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(detail.body.data.canSendTemplate).toBe(false);
      expect(detail.body.data.templateDisabledReason).toMatch(/approved in Meta/i);
    });

    it('is false when the only template is not approved', async () => {
      await connect();
      templateResponse = { status: 200, body: { data: [metaTemplate({ status: 'PENDING' })] } };
      await syncTemplates();

      const digits = fixtureProviderDigits();
      await customerWrites(digits);

      const detail = await ctx
        .http()
        .get(`/api/v1/conversations/${await conversationFor(digits)}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(detail.body.data.canSendTemplate).toBe(false);
    });
  });

  // ===========================================================================
  // Sending
  // ===========================================================================

  describe('sending a template', () => {
    async function readyConversation(): Promise<string> {
      await connect();
      await syncTemplates();
      const digits = fixtureProviderDigits();
      await customerWrites(digits);
      const conversationId = await conversationFor(digits);
      await closeWindow(conversationId);
      return conversationId;
    }

    it('sends the template Meta expects, outside the window', async () => {
      const conversationId = await readyConversation();
      const response = await sendTemplate(conversationId, {});

      expect(response.status).toBe(201);
      expect(sends).toHaveLength(1);
      expect(sends[0]!.body).toMatchObject({
        messaging_product: 'whatsapp',
        type: 'template',
        template: {
          name: 'order_ready',
          language: { code: 'en_US' },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: 'Rahul' },
                { type: 'text', text: 'A-1024' },
              ],
            },
          ],
        },
      });
    });

    it('appears in the same timeline as every other message', async () => {
      const conversationId = await readyConversation();
      await sendTemplate(conversationId, {});

      const detail = await ctx
        .http()
        .get(`/api/v1/conversations/${conversationId}`)
        .set(auth(ctx.orgA.owner.accessToken));

      const outgoing = detail.body.data.messages.filter(
        (message: { direction: string }) => message.direction === 'OUTGOING',
      );

      expect(outgoing).toHaveLength(1);
      expect(outgoing[0]).toMatchObject({
        messageType: 'TEMPLATE',
        deliveryStatus: 'SENT',
        // The RENDERED text, not the template name: it is what the customer
        // received, and it is what a salesperson reading the history needs.
        content: 'Hi Rahul, your order A-1024 is ready for collection.',
      });
    });

    it('does not touch conversation or lead ownership', async () => {
      const conversationId = await readyConversation();

      const before = await tenancy.runForOrganization(ctx.orgA.id, 'test: read owner', () =>
        prisma.client.conversation.findFirst({ where: { id: conversationId } }),
      );

      await sendTemplate(conversationId, {}, ctx.orgA.rep.accessToken);

      const after = await tenancy.runForOrganization(ctx.orgA.id, 'test: read owner', () =>
        prisma.client.conversation.findFirst({ where: { id: conversationId } }),
      );

      // Replying is not a claim on somebody else's deal.
      expect(after!.ownerId).toBe(before!.ownerId);
      expect(after!.leadId).toBe(before!.leadId);
    });

    it('records which template was used, without the customer values', async () => {
      const conversationId = await readyConversation();
      const response = await sendTemplate(conversationId, {});

      const message = await tenancy.runForOrganization(ctx.orgA.id, 'test: read message', () =>
        prisma.client.message.findFirst({ where: { id: response.body.data.id } }),
      );

      expect(message!.metadata).toMatchObject({
        template: { name: 'order_ready', language: 'en_US' },
      });

      const audit = await tenancy.runForOrganization(ctx.orgA.id, 'test: read audit', () =>
        prisma.client.auditLog.findFirst({
          where: { action: 'omnichannel.template_sent', entityId: conversationId },
          orderBy: { createdAt: 'desc' },
        }),
      );

      expect(audit).not.toBeNull();
      // The template name is a business decision worth recording. The values
      // are the customer's data and are not.
      expect(JSON.stringify(audit!.after)).toContain('order_ready');
      expect(JSON.stringify(audit!.after)).not.toContain('Rahul');
    });

    it('is idempotent: a retry returns the first attempt and sends nothing', async () => {
      const conversationId = await readyConversation();
      const idempotencyKey = `tpl-retry-${unique()}`;

      const first = await sendTemplate(conversationId, { idempotencyKey });
      const second = await sendTemplate(conversationId, { idempotencyKey });

      expect(first.status).toBe(201);
      expect(second.body.data.id).toBe(first.body.data.id);
      // A duplicate here is a second message to a real customer.
      expect(sends).toHaveLength(1);
    });

    it('does not send twice under concurrent identical requests', async () => {
      const conversationId = await readyConversation();
      const idempotencyKey = `tpl-race-${unique()}`;

      const [first, second] = await Promise.all([
        sendTemplate(conversationId, { idempotencyKey }),
        sendTemplate(conversationId, { idempotencyKey }),
      ]);

      expect([first.status, second.status].filter((status) => status === 201).length)
        .toBeGreaterThanOrEqual(1);
      expect(sends).toHaveLength(1);
    });

    it('marks the message FAILED and keeps the row when Meta refuses', async () => {
      const conversationId = await readyConversation();
      sendResponse = { status: 400, body: { error: { code: 132001 } } };

      const response = await sendTemplate(conversationId, {});

      expect(response.status).toBe(409);
      // Naming the fix: refresh the list, do not retry the same send.
      expect(response.body.error.message).toMatch(/refresh the template list/i);

      const detail = await ctx
        .http()
        .get(`/api/v1/conversations/${conversationId}`)
        .set(auth(ctx.orgA.owner.accessToken));

      const outgoing = detail.body.data.messages.filter(
        (message: { direction: string }) => message.direction === 'OUTGOING',
      );

      // The row survives the failure: a record of the attempt is what stops a
      // salesperson resending blind.
      expect(outgoing).toHaveLength(1);
      expect(outgoing[0].deliveryStatus).toBe('FAILED');
    });

    it('never returns a provider body or a token on failure', async () => {
      const conversationId = await readyConversation();
      sendResponse = {
        status: 400,
        body: { error: { message: 'token EAAG-test-token-a rejected', code: 132000 } },
      };

      const response = await sendTemplate(conversationId, {});

      expect(JSON.stringify(response.body)).not.toContain('EAAG-test-token');
    });
  });

  // ===========================================================================
  // What must never happen
  // ===========================================================================

  describe('the refusals that matter', () => {
    it('never falls back to a template when a free-form send is refused', async () => {
      /*
       * The single most important assertion in this file.
       *
       * A closed window refuses the ordinary send and stops there. It does not
       * quietly become a template, because a customer receiving a templated
       * message they did not expect — and an owner receiving the bill — is a
       * worse outcome than a refusal a salesperson can see and act on.
       */
      await connect();
      await syncTemplates();

      const digits = fixtureProviderDigits();
      await customerWrites(digits);
      const conversationId = await conversationFor(digits);
      await closeWindow(conversationId);

      const response = await ctx
        .http()
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ content: 'Are you still interested?', idempotencyKey: `key-${unique()}` });

      expect(response.status).toBe(409);
      expect(response.body.error.message).toMatch(/24 hours/i);
      expect(sends).toHaveLength(0);
    });

    it('refuses a template that is not approved in Meta', async () => {
      await connect();
      templateResponse = { status: 200, body: { data: [metaTemplate({ status: 'PAUSED' })] } };
      await syncTemplates();

      const digits = fixtureProviderDigits();
      await customerWrites(digits);
      const conversationId = await conversationFor(digits);

      const response = await sendTemplate(conversationId, {});

      expect(response.status).toBe(409);
      expect(response.body.error.message).toMatch(/paused/i);
      expect(sends).toHaveLength(0);
    });

    it('refuses a template LeadFlow cannot render correctly', async () => {
      await connect();
      templateResponse = {
        status: 200,
        body: {
          data: [
            metaTemplate({
              components: [
                { type: 'HEADER', format: 'DOCUMENT' },
                { type: 'BODY', text: BODY_TEXT },
              ],
            }),
          ],
        },
      };
      await syncTemplates();

      const digits = fixtureProviderDigits();
      await customerWrites(digits);

      const response = await sendTemplate(await conversationFor(digits), {});

      expect(response.status).toBe(409);
      expect(sends).toHaveLength(0);
    });

    it('refuses an unknown template rather than inventing one', async () => {
      await connect();
      await syncTemplates();

      const digits = fixtureProviderDigits();
      await customerWrites(digits);

      const response = await sendTemplate(await conversationFor(digits), {
        templateName: 'never_created',
      });

      expect(response.status).toBe(404);
      expect(sends).toHaveLength(0);
    });

    describe('parameters are checked against the STORED definition', () => {
      async function ready(): Promise<string> {
        await connect();
        await syncTemplates();
        const digits = fixtureProviderDigits();
        await customerWrites(digits);
        return conversationFor(digits);
      }

      it('refuses too few values', async () => {
        // Sending anyway puts a literal {{2}} on a customer's phone, and there
        // is no correcting a delivered WhatsApp message.
        const response = await sendTemplate(await ready(), { bodyParameters: ['Rahul'] });

        expect(response.status).toBe(400);
        expect(sends).toHaveLength(0);
      });

      it('refuses too many values', async () => {
        const response = await sendTemplate(await ready(), {
          bodyParameters: ['Rahul', 'A-1024', 'extra'],
        });

        expect(response.status).toBe(400);
        expect(sends).toHaveLength(0);
      });

      it('refuses a blank value', async () => {
        const response = await sendTemplate(await ready(), { bodyParameters: ['   ', 'A-1024'] });

        expect(response.status).toBe(400);
        expect(sends).toHaveLength(0);
      });

      it('refuses a value containing a line break, which Meta rejects', async () => {
        const response = await sendTemplate(await ready(), {
          bodyParameters: ['Rahul\nSharma', 'A-1024'],
        });

        expect(response.status).toBe(400);
        expect(sends).toHaveLength(0);
      });

      it('ignores a client claim about how many parameters exist', async () => {
        // headerParameters for a template with no header. The stored
        // definition decides, not the request.
        const response = await sendTemplate(await ready(), {
          headerParameters: ['smuggled'],
        });

        expect(response.status).toBe(400);
        expect(sends).toHaveLength(0);
      });
    });

    it('refuses on a channel that has no templates', async () => {
      // Instagram and Messenger have no template concept. Offering one would
      // be offering an action certain to fail.
      const conversation = await tenancy.runForOrganization(
        ctx.orgA.id,
        'test: instagram conversation',
        async () => {
          const integration = await prisma.client.channelIntegration.create({
            data: {
              organizationId: ctx.orgA.id,
              channel: 'INSTAGRAM',
              status: 'CONNECTED',
              enabled: true,
              providerAccountId: `ig-${unique()}`,
              displayName: 'Test Instagram',
            },
          });
          const contact = await prisma.client.contact.create({
            data: { organizationId: ctx.orgA.id, firstName: 'IG', lastName: 'Person' },
          });
          return prisma.client.conversation.create({
            data: {
              organizationId: ctx.orgA.id,
              integrationId: integration.id,
              channel: 'INSTAGRAM',
              contactId: contact.id,
              externalConversationId: `${integration.providerAccountId}:${unique()}`,
              status: 'OPEN',
            },
          });
        },
      );

      const response = await sendTemplate(conversation.id, {});

      expect(response.status).toBe(409);
      expect(response.body.error.message).toMatch(/only available on WhatsApp/i);
      expect(sends).toHaveLength(0);
    });

    it('refuses a conversation the caller cannot see', async () => {
      await connect('b');
      const digits = fixtureProviderDigits();
      await customerWrites(digits, numbers.b);
      const orgBConversation = await conversationFor(digits, numbers.b);

      const response = await sendTemplate(orgBConversation, {}, ctx.orgA.owner.accessToken);

      // 404, not 403: confirming the id exists would be an enumeration oracle.
      expect(response.status).toBe(404);
      expect(sends).toHaveLength(0);
    });
  });
});
