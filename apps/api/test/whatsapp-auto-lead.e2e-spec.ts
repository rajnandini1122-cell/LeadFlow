// MUST be first: it enables automatic intake processing in process.env, which
// @nestjs/config reads when the next import pulls in the config module.
import './helpers/intake-processing-env';
import { createHmac } from 'node:crypto';
import { createTestContext, PASSWORD, type TestContext } from './helpers/test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { jobPrincipal } from '../src/queues/job-context';
import {
  IntakeProcessingService,
  type ProcessOutcome,
} from '../src/modules/integrations/intake-processing/intake-processing.service';

/**
 * A WhatsApp buying enquiry becomes an assigned lead — through the EXISTING
 * pipeline.
 *
 * The claim this phase makes is narrow, and every case here is one half of it:
 *
 *   WHAT TRIGGERS. Not every message. The channel must be WhatsApp, the tenant
 *   must have asked for it, and the message must read like somebody trying to
 *   buy something. Miss any one and the message behaves exactly as it did
 *   before — stored, visible, and waiting for a person.
 *
 *   WHAT CONVERTS. Nothing new. Omnichannel writes an `integration_intakes` row
 *   and stops; IntakeProcessingService converts it with the same territory
 *   resolution, routing rules, round robin, duplicate refusal, follow-up
 *   creation and single transaction a website enquiry gets. These tests assert
 *   that by checking the OUTCOMES that pipeline is responsible for — an
 *   assignment that respects the rotation, a follow-up that exists, a second
 *   enquiry refused as a duplicate — because a second lead-creation engine
 *   would not reproduce them by accident.
 *
 * Country is deliberately null on a WhatsApp intake: nothing in this repository
 * derives one from a phone prefix safely. That is why every conversion case
 * below routes through a FALLBACK rule — with no country there is no territory,
 * which is the real behaviour and not a shortcut for the test.
 */
describe('WhatsApp automatic lead generation', () => {
  let ctx: TestContext;
  let prisma: PrismaService;
  let tenancy: TenantContextService;

  const APP_SECRET = 'test-whatsapp-app-secret';

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const owner = () => auth(ctx.orgA.owner.accessToken);

  const unique = (prefix: string): string =>
    `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`;

  /**
   * Phone number ids, one per organization.
   *
   * Unique across the WHOLE suite directory, not just this file:
   * `@@unique([channel, providerAccountId])` carries no organization id — that
   * global uniqueness is exactly what makes a webhook's tenant resolution
   * total — and the test database persists across spec files within one run.
   * These first duplicated whatsapp-outbound's ids, and the second suite to
   * run died on the constraint.
   */
  const numbers = { a: '306540000000021', b: '306540000000022' };

  /** A sender number that is valid and unique to one test. */
  let senderCounter = 70_000_000;
  const freshSender = (): string => `9198${String((senderCounter += 1)).padStart(8, '0')}`;

  const asSystem = async <T>(reason: string, run: () => Promise<T>): Promise<T> =>
    tenancy.runAsSystem(reason, run);

  const asTenant = async <T>(organizationId: string, run: () => Promise<T>): Promise<T> =>
    tenancy.runWithTenant(jobPrincipal(organizationId), run);

  const convert = async (intakeId: string, organizationId = ctx.orgA.id): Promise<ProcessOutcome> =>
    asTenant(organizationId, () => ctx.app.get(IntakeProcessingService).process(intakeId));

  // --- delivering a webhook exactly as Meta would ----------------------------

  function sign(body: string): string {
    return `sha256=${createHmac('sha256', APP_SECRET).update(Buffer.from(body)).digest('hex')}`;
  }

  /**
   * Deliberately NOT async: returning the supertest chain keeps `.expect(200)`
   * usable at the call sites, which an async wrapper would hide behind a
   * Promise.
   */
  function deliver(payload: unknown) {
    const body = JSON.stringify(payload);
    return ctx
      .http()
      .post('/api/v1/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);
  }

  function payload(input: {
    phoneNumberId: string;
    from: string;
    text: string;
    messageId: string;
    name?: string;
  }) {
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
                contacts: [{ profile: { name: input.name ?? 'Rahul Patil' }, wa_id: input.from }],
                messages: [
                  {
                    from: input.from,
                    id: input.messageId,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: input.text },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
  }

  /** A buying enquiry. "pricing" and "500kg" are both in BUYING_SIGNALS. */
  const BUYING = 'Please share your pricing for 500kg.';
  /** Ordinary conversation. Nothing here is a buying signal. */
  const CHITCHAT = 'Hello, good morning!';

  // --- fixtures --------------------------------------------------------------

  async function connectNumber(organizationId: string, phoneNumberId: string): Promise<void> {
    await tenancy.runForOrganization(organizationId, 'test: connect whatsapp', () =>
      prisma.client.channelIntegration.create({
        data: {
          organizationId,
          channel: 'WHATSAPP',
          status: 'CONNECTED',
          enabled: true,
          providerAccountId: phoneNumberId,
          displayName: 'Test WhatsApp',
        },
      }),
    );
  }

  /** Flips the tenant setting through the real settings endpoint. */
  const setAutoLead = (enabled: boolean, token = ctx.orgA.owner.accessToken) =>
    ctx
      .http()
      .patch('/api/v1/organizations/current')
      .set(auth(token))
      .send({ settings: { whatsappAutoLeadEnabled: enabled } });

  const intakesFor = async (organizationId: string, source = 'WHATSAPP') =>
    asSystem('e2e read intakes', () =>
      prisma.client.integrationIntake.findMany({
        where: { organizationId, source },
        orderBy: { receivedAt: 'asc' },
      }),
    );

  const leadRow = async (id: string) =>
    asSystem('e2e read lead', () => prisma.client.lead.findFirst({ where: { id } }));

  /**
   * The thread for one sender on one business number.
   *
   * WhatsApp has no thread id of its own, so the webhook composes one as
   * `<phoneNumberId>:<wa_id>` — looking up the bare wa_id finds nothing, which
   * is how this helper was wrong on its first run.
   */
  const conversationFor = async (
    organizationId: string,
    phoneNumberId: string,
    waId: string,
  ) =>
    asSystem('e2e read conversation', () =>
      prisma.client.conversation.findFirst({
        where: { organizationId, externalConversationId: `${phoneNumberId}:${waId}` },
      }),
    );

  /** A team with `count` eligible SALES_REPs, in the order they joined. */
  const teamWithAgents = async (count: number) => {
    const team = await ctx
      .http()
      .post('/api/v1/teams')
      .set(owner())
      .send({ name: unique('Team') })
      .expect(201);

    const teamId = team.body.data.id as string;
    const userIds: string[] = [];

    for (let index = 0; index < count; index += 1) {
      const email = `${unique('agent')}@example.test`;
      const invite = await ctx
        .http()
        .post('/api/v1/users/invite')
        .set(owner())
        .send({ email, fullName: `Agent ${index}`, role: 'SALES_REP' })
        .expect(201);

      await ctx
        .http()
        .post(`/api/v1/invitations/${invite.body.data.inviteToken}/accept`)
        .send({ firstName: 'Agent', lastName: String(index), password: PASSWORD })
        .expect(200);

      await ctx
        .http()
        .post(`/api/v1/teams/${teamId}/members`)
        .set(owner())
        .send({ userId: invite.body.data.userId })
        .expect(201);

      userIds.push(invite.body.data.userId as string);
    }

    return { id: teamId, userIds };
  };

  /** Archives every active rule, so each case starts from a known table. */
  const clearRules = async (): Promise<void> => {
    const rules = await ctx.http().get('/api/v1/assignment-rules').set(owner()).expect(200);

    for (const rule of rules.body.data as { id: string; status: string }[]) {
      if (rule.status === 'ACTIVE') {
        await ctx
          .http()
          .patch(`/api/v1/assignment-rules/${rule.id}`)
          .set(owner())
          .send({ status: 'ARCHIVED' })
          .expect(200);
      }
    }
  };

  const fallbackRuleTo = async (teamId: string) =>
    ctx
      .http()
      .post('/api/v1/assignment-rules')
      .set(owner())
      .send({ name: unique('Fallback'), isFallback: true, targetTeamId: teamId })
      .expect(201);

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
  // What triggers an intake, and what does not
  // ===========================================================================

  describe('the trigger condition', () => {
    it('creates NO intake while the tenant setting is off', async () => {
      await setAutoLead(false).expect(200);

      const messageId = `wamid.${unique('off')}`;
      const from = freshSender();
      await deliver(payload({ phoneNumberId: numbers.a, from, text: BUYING, messageId })).expect(
        200,
      );

      /*
       * The message must still be captured. Off means "do not automate", never
       * "do not record" — the enquiry is in the Inbox and the review queue
       * exactly as it was before this feature existed.
       */
      const conversation = await conversationFor(ctx.orgA.id, numbers.a, from);
      expect(conversation).not.toBeNull();
      expect(conversation?.potentialLead).toBe(true);

      const intakes = await intakesFor(ctx.orgA.id);
      expect(intakes.filter((intake) => intake.externalEventId === messageId)).toHaveLength(0);
    });

    it('creates NO intake for a message with no buying signal', async () => {
      await setAutoLead(true).expect(200);

      const messageId = `wamid.${unique('chat')}`;
      const from = freshSender();
      await deliver(payload({ phoneNumberId: numbers.a, from, text: CHITCHAT, messageId })).expect(
        200,
      );

      // Stored and visible, and NOT flagged — "good morning" is not an enquiry,
      // and a pipeline fed by every greeting is a pipeline nobody reads.
      const conversation = await conversationFor(ctx.orgA.id, numbers.a, from);
      expect(conversation).not.toBeNull();
      expect(conversation?.potentialLead).toBe(false);

      const intakes = await intakesFor(ctx.orgA.id);
      expect(intakes.filter((intake) => intake.externalEventId === messageId)).toHaveLength(0);
    });

    it('creates exactly ONE intake for a buying enquiry when enabled', async () => {
      await setAutoLead(true).expect(200);

      const messageId = `wamid.${unique('buy')}`;
      const from = freshSender();
      await deliver(
        payload({ phoneNumberId: numbers.a, from, text: BUYING, messageId, name: 'Meera Joshi' }),
      ).expect(200);

      const intakes = (await intakesFor(ctx.orgA.id)).filter(
        (intake) => intake.externalEventId === messageId,
      );

      expect(intakes).toHaveLength(1);
      expect(intakes[0]).toMatchObject({
        source: 'WHATSAPP',
        eventType: 'ENQUIRY',
        status: 'RECEIVED',
        name: 'Meera Joshi',
        phone: `+${from}`,
        message: BUYING,
        // Never guessed. No helper here derives a country from a phone prefix,
        // and conversion does not need one.
        country: null,
        // Never inferred from free text, exactly as the website path refuses to.
        productInterest: null,
      });
      expect(intakes[0]?.payloadHash).toHaveLength(64);
    });

    it('records the source as WHATSAPP, not WEBSITE', async () => {
      await setAutoLead(true).expect(200);

      const messageId = `wamid.${unique('src')}`;
      await deliver(
        payload({ phoneNumberId: numbers.a, from: freshSender(), text: BUYING, messageId }),
      ).expect(200);

      const websiteRows = await intakesFor(ctx.orgA.id, 'WEBSITE');
      expect(websiteRows.some((row) => row.externalEventId === messageId)).toBe(false);

      const whatsappRows = await intakesFor(ctx.orgA.id, 'WHATSAPP');
      expect(whatsappRows.some((row) => row.externalEventId === messageId)).toBe(true);
    });
  });

  // ===========================================================================
  // Idempotency
  // ===========================================================================

  describe('duplicate delivery', () => {
    it('creates ONE intake when Meta redelivers the same event', async () => {
      await setAutoLead(true).expect(200);

      const messageId = `wamid.${unique('replay')}`;
      const from = freshSender();
      const body = payload({ phoneNumberId: numbers.a, from, text: BUYING, messageId });

      await deliver(body).expect(200);
      await deliver(body).expect(200);
      await deliver(body).expect(200);

      /*
       * Two guards agree here, and both matter. The message replay check stops
       * ingestion a second time, and the unique index on
       * (organization_id, source, external_event_id) would stop the intake even
       * if it did not.
       */
      const intakes = (await intakesFor(ctx.orgA.id)).filter(
        (intake) => intake.externalEventId === messageId,
      );

      expect(intakes).toHaveLength(1);
    });

    it('creates ONE intake when the same event arrives concurrently', async () => {
      await setAutoLead(true).expect(200);

      const messageId = `wamid.${unique('race')}`;
      const from = freshSender();
      const body = payload({ phoneNumberId: numbers.a, from, text: BUYING, messageId });

      // Fired together, so both pass the replay read before either writes.
      await Promise.all([deliver(body), deliver(body), deliver(body)]);

      const intakes = (await intakesFor(ctx.orgA.id)).filter(
        (intake) => intake.externalEventId === messageId,
      );

      expect(intakes).toHaveLength(1);
    });

    it('lets a WEBSITE and a WHATSAPP intake share one external event id', async () => {
      await setAutoLead(true).expect(200);

      const sharedId = `shared.${unique('evt')}`;

      // The website path, seeded directly — this is about the unique KEY, not
      // about the HMAC route.
      await asSystem('e2e seed website intake', () =>
        prisma.client.integrationIntake.create({
          data: {
            organizationId: ctx.orgA.id,
            source: 'WEBSITE',
            externalEventId: sharedId,
            eventType: 'ENQUIRY',
            payloadHash: 'b'.repeat(64),
            status: 'RECEIVED',
            name: 'Website Person',
            phone: `+${freshSender()}`,
          },
        }),
      );

      await deliver(
        payload({
          phoneNumberId: numbers.a,
          from: freshSender(),
          text: BUYING,
          messageId: sharedId,
        }),
      ).expect(200);

      /*
       * The key is (organization_id, SOURCE, external_event_id). Source being
       * part of it is what lets two integrations number their own events
       * independently — which is precisely why `source` is free text rather
       * than something omnichannel had to squeeze into.
       */
      const website = (await intakesFor(ctx.orgA.id, 'WEBSITE')).filter(
        (row) => row.externalEventId === sharedId,
      );
      const whatsapp = (await intakesFor(ctx.orgA.id, 'WHATSAPP')).filter(
        (row) => row.externalEventId === sharedId,
      );

      expect(website).toHaveLength(1);
      expect(whatsapp).toHaveLength(1);
    });
  });

  // ===========================================================================
  // Conversion, through the existing pipeline
  // ===========================================================================

  describe('conversion', () => {
    it('produces one assigned lead with a follow-up', async () => {
      await setAutoLead(true).expect(200);
      await clearRules();
      const team = await teamWithAgents(1);
      await fallbackRuleTo(team.id);

      const from = freshSender();
      await deliver(
        payload({
          phoneNumberId: numbers.a,
          from,
          text: BUYING,
          messageId: `wamid.${unique('conv')}`,
          name: 'Anita Rao',
        }),
      ).expect(200);

      const intake = (await intakesFor(ctx.orgA.id)).find((row) => row.phone === `+${from}`);
      expect(intake).toBeDefined();

      const outcome = await convert(intake!.id);
      expect(outcome.result).toBe('CONVERTED');

      const leadId = (outcome as { leadId: string }).leadId;
      const lead = await leadRow(leadId);

      expect(lead).toMatchObject({
        status: 'NEW',
        priority: 'MEDIUM',
        mobile: `+${from}`,
        // Routed to the rule's team, not to whoever happened to be first.
        assignedToId: team.userIds[0],
        // Nobody typed this in, and `created_by` is nullable so it can say so.
        createdBy: null,
        assignedById: null,
      });

      // The promise this product makes: an active lead always has a next step.
      expect(lead?.nextFollowUpAt).not.toBeNull();

      const followUps = await asSystem('e2e read follow-ups', () =>
        prisma.client.followUp.findMany({ where: { leadId } }),
      );
      expect(followUps).toHaveLength(1);
      expect(followUps[0]?.assignedUserId).toBe(team.userIds[0]);
    });

    it('records WHATSAPP as the lead source', async () => {
      await setAutoLead(true).expect(200);
      await clearRules();
      const team = await teamWithAgents(1);
      await fallbackRuleTo(team.id);

      const from = freshSender();
      await deliver(
        payload({
          phoneNumberId: numbers.a,
          from,
          text: BUYING,
          messageId: `wamid.${unique('source')}`,
        }),
      ).expect(200);

      const intake = (await intakesFor(ctx.orgA.id)).find((row) => row.phone === `+${from}`);
      const outcome = await convert(intake!.id);
      const lead = await leadRow((outcome as { leadId: string }).leadId);

      // Attribution survives the hand-off: the lead says where it came from.
      expect(lead?.source).toBe('WHATSAPP');
    });

    it('respects the round robin across several enquiries', async () => {
      await setAutoLead(true).expect(200);
      await clearRules();
      const team = await teamWithAgents(2);
      await fallbackRuleTo(team.id);

      const assignees: (string | null)[] = [];

      for (let index = 0; index < 2; index += 1) {
        const from = freshSender();
        await deliver(
          payload({
            phoneNumberId: numbers.a,
            from,
            text: BUYING,
            messageId: `wamid.${unique(`rr${index}`)}`,
          }),
        ).expect(200);

        const intake = (await intakesFor(ctx.orgA.id)).find((row) => row.phone === `+${from}`);
        const outcome = await convert(intake!.id);
        expect(outcome.result).toBe('CONVERTED');

        const lead = await leadRow((outcome as { leadId: string }).leadId);
        assignees.push(lead?.assignedToId ?? null);
      }

      // Two different people, which is the rotation doing its job rather than
      // every WhatsApp enquiry landing on one salesperson.
      expect(new Set(assignees).size).toBe(2);
    });

    it('converts one intake into at most ONE lead, however often it runs', async () => {
      await setAutoLead(true).expect(200);
      await clearRules();
      const team = await teamWithAgents(1);
      await fallbackRuleTo(team.id);

      const from = freshSender();
      await deliver(
        payload({
          phoneNumberId: numbers.a,
          from,
          text: BUYING,
          messageId: `wamid.${unique('once')}`,
        }),
      ).expect(200);

      const intake = (await intakesFor(ctx.orgA.id)).find((row) => row.phone === `+${from}`);

      const first = await convert(intake!.id);
      const second = await convert(intake!.id);

      expect(first.result).toBe('CONVERTED');
      // The row is already PROCESSED, so there is nothing left to claim.
      expect(second.result).toBe('ALREADY_PROCESSED');
      expect((second as { leadId: string }).leadId).toBe((first as { leadId: string }).leadId);

      const leads = await asSystem('e2e count leads', () =>
        prisma.client.lead.findMany({ where: { mobile: `+${from}` } }),
      );
      expect(leads).toHaveLength(1);
    });

    it('refuses a SECOND active lead for the same WhatsApp number', async () => {
      await setAutoLead(true).expect(200);
      await clearRules();
      const team = await teamWithAgents(1);
      await fallbackRuleTo(team.id);

      const from = freshSender();

      // Two separate buying enquiries from one person, on different days.
      await deliver(
        payload({
          phoneNumberId: numbers.a,
          from,
          text: BUYING,
          messageId: `wamid.${unique('dup1')}`,
        }),
      ).expect(200);
      await deliver(
        payload({
          phoneNumberId: numbers.a,
          from,
          text: 'What is your price for a bulk order?',
          messageId: `wamid.${unique('dup2')}`,
        }),
      ).expect(200);

      const intakes = (await intakesFor(ctx.orgA.id)).filter((row) => row.phone === `+${from}`);
      expect(intakes).toHaveLength(2);

      const first = await convert(intakes[0]!.id);
      const second = await convert(intakes[1]!.id);

      expect(first.result).toBe('CONVERTED');
      /*
       * The existing duplicate rule, unchanged and unweakened. A customer
       * asking twice is one live conversation, not two — and the decision to
       * open a second lead anyway belongs to a person.
       */
      expect(second.result).toBe('DUPLICATE');
      expect((second as { code: string }).code).toBe('DUPLICATE_LEAD');

      const leads = await asSystem('e2e count leads', () =>
        prisma.client.lead.findMany({ where: { mobile: `+${from}`, deletedAt: null } }),
      );
      expect(leads).toHaveLength(1);
    });

    it('leaves a blocked enquiry reviewable rather than dropping it', async () => {
      await setAutoLead(true).expect(200);
      await clearRules();
      // No rule at all, so routing cannot place this enquiry anywhere.

      const from = freshSender();
      await deliver(
        payload({
          phoneNumberId: numbers.a,
          from,
          text: BUYING,
          messageId: `wamid.${unique('blocked')}`,
        }),
      ).expect(200);

      const intake = (await intakesFor(ctx.orgA.id)).find((row) => row.phone === `+${from}`);
      const outcome = await convert(intake!.id);

      expect(outcome.result).toBe('BLOCKED');
      expect((outcome as { code: string }).code).toBe('NO_MATCH');

      /*
       * THE property that makes automation safe to switch on: failing to
       * convert costs nothing. The conversation, the message and the
       * buying-signal flag are all still there, so the enquiry is in the review
       * queue where a person can act on it.
       */
      const conversation = await conversationFor(ctx.orgA.id, numbers.a, from);
      expect(conversation).not.toBeNull();
      expect(conversation?.potentialLead).toBe(true);
      expect(conversation?.leadId).toBeNull();

      const review = await ctx
        .http()
        .get('/api/v1/conversations/review')
        .set(owner())
        .expect(200);

      expect(
        (review.body.data.items as { id: string }[]).some((item) => item.id === conversation?.id),
      ).toBe(true);
    });
  });

  // ===========================================================================
  // Isolation, and the pipeline this must not disturb
  // ===========================================================================

  describe('tenant isolation', () => {
    it('never creates an intake in another organization', async () => {
      await setAutoLead(true).expect(200);
      await setAutoLead(true, ctx.orgB.owner.accessToken).expect(200);

      const messageId = `wamid.${unique('iso')}`;
      const from = freshSender();

      // Delivered to ORG B's number.
      await deliver(payload({ phoneNumberId: numbers.b, from, text: BUYING, messageId })).expect(
        200,
      );

      const inB = (await intakesFor(ctx.orgB.id)).filter(
        (row) => row.externalEventId === messageId,
      );
      const inA = (await intakesFor(ctx.orgA.id)).filter(
        (row) => row.externalEventId === messageId,
      );

      // The tenant comes from the connected number, never from the payload.
      expect(inB).toHaveLength(1);
      expect(inA).toHaveLength(0);
    });

    it('does not act on a tenant that left the setting off', async () => {
      await setAutoLead(true).expect(200);
      await setAutoLead(false, ctx.orgB.owner.accessToken).expect(200);

      const messageId = `wamid.${unique('perorg')}`;
      const from = freshSender();
      await deliver(payload({ phoneNumberId: numbers.b, from, text: BUYING, messageId })).expect(
        200,
      );

      // The flag is per tenant: org A having it on must not automate for org B.
      const inB = (await intakesFor(ctx.orgB.id)).filter(
        (row) => row.externalEventId === messageId,
      );
      expect(inB).toHaveLength(0);

      // And org B's message is still captured.
      expect(await conversationFor(ctx.orgB.id, numbers.b, from)).not.toBeNull();
    });
  });

  describe('the website pipeline', () => {
    it('still converts a website enquiry exactly as before', async () => {
      await setAutoLead(false).expect(200);
      await clearRules();
      const team = await teamWithAgents(1);
      await fallbackRuleTo(team.id);

      const mobile = `+${freshSender()}`;
      const intake = await asSystem('e2e seed website intake', () =>
        prisma.client.integrationIntake.create({
          data: {
            organizationId: ctx.orgA.id,
            source: 'WEBSITE',
            externalEventId: unique('web'),
            eventType: 'ENQUIRY',
            payloadHash: 'c'.repeat(64),
            status: 'RECEIVED',
            name: 'Dana Whitfield',
            phone: mobile,
            country: 'IN',
            message: 'Can we see a demo?',
          },
          select: { id: true },
        }),
      );

      const outcome = await convert(intake.id);

      // Untouched by this phase: the same service, the same outcome, and a
      // WHATSAPP source added alongside rather than in place of WEBSITE.
      expect(outcome.result).toBe('CONVERTED');
      const lead = await leadRow((outcome as { leadId: string }).leadId);
      expect(lead?.source).toBe('WEBSITE');
      expect(lead?.assignedToId).toBe(team.userIds[0]);
    });
  });
});
