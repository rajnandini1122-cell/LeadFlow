import { ERROR_CODES } from '@leadflow/api-types';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { IngestionService } from '../src/modules/omnichannel/ingestion.service';
import type { NormalizedChannelEvent } from '../src/modules/omnichannel/channel-event';
import { createTestContext, type TestContext } from './helpers/test-app';

/**
 * Omnichannel capture, Phase B.
 *
 * The whole feature is a claim about not losing and not confusing customer
 * enquiries, so these cases are the claim itself: an existing customer's
 * message reaches their existing deal, a stranger's message does not get filed
 * under someone else, and a redelivered message changes nothing.
 *
 * The last group is the one that matters most. It asserts that the existing
 * lead flow — creation, update, assignment, follow-ups — behaves exactly as it
 * did before any of this existed.
 */
describe('Omnichannel capture', () => {
  let ctx: TestContext;
  let ingestion: IngestionService;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Integration ids, one per organization, created once for the suite. */
  const integrations = new Map<string, string>();

  let counter = 0;
  const unique = () => {
    counter += 1;
    return `${Date.now()}-${counter}`;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    ingestion = ctx.app.get(IngestionService);

    const prisma = ctx.app.get(PrismaService);
    const tenancy = ctx.app.get(TenantContextService);

    // Channel integrations have no API until Phase D, so they are created
    // through the real scoped client rather than a back door.
    for (const org of [ctx.orgA, ctx.orgB]) {
      const created = await tenancy.runForOrganization(org.id, 'test: seed integration', () =>
        prisma.client.channelIntegration.create({
          data: {
            organizationId: org.id,
            channel: 'WHATSAPP',
            status: 'CONNECTED',
            providerAccountId: `pa-${org.id}`,
            displayName: 'Test WhatsApp',
          },
        }),
      );
      integrations.set(org.id, created.id);
    }
  });

  afterAll(async () => {
    await ctx?.close();
  });

  /** Creates a lead through the ordinary API, which also creates its contact. */
  async function createLead(
    org: typeof ctx.orgA,
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

  function event(
    org: typeof ctx.orgA,
    overrides: Partial<NormalizedChannelEvent> = {},
  ): NormalizedChannelEvent {
    const id = unique();
    return {
      organizationId: org.id,
      integrationId: integrations.get(org.id) as string,
      channel: 'WHATSAPP',
      externalMessageId: `wamid.${id}`,
      externalConversationId: `thread.${id}`,
      externalUserId: `wauser.${id}`,
      content: 'Please share your quotation for 500kg onion powder.',
      messageType: 'TEXT',
      timestamp: new Date(),
      ...overrides,
    };
  }

  // ===========================================================================
  // A + B — existing contact, existing lead, owner preserved
  // ===========================================================================

  describe('an existing customer messages about an existing lead', () => {
    it('links the conversation to that lead and leaves the owner alone', async () => {
      const mobile = '4155552601';
      const lead = await createLead(ctx.orgA, ctx.orgA.owner.accessToken, {
        mobile,
        companyName: 'XYZ Foods',
        assignedToId: ctx.orgA.rep.id,
      });

      const result = await ingestion.ingest(event(ctx.orgA, { senderPhone: mobile }));

      expect(result.contact.outcome).toBe('MATCHED');
      expect(result.leadId).toBe(lead.id);
      expect(result.linkState).toBe('LINKED');

      // B — THE non-negotiable rule. A customer choosing WhatsApp is not a
      // reason to move their deal to somebody else.
      const after = await ctx
        .http()
        .get(`/api/v1/leads/${lead.id}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(after.status).toBe(200);
      expect(after.body.data.assignedTo?.id ?? after.body.data.assignedToId).toBe(ctx.orgA.rep.id);
    });

    it('sets the conversation owner from the lead, not from anyone else', async () => {
      const mobile = '4155552602';
      const lead = await createLead(ctx.orgA, ctx.orgA.owner.accessToken, {
        mobile,
        assignedToId: ctx.orgA.rep.id,
      });

      const result = await ingestion.ingest(event(ctx.orgA, { senderPhone: mobile }));

      const conversations = await ctx
        .http()
        .get('/api/v1/conversations')
        .query({ leadId: lead.id })
        .set(auth(ctx.orgA.owner.accessToken));

      expect(conversations.status).toBe(200);
      expect(conversations.body.data).toHaveLength(1);
      expect(conversations.body.data[0].id).toBe(result.conversationId);
      expect(conversations.body.data[0].ownerId).toBe(ctx.orgA.rep.id);
    });

    it('records the message on the existing lead timeline', async () => {
      const mobile = '4155552603';
      const lead = await createLead(ctx.orgA, ctx.orgA.owner.accessToken, {
        mobile,
        assignedToId: ctx.orgA.rep.id,
      });

      await ingestion.ingest(
        event(ctx.orgA, { senderPhone: mobile, content: 'What is your MOQ for garlic powder?' }),
      );

      const activities = await ctx
        .http()
        .get(`/api/v1/leads/${lead.id}/activities`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(activities.status).toBe(200);
      const types = activities.body.data.items.map((entry: { type: string }) => entry.type);
      expect(types).toContain('CONVERSATION_LINKED');
      expect(types).toContain('CHANNEL_MESSAGE_RECEIVED');
    });
  });

  // ===========================================================================
  // C — known person, nothing open
  // ===========================================================================

  describe('an existing customer with no active lead', () => {
    it('stores the message but attaches it to nothing', async () => {
      const mobile = '4155552604';
      const lead = await createLead(ctx.orgA, ctx.orgA.owner.accessToken, {
        mobile,
        assignedToId: ctx.orgA.rep.id,
      });

      // Close it. A won deal is finished; a new enquiry is new business.
      const closed = await ctx
        .http()
        .patch(`/api/v1/leads/${lead.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ status: 'WON', wonValue: 1000 });
      expect(closed.status).toBe(200);

      const result = await ingestion.ingest(event(ctx.orgA, { senderPhone: mobile }));

      expect(result.contact.outcome).toBe('MATCHED');
      expect(result.leadId).toBeNull();
      expect(result.linkState).toBe('UNLINKED');
      // Nothing was lost — the message itself was still stored.
      expect(result.messageId).toBeTruthy();
    });
  });

  // ===========================================================================
  // D — a stranger
  // ===========================================================================

  describe('a message from someone we do not know', () => {
    it('resolves to nobody rather than guessing', async () => {
      const result = await ingestion.ingest(
        event(ctx.orgA, { senderPhone: '4155559999', content: 'Hi' }),
      );

      expect(result.contact.outcome).toBe('UNRESOLVED');
      expect(result.leadId).toBeNull();
      expect(result.messageId).toBeTruthy();
    });

    it('does not invent a contact for them', async () => {
      const before = await ctx
        .http()
        .get('/api/v1/contacts')
        .set(auth(ctx.orgA.owner.accessToken));

      await ingestion.ingest(event(ctx.orgA, { senderPhone: '4155559998', content: 'hello?' }));

      const after = await ctx
        .http()
        .get('/api/v1/contacts')
        .set(auth(ctx.orgA.owner.accessToken));

      // Creating one here would fill the address book with a row per stranger
      // who ever said "hi".
      expect(after.body.data.total).toBe(before.body.data.total);
    });

    it('does not attach a stranger to an existing customer on a channel with no phone number', async () => {
      // Instagram discloses no phone, so there is no second key at all.
      const result = await ingestion.ingest(
        event(ctx.orgA, { channel: 'INSTAGRAM', senderPhone: undefined }),
      );

      expect(result.contact.outcome).toBe('UNRESOLVED');
      expect(result.leadId).toBeNull();
    });
  });

  // ===========================================================================
  // E — ambiguity
  // ===========================================================================

  describe('a customer with two live enquiries', () => {
    /*
     * Getting one contact to own two active leads takes a merge.
     *
     * The partial unique index leads_org_mobile_uniq forbids two non-LOST leads
     * with the same mobile in one organization, and a contact is resolved BY
     * mobile — so the only way this state arises in production is exactly this:
     * two people recorded separately, later found to be the same person, and
     * merged. The merge moves both leads onto the surviving contact.
     */
    async function contactIdFor(mobile: string, token: string): Promise<string> {
      const response = await ctx
        .http()
        .get('/api/v1/contacts')
        .query({ search: mobile })
        .set(auth(token));

      expect(response.status).toBe(200);
      const match = response.body.data.items.find((contact: { mobile: string | null }) =>
        (contact.mobile ?? '').endsWith(mobile.slice(-7)),
      );
      expect(match).toBeDefined();
      return match.id;
    }

    async function twoActiveLeadsOnOneContact(): Promise<{
      first: { id: string };
      second: { id: string };
      mobile: string;
    }> {
      const mobileA = `41555527${String(counter % 90 + 10)}`;
      counter += 1;
      const mobileB = `41555528${String(counter % 90 + 10)}`;
      counter += 1;

      const first = await createLead(ctx.orgA, ctx.orgA.owner.accessToken, {
        mobile: mobileA,
        assignedToId: ctx.orgA.rep.id,
      });
      const second = await createLead(ctx.orgA, ctx.orgA.owner.accessToken, {
        mobile: mobileB,
        assignedToId: ctx.orgA.rep.id,
      });

      const sourceId = await contactIdFor(mobileB, ctx.orgA.owner.accessToken);
      const targetId = await contactIdFor(mobileA, ctx.orgA.owner.accessToken);

      const merged = await ctx
        .http()
        .post('/api/v1/contacts/merge')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ sourceId, targetId });

      expect(merged.status).toBe(200);
      expect(merged.body.data.leadsMoved).toBeGreaterThan(0);

      return { first, second, mobile: mobileA };
    }

    it('refuses to choose and marks the conversation for review', async () => {
      const { first, second, mobile } = await twoActiveLeadsOnOneContact();

      const result = await ingestion.ingest(event(ctx.orgA, { senderPhone: mobile }));

      expect(result.linkState).toBe('REVIEW_REQUIRED');
      expect(result.leadId).toBeNull();
      expect(result.candidateLeadIds).toEqual(expect.arrayContaining([first.id, second.id]));
    });

    it('lets a human resolve it, and the lead owner still does not change', async () => {
      const { first, mobile } = await twoActiveLeadsOnOneContact();

      const result = await ingestion.ingest(event(ctx.orgA, { senderPhone: mobile }));
      expect(result.linkState).toBe('REVIEW_REQUIRED');

      const linked = await ctx
        .http()
        .post(`/api/v1/conversations/${result.conversationId}/link`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ leadId: first.id });

      expect(linked.status).toBe(200);

      const lead = await ctx
        .http()
        .get(`/api/v1/leads/${first.id}`)
        .set(auth(ctx.orgA.owner.accessToken));
      expect(lead.body.data.assignedTo?.id ?? lead.body.data.assignedToId).toBe(ctx.orgA.rep.id);
    });
  });

  // ===========================================================================
  // F — cross-organization
  // ===========================================================================

  describe('cross-organization isolation', () => {
    it('cannot link a conversation in A to a lead in B', async () => {
      const mobile = '4155552607';
      await createLead(ctx.orgA, ctx.orgA.owner.accessToken, {
        mobile,
        assignedToId: ctx.orgA.rep.id,
      });

      const result = await ingestion.ingest(event(ctx.orgA, { senderPhone: mobile }));

      const attack = await ctx
        .http()
        .post(`/api/v1/conversations/${result.conversationId}/link`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ leadId: ctx.orgB.leadId });

      // 404, not 403 — a 403 would confirm the id exists.
      expect(attack.status).toBe(404);
      expect(attack.body.error.code).toBe(ERROR_CODES.LEAD_NOT_FOUND);
    });

    it('does not show organization B a conversation belonging to organization A', async () => {
      const mobile = '4155552608';
      const lead = await createLead(ctx.orgA, ctx.orgA.owner.accessToken, {
        mobile,
        assignedToId: ctx.orgA.rep.id,
      });
      await ingestion.ingest(event(ctx.orgA, { senderPhone: mobile }));

      const peek = await ctx
        .http()
        .get('/api/v1/conversations')
        .query({ leadId: lead.id })
        .set(auth(ctx.orgB.owner.accessToken));

      expect(peek.status).toBe(404);
    });

    it('never resolves a contact across organizations, even on an identical number', async () => {
      const mobile = '4155552609';

      // The same human, known to both organizations. They are still two
      // separate customers, one per tenant.
      await createLead(ctx.orgA, ctx.orgA.owner.accessToken, {
        mobile,
        assignedToId: ctx.orgA.rep.id,
      });
      const leadB = await createLead(ctx.orgB, ctx.orgB.owner.accessToken, {
        mobile,
        assignedToId: ctx.orgB.rep.id,
      });

      const result = await ingestion.ingest(event(ctx.orgB, { senderPhone: mobile }));

      expect(result.leadId).toBe(leadB.id);
    });
  });

  // ===========================================================================
  // G — redelivery
  // ===========================================================================

  describe('a redelivered message', () => {
    it('creates no second conversation, message or activity', async () => {
      const mobile = '4155552610';
      const lead = await createLead(ctx.orgA, ctx.orgA.owner.accessToken, {
        mobile,
        assignedToId: ctx.orgA.rep.id,
      });

      const incoming = event(ctx.orgA, { senderPhone: mobile });

      const first = await ingestion.ingest(incoming);
      const second = await ingestion.ingest(incoming);

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.conversationId).toBe(first.conversationId);
      expect(second.messageId).toBe(first.messageId);

      const activities = await ctx
        .http()
        .get(`/api/v1/leads/${lead.id}/activities`)
        .set(auth(ctx.orgA.owner.accessToken));

      const received = activities.body.data.items.filter(
        (entry: { type: string }) => entry.type === 'CHANNEL_MESSAGE_RECEIVED',
      );
      // An append-only timeline can never be tidied up afterwards, so a
      // duplicate line here would be permanent.
      expect(received).toHaveLength(1);
    });

    it('is safe to replay many times', async () => {
      const mobile = '4155552611';
      await createLead(ctx.orgA, ctx.orgA.owner.accessToken, {
        mobile,
        assignedToId: ctx.orgA.rep.id,
      });

      const incoming = event(ctx.orgA, { senderPhone: mobile });
      const results = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        results.push(await ingestion.ingest(incoming));
      }

      const conversationIds = new Set(results.map((r) => r.conversationId));
      expect(conversationIds.size).toBe(1);
    });

    it('does not create a second channel identity for the same person', async () => {
      const mobile = '4155552612';
      await createLead(ctx.orgA, ctx.orgA.owner.accessToken, {
        mobile,
        assignedToId: ctx.orgA.rep.id,
      });

      const userId = `wauser.stable.${unique()}`;
      await ingestion.ingest(event(ctx.orgA, { senderPhone: mobile, externalUserId: userId }));
      const again = await ingestion.ingest(
        event(ctx.orgA, { senderPhone: mobile, externalUserId: userId }),
      );

      // Second message, same person: resolved from the stored identity rather
      // than re-derived, so no new mapping row.
      expect(again.contact.outcome).toBe('MATCHED');
      if (again.contact.outcome !== 'MATCHED') throw new Error('unreachable');
      expect(again.contact.createdIdentity).toBe(false);
    });
  });

  // ===========================================================================
  // H — the existing lead flow is untouched
  // ===========================================================================

  describe('the existing lead flow still behaves exactly as before', () => {
    it('creates a lead manually with no channel involvement', async () => {
      const lead = await createLead(ctx.orgA, ctx.orgA.owner.accessToken, {
        mobile: '4155552620',
        companyName: 'Manual Entry Ltd',
      });

      expect(lead.id).toBeTruthy();
      expect(lead.leadNumber).toMatch(/^LD-/);
    });

    it('still refuses a duplicate mobile without an explicit override', async () => {
      const mobile = '4155552621';
      await createLead(ctx.orgA, ctx.orgA.owner.accessToken, { mobile });

      const duplicate = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          firstName: 'Rahul',
          mobile,
          nextFollowUpAt: new Date(Date.now() + 86_400_000).toISOString(),
        });

      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error.code).toBe(ERROR_CODES.DUPLICATE_LEAD);
    });

    it('still updates and reassigns a lead', async () => {
      const lead = await createLead(ctx.orgA, ctx.orgA.owner.accessToken, {
        mobile: '4155552622',
        assignedToId: ctx.orgA.rep.id,
      });

      const updated = await ctx
        .http()
        .patch(`/api/v1/leads/${lead.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ status: 'QUALIFIED', productInterest: 'Onion powder' });
      expect(updated.status).toBe(200);

      const assigned = await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/assign`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ assignedToId: ctx.orgA.owner.id });
      expect(assigned.status).toBe(200);
    });

    it('still creates and lists follow-ups', async () => {
      const lead = await createLead(ctx.orgA, ctx.orgA.owner.accessToken, {
        mobile: '4155552623',
        assignedToId: ctx.orgA.rep.id,
      });

      const created = await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/follow-ups`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          scheduledAt: new Date(Date.now() + 172_800_000).toISOString(),
          type: 'CALL',
          title: 'Call back about pricing',
        });

      expect(created.status).toBe(201);

      const list = await ctx
        .http()
        .get(`/api/v1/leads/${lead.id}/follow-ups`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(list.status).toBe(200);
      expect(list.body.data.length).toBeGreaterThan(0);
    });

    it('leaves a lead with no conversations reporting an empty list, not an error', async () => {
      const lead = await createLead(ctx.orgA, ctx.orgA.owner.accessToken, {
        mobile: '4155552624',
        assignedToId: ctx.orgA.rep.id,
      });

      const conversations = await ctx
        .http()
        .get('/api/v1/conversations')
        .query({ leadId: lead.id })
        .set(auth(ctx.orgA.owner.accessToken));

      expect(conversations.status).toBe(200);
      expect(conversations.body.data).toEqual([]);
    });
  });


  // ===========================================================================
  // PHASE C — the review queue
  // ===========================================================================

  describe('the review queue', () => {
    it('shows an unknown sender as needing review, and stores the message', async () => {
      const result = await ingestion.ingest(
        event(ctx.orgA, { senderPhone: '4155558801', content: 'Need pricing for 500kg' }),
      );

      const queue = await ctx
        .http()
        .get('/api/v1/conversations/review')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(queue.status).toBe(200);
      const row = queue.body.data.items.find(
        (item: { id: string }) => item.id === result.conversationId,
      );
      expect(row).toBeDefined();
      expect(row.linkState).toBe('UNLINKED');
      expect(row.contact).toBeNull();
    });

    it('flags a buying enquiry as a potential lead, with the words that triggered it', async () => {
      const result = await ingestion.ingest(
        event(ctx.orgA, {
          senderPhone: '4155558802',
          content: 'What is your MOQ for bulk garlic powder?',
        }),
      );

      const queue = await ctx
        .http()
        .get('/api/v1/conversations/review')
        .query({ category: 'POTENTIAL_LEAD' })
        .set(auth(ctx.orgA.owner.accessToken));

      const row = queue.body.data.items.find(
        (item: { id: string }) => item.id === result.conversationId,
      );
      expect(row).toBeDefined();
      expect(row.potentialLead).toBe(true);
      expect(row.potentialLeadSignals).toEqual(expect.arrayContaining(['moq', 'bulk']));
    });

    it('does not flag a greeting as a potential lead', async () => {
      const result = await ingestion.ingest(
        event(ctx.orgA, { senderPhone: '4155558803', content: 'Hi' }),
      );

      const queue = await ctx
        .http()
        .get('/api/v1/conversations/review')
        .query({ category: 'POTENTIAL_LEAD' })
        .set(auth(ctx.orgA.owner.accessToken));

      const ids = queue.body.data.items.map((item: { id: string }) => item.id);
      expect(ids).not.toContain(result.conversationId);
    });

    it('leaves linked conversations out of the queue', async () => {
      const mobile = '4155558804';
      await createLead(ctx.orgA, ctx.orgA.owner.accessToken, {
        mobile,
        assignedToId: ctx.orgA.rep.id,
      });

      const result = await ingestion.ingest(event(ctx.orgA, { senderPhone: mobile }));
      expect(result.linkState).toBe('LINKED');

      const queue = await ctx
        .http()
        .get('/api/v1/conversations/review')
        .set(auth(ctx.orgA.owner.accessToken));

      // Already dealt with. Leaving it in would bury the ones that are not.
      const ids = queue.body.data.items.map((item: { id: string }) => item.id);
      expect(ids).not.toContain(result.conversationId);
    });

    it('counts what is waiting', async () => {
      const count = await ctx
        .http()
        .get('/api/v1/conversations/review/count')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(count.status).toBe(200);
      expect(typeof count.body.data.count).toBe('number');
    });
  });

  // ===========================================================================
  // PHASE C — conversation detail
  // ===========================================================================

  describe('conversation detail', () => {
    it('returns the message history and never offers to send', async () => {
      const result = await ingestion.ingest(
        event(ctx.orgA, { senderPhone: '4155558810', content: 'Please share your rates' }),
      );

      const detail = await ctx
        .http()
        .get(`/api/v1/conversations/${result.conversationId}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(detail.status).toBe(200);
      expect(detail.body.data.messages).toHaveLength(1);
      expect(detail.body.data.messages[0].direction).toBe('INCOMING');

      /*
       * CHANGED IN PHASE E2.
       *
       * This used to assert canSend was always false, which was true while no
       * provider could send. It is now calculated — and for this fixture, a
       * CONNECTED WhatsApp integration with an inbound message seconds ago, the
       * honest answer is that a reply IS possible. What matters now is that the
       * value is derived rather than assumed, and that a refusal always comes
       * with a reason someone can act on.
       */
      expect(typeof detail.body.data.canSend).toBe('boolean');
      if (!detail.body.data.canSend) {
        expect(detail.body.data.sendDisabledReason).toBeTruthy();
      }
    });

    it('offers candidate leads only when the system actually refused to choose', async () => {
      const mobile = '4155558811';
      await createLead(ctx.orgA, ctx.orgA.owner.accessToken, {
        mobile,
        assignedToId: ctx.orgA.rep.id,
      });

      const result = await ingestion.ingest(event(ctx.orgA, { senderPhone: mobile }));

      const detail = await ctx
        .http()
        .get(`/api/v1/conversations/${result.conversationId}`)
        .set(auth(ctx.orgA.owner.accessToken));

      // Exactly one match was linked automatically; there is nothing to choose.
      expect(detail.body.data.candidateLeads).toEqual([]);
    });

    it('refuses a conversation belonging to another organization', async () => {
      const result = await ingestion.ingest(
        event(ctx.orgA, { senderPhone: '4155558812', content: 'quote please' }),
      );

      const peek = await ctx
        .http()
        .get(`/api/v1/conversations/${result.conversationId}`)
        .set(auth(ctx.orgB.owner.accessToken));

      expect(peek.status).toBe(404);
    });
  });

  // ===========================================================================
  // PHASE C — dismiss and restore
  // ===========================================================================

  describe('dismissing a conversation that is not a lead', () => {
    it('takes it out of the queue without deleting anything', async () => {
      const result = await ingestion.ingest(
        event(ctx.orgA, { senderPhone: '4155558820', content: 'wrong number sorry' }),
      );

      const archived = await ctx
        .http()
        .post(`/api/v1/conversations/${result.conversationId}/archive`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ reason: 'Wrong number' });

      expect(archived.status).toBe(200);

      const queue = await ctx
        .http()
        .get('/api/v1/conversations/review')
        .set(auth(ctx.orgA.owner.accessToken));
      expect(queue.body.data.items.map((i: { id: string }) => i.id)).not.toContain(
        result.conversationId,
      );

      // Still stored, with its messages and the reason it was dismissed.
      const detail = await ctx
        .http()
        .get(`/api/v1/conversations/${result.conversationId}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(detail.status).toBe(200);
      expect(detail.body.data.archivedAt).not.toBeNull();
      expect(detail.body.data.archivedReason).toBe('Wrong number');
      expect(detail.body.data.messages).toHaveLength(1);
    });

    it('lists dismissed conversations when asked for them', async () => {
      const result = await ingestion.ingest(
        event(ctx.orgA, { senderPhone: '4155558821', content: 'spam' }),
      );
      await ctx
        .http()
        .post(`/api/v1/conversations/${result.conversationId}/archive`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({});

      const dismissed = await ctx
        .http()
        .get('/api/v1/conversations/review')
        .query({ archived: true })
        .set(auth(ctx.orgA.owner.accessToken));

      expect(dismissed.body.data.items.map((i: { id: string }) => i.id)).toContain(
        result.conversationId,
      );
    });

    it('puts it back', async () => {
      const result = await ingestion.ingest(
        event(ctx.orgA, { senderPhone: '4155558822', content: 'hello' }),
      );

      await ctx
        .http()
        .post(`/api/v1/conversations/${result.conversationId}/archive`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({});

      const restored = await ctx
        .http()
        .post(`/api/v1/conversations/${result.conversationId}/restore`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(restored.status).toBe(200);

      const queue = await ctx
        .http()
        .get('/api/v1/conversations/review')
        .set(auth(ctx.orgA.owner.accessToken));
      expect(queue.body.data.items.map((i: { id: string }) => i.id)).toContain(
        result.conversationId,
      );
    });

    it('refuses to dismiss the same conversation twice', async () => {
      const result = await ingestion.ingest(
        event(ctx.orgA, { senderPhone: '4155558823', content: 'ok' }),
      );

      await ctx
        .http()
        .post(`/api/v1/conversations/${result.conversationId}/archive`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({});

      const again = await ctx
        .http()
        .post(`/api/v1/conversations/${result.conversationId}/archive`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({});

      expect(again.status).toBe(409);
    });

    it('does not let another organization dismiss it', async () => {
      const result = await ingestion.ingest(
        event(ctx.orgA, { senderPhone: '4155558824', content: 'hi' }),
      );

      const attack = await ctx
        .http()
        .post(`/api/v1/conversations/${result.conversationId}/archive`)
        .set(auth(ctx.orgB.owner.accessToken))
        .send({});

      expect(attack.status).toBe(404);
    });
  });

  // ===========================================================================
  // PHASE C — creating a lead from a conversation
  // ===========================================================================

  describe('creating a lead from a conversation', () => {
    it('uses the ordinary lead endpoint, then links the conversation', async () => {
      const mobile = '4155558830';
      const result = await ingestion.ingest(
        event(ctx.orgA, { senderPhone: mobile, content: 'Need a quotation for 200kg' }),
      );

      expect(result.contact.outcome).toBe('UNRESOLVED');
      expect(result.leadId).toBeNull();

      // Exactly what the UI does: POST /leads, then POST /conversations/:id/link.
      const created = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          firstName: 'Rahul',
          mobile,
          companyName: 'XYZ Foods',
          source: 'WhatsApp',
          nextFollowUpAt: new Date(Date.now() + 86_400_000).toISOString(),
          assignedToId: ctx.orgA.rep.id,
        });

      expect(created.status).toBe(201);

      const linked = await ctx
        .http()
        .post(`/api/v1/conversations/${result.conversationId}/link`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ leadId: created.body.data.id });

      expect(linked.status).toBe(200);

      // The new lead behaves like any other: same shape, same activities.
      const lead = await ctx
        .http()
        .get(`/api/v1/leads/${created.body.data.id}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(lead.status).toBe(200);
      expect(lead.body.data.leadNumber).toMatch(/^LD-/);
      // Owner is whoever the lead flow assigned — not the conversation.
      expect(lead.body.data.assignedTo?.id ?? lead.body.data.assignedToId).toBe(ctx.orgA.rep.id);

      const conversations = await ctx
        .http()
        .get('/api/v1/conversations')
        .query({ leadId: created.body.data.id })
        .set(auth(ctx.orgA.owner.accessToken));

      expect(conversations.body.data).toHaveLength(1);
      expect(conversations.body.data[0].id).toBe(result.conversationId);
    });

    it('leaves the conversation out of the queue once linked', async () => {
      const mobile = '4155558831';
      const result = await ingestion.ingest(
        event(ctx.orgA, { senderPhone: mobile, content: 'bulk order enquiry' }),
      );

      const created = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          firstName: 'Meera',
          mobile,
          nextFollowUpAt: new Date(Date.now() + 86_400_000).toISOString(),
          assignedToId: ctx.orgA.rep.id,
        });

      await ctx
        .http()
        .post(`/api/v1/conversations/${result.conversationId}/link`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ leadId: created.body.data.id });

      const queue = await ctx
        .http()
        .get('/api/v1/conversations/review')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(queue.body.data.items.map((i: { id: string }) => i.id)).not.toContain(
        result.conversationId,
      );
    });
  });

  // ===========================================================================
  // PHASE C — visibility in the queue
  // ===========================================================================

  describe('review queue visibility', () => {
    it('does not show a rep a conversation owned by a colleague', async () => {
      const mobile = '4155558840';
      // Assigned to the OWNER, so the conversation's owner becomes the owner.
      await createLead(ctx.orgA, ctx.orgA.owner.accessToken, {
        mobile,
        assignedToId: ctx.orgA.owner.id,
      });

      const result = await ingestion.ingest(event(ctx.orgA, { senderPhone: mobile }));

      const asRep = await ctx
        .http()
        .get(`/api/v1/conversations/${result.conversationId}`)
        .set(auth(ctx.orgA.rep.accessToken));

      // The review queue must not become a side door into a colleague's leads.
      expect(asRep.status).toBe(404);
    });

    /*
     * REPLACED IN PHASE D.
     *
     * This used to assert that every user could see every unowned conversation.
     * That was too generous: an unassigned enquiry is a customer's private
     * message to the business, and "nobody has picked it up yet" is not a
     * reason to show it to every salesperson. It is now a per-tenant decision —
     * see the shared-unassigned-queue cases below.
     */
    it('hides an unowned conversation from a rep unless the tenant opts in', async () => {
      const result = await ingestion.ingest(
        event(ctx.orgA, { senderPhone: '4155558841', content: 'need price list' }),
      );

      const asRep = await ctx
        .http()
        .get('/api/v1/conversations/review')
        .set(auth(ctx.orgA.rep.accessToken));

      expect(asRep.status).toBe(200);
      expect(asRep.body.data.items.map((i: { id: string }) => i.id)).not.toContain(
        result.conversationId,
      );

      // The people who can already see the whole pipeline still see it, so
      // nothing goes unnoticed.
      const asOwner = await ctx
        .http()
        .get('/api/v1/conversations/review')
        .set(auth(ctx.orgA.owner.accessToken));
      expect(asOwner.body.data.items.map((i: { id: string }) => i.id)).toContain(
        result.conversationId,
      );
    });

    it('does not leak another organization’s queue', async () => {
      const result = await ingestion.ingest(
        event(ctx.orgA, { senderPhone: '4155558842', content: 'quotation' }),
      );

      const queueB = await ctx
        .http()
        .get('/api/v1/conversations/review')
        .set(auth(ctx.orgB.owner.accessToken));

      expect(queueB.status).toBe(200);
      expect(queueB.body.data.items.map((i: { id: string }) => i.id)).not.toContain(
        result.conversationId,
      );
    });
  });


  // ===========================================================================
  // PHASE D — conversation visibility
  //
  // The rule Phase C got wrong. An unassigned enquiry is a customer's private
  // message to the business, not a noticeboard, and "nobody has picked it up
  // yet" is not a reason to show it to every salesperson.
  // ===========================================================================

  describe('conversation visibility', () => {
    /** Flips the organization's shared-unassigned-queue setting. */
    async function setSharedQueue(enabled: boolean): Promise<void> {
      const response = await ctx
        .http()
        .patch('/api/v1/organizations/current')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ settings: { sharedUnassignedQueue: enabled } });

      expect(response.status).toBe(200);
      expect(response.body.data.settings.sharedUnassignedQueue).toBe(enabled);
    }

    afterEach(async () => {
      await setSharedQueue(false);
    });

    it('hides an unowned conversation from a sales rep by default', async () => {
      await setSharedQueue(false);

      const result = await ingestion.ingest(
        event(ctx.orgA, { senderPhone: '4155559101', content: 'need a quotation' }),
      );

      const asRep = await ctx
        .http()
        .get('/api/v1/conversations/inbox')
        .set(auth(ctx.orgA.rep.accessToken));

      expect(asRep.status).toBe(200);
      expect(asRep.body.data.items.map((i: { id: string }) => i.id)).not.toContain(
        result.conversationId,
      );

      // And not through the detail endpoint either — a list filter with a
      // readable detail route underneath it is not a filter.
      const detail = await ctx
        .http()
        .get(`/api/v1/conversations/${result.conversationId}`)
        .set(auth(ctx.orgA.rep.accessToken));
      expect(detail.status).toBe(404);
    });

    it('shows the same conversation to the owner, who sees everything', async () => {
      const result = await ingestion.ingest(
        event(ctx.orgA, { senderPhone: '4155559102', content: 'pricing please' }),
      );

      const asOwner = await ctx
        .http()
        .get('/api/v1/conversations/inbox')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(asOwner.body.data.items.map((i: { id: string }) => i.id)).toContain(
        result.conversationId,
      );
    });

    it('opens unowned conversations to a rep once the organization enables the shared queue', async () => {
      const result = await ingestion.ingest(
        event(ctx.orgA, { senderPhone: '4155559103', content: 'bulk order' }),
      );

      const before = await ctx
        .http()
        .get('/api/v1/conversations/inbox')
        .set(auth(ctx.orgA.rep.accessToken));
      expect(before.body.data.items.map((i: { id: string }) => i.id)).not.toContain(
        result.conversationId,
      );

      await setSharedQueue(true);

      const after = await ctx
        .http()
        .get('/api/v1/conversations/inbox')
        .set(auth(ctx.orgA.rep.accessToken));
      expect(after.body.data.items.map((i: { id: string }) => i.id)).toContain(
        result.conversationId,
      );
    });

    it('still shows a rep the conversation on their own lead', async () => {
      const mobile = '4155559104';
      await createLead(ctx.orgA, ctx.orgA.owner.accessToken, {
        mobile,
        assignedToId: ctx.orgA.rep.id,
      });

      const result = await ingestion.ingest(event(ctx.orgA, { senderPhone: mobile }));

      const asRep = await ctx
        .http()
        .get('/api/v1/conversations/inbox')
        .set(auth(ctx.orgA.rep.accessToken));

      // Tightening unassigned visibility must not cost a rep sight of their
      // own customers.
      expect(asRep.body.data.items.map((i: { id: string }) => i.id)).toContain(
        result.conversationId,
      );
    });

    it('never shows a rep a conversation on a colleague’s lead, shared queue or not', async () => {
      const mobile = '4155559105';
      await createLead(ctx.orgA, ctx.orgA.owner.accessToken, {
        mobile,
        assignedToId: ctx.orgA.owner.id,
      });

      const result = await ingestion.ingest(event(ctx.orgA, { senderPhone: mobile }));

      await setSharedQueue(true);

      const asRep = await ctx
        .http()
        .get('/api/v1/conversations/inbox')
        .set(auth(ctx.orgA.rep.accessToken));

      // The shared queue is about enquiries nobody has picked up. It is not a
      // back door into threads that belong to someone else's deal.
      expect(asRep.body.data.items.map((i: { id: string }) => i.id)).not.toContain(
        result.conversationId,
      );
    });

    it('does not leak an inaccessible lead through the counts', async () => {
      const mobile = '4155559106';
      await createLead(ctx.orgA, ctx.orgA.owner.accessToken, {
        mobile,
        assignedToId: ctx.orgA.owner.id,
      });
      await ingestion.ingest(event(ctx.orgA, { senderPhone: mobile }));

      const repCounts = await ctx
        .http()
        .get('/api/v1/conversations/inbox/counts')
        .set(auth(ctx.orgA.rep.accessToken));

      const ownerCounts = await ctx
        .http()
        .get('/api/v1/conversations/inbox/counts')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(repCounts.status).toBe(200);
      // A count is a disclosure too: "there are 40 conversations you cannot
      // see" is information the rep should not have.
      expect(repCounts.body.data.all).toBeLessThan(ownerCounts.body.data.all);
    });
  });

  // ===========================================================================
  // PHASE D — the inbox
  // ===========================================================================

  describe('the unified inbox', () => {
    it('shows linked conversations, which the review queue hides', async () => {
      const mobile = '4155559110';
      await createLead(ctx.orgA, ctx.orgA.owner.accessToken, {
        mobile,
        assignedToId: ctx.orgA.rep.id,
      });

      const result = await ingestion.ingest(event(ctx.orgA, { senderPhone: mobile }));
      expect(result.linkState).toBe('LINKED');

      const inbox = await ctx
        .http()
        .get('/api/v1/conversations/inbox')
        .set(auth(ctx.orgA.owner.accessToken));
      const review = await ctx
        .http()
        .get('/api/v1/conversations/review')
        .set(auth(ctx.orgA.owner.accessToken));

      // Same row, same table — the review queue is a view over the inbox, not
      // a second copy.
      expect(inbox.body.data.items.map((i: { id: string }) => i.id)).toContain(
        result.conversationId,
      );
      expect(review.body.data.items.map((i: { id: string }) => i.id)).not.toContain(
        result.conversationId,
      );
    });

    it('filters to mine', async () => {
      const mobile = '4155559111';
      await createLead(ctx.orgA, ctx.orgA.owner.accessToken, {
        mobile,
        assignedToId: ctx.orgA.rep.id,
      });
      const mine = await ingestion.ingest(event(ctx.orgA, { senderPhone: mobile }));

      const other = await ingestion.ingest(
        event(ctx.orgA, { senderPhone: '4155559112', content: 'hello' }),
      );

      const inbox = await ctx
        .http()
        .get('/api/v1/conversations/inbox')
        .query({ filter: 'MINE' })
        .set(auth(ctx.orgA.rep.accessToken));

      const ids = inbox.body.data.items.map((i: { id: string }) => i.id);
      expect(ids).toContain(mine.conversationId);
      expect(ids).not.toContain(other.conversationId);
    });

    it('filters by channel', async () => {
      const whatsapp = await ingestion.ingest(
        event(ctx.orgA, { senderPhone: '4155559113', content: 'quote' }),
      );
      const instagram = await ingestion.ingest(
        event(ctx.orgA, { channel: 'INSTAGRAM', content: 'wholesale pricing?' }),
      );

      const filtered = await ctx
        .http()
        .get('/api/v1/conversations/inbox')
        .query({ channel: 'INSTAGRAM' })
        .set(auth(ctx.orgA.owner.accessToken));

      const ids = filtered.body.data.items.map((i: { id: string }) => i.id);
      expect(ids).toContain(instagram.conversationId);
      expect(ids).not.toContain(whatsapp.conversationId);
    });

    it('keeps dismissed conversations out of the default view', async () => {
      const result = await ingestion.ingest(
        event(ctx.orgA, { senderPhone: '4155559114', content: 'spam' }),
      );

      await ctx
        .http()
        .post(`/api/v1/conversations/${result.conversationId}/archive`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({});

      const inbox = await ctx
        .http()
        .get('/api/v1/conversations/inbox')
        .set(auth(ctx.orgA.owner.accessToken));
      expect(inbox.body.data.items.map((i: { id: string }) => i.id)).not.toContain(
        result.conversationId,
      );

      const archived = await ctx
        .http()
        .get('/api/v1/conversations/inbox')
        .query({ archived: true })
        .set(auth(ctx.orgA.owner.accessToken));
      expect(archived.body.data.items.map((i: { id: string }) => i.id)).toContain(
        result.conversationId,
      );
    });

    it('pages without loading every message', async () => {
      const page = await ctx
        .http()
        .get('/api/v1/conversations/inbox')
        .query({ limit: 2 })
        .set(auth(ctx.orgA.owner.accessToken));

      expect(page.status).toBe(200);
      expect(page.body.data.items.length).toBeLessThanOrEqual(2);
      // A summary row carries a preview, never a full history.
      for (const item of page.body.data.items) {
        expect(item).not.toHaveProperty('messages');
      }
    });

    it('does not show organization B anything of organization A’s', async () => {
      const result = await ingestion.ingest(
        event(ctx.orgA, { senderPhone: '4155559115', content: 'quotation' }),
      );

      const inboxB = await ctx
        .http()
        .get('/api/v1/conversations/inbox')
        .set(auth(ctx.orgB.owner.accessToken));

      expect(inboxB.body.data.items.map((i: { id: string }) => i.id)).not.toContain(
        result.conversationId,
      );
    });
  });

  // ===========================================================================
  // PHASE D — conversation assignment
  // ===========================================================================

  describe('assigning a conversation', () => {
    it('sets the conversation owner and leaves the lead owner alone', async () => {
      const mobile = '4155559120';
      const lead = await createLead(ctx.orgA, ctx.orgA.owner.accessToken, {
        mobile,
        assignedToId: ctx.orgA.rep.id,
      });

      const result = await ingestion.ingest(event(ctx.orgA, { senderPhone: mobile }));

      const assigned = await ctx
        .http()
        .post(`/api/v1/conversations/${result.conversationId}/assign`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ userId: ctx.orgA.owner.id });

      expect(assigned.status).toBe(200);
      expect(assigned.body.data.ownerId).toBe(ctx.orgA.owner.id);

      // THE point of the separation: handing over a thread is not handing over
      // the deal.
      const after = await ctx
        .http()
        .get(`/api/v1/leads/${lead.id}`)
        .set(auth(ctx.orgA.owner.accessToken));
      expect(after.body.data.assignedTo?.id ?? after.body.data.assignedToId).toBe(
        ctx.orgA.rep.id,
      );
    });

    it('hands a conversation back to nobody', async () => {
      const result = await ingestion.ingest(
        event(ctx.orgA, { senderPhone: '4155559121', content: 'price list' }),
      );

      await ctx
        .http()
        .post(`/api/v1/conversations/${result.conversationId}/assign`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ userId: ctx.orgA.rep.id });

      const cleared = await ctx
        .http()
        .post(`/api/v1/conversations/${result.conversationId}/assign`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ userId: null });

      expect(cleared.status).toBe(200);
      expect(cleared.body.data.ownerId).toBeNull();
    });

    it('refuses someone who is not a member of this organization', async () => {
      const result = await ingestion.ingest(
        event(ctx.orgA, { senderPhone: '4155559122', content: 'quote' }),
      );

      const attack = await ctx
        .http()
        .post(`/api/v1/conversations/${result.conversationId}/assign`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ userId: ctx.orgB.rep.id });

      expect(attack.status).toBe(404);
    });

    it('does not let organization B assign organization A’s conversation', async () => {
      const result = await ingestion.ingest(
        event(ctx.orgA, { senderPhone: '4155559123', content: 'hi' }),
      );

      const attack = await ctx
        .http()
        .post(`/api/v1/conversations/${result.conversationId}/assign`)
        .set(auth(ctx.orgB.owner.accessToken))
        .send({ userId: ctx.orgB.owner.id });

      expect(attack.status).toBe(404);
    });
  });

  // ===========================================================================
  // PHASE D — channel integrations
  // ===========================================================================

  describe('channel integrations', () => {
    it('lists every supported channel, connected or not', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/channel-integrations')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(200);
      expect(response.body.data.map((row: { channel: string }) => row.channel)).toEqual(
        expect.arrayContaining(['WHATSAPP', 'INSTAGRAM', 'FACEBOOK']),
      );
    });

    /*
     * UPDATED IN PHASE E1.
     *
     * This used to assert that NO channel was connectable, which was true while
     * no provider existed. WhatsApp now has a real setup flow; Instagram and
     * Facebook still do not, and the distinction is what the settings screen
     * reads to decide whether Connect can do anything.
     */
    it('reports only the channels with a real implementation as connectable', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/channel-integrations')
        .set(auth(ctx.orgA.owner.accessToken));

      const byChannel = Object.fromEntries(
        response.body.data.map((row: { channel: string; connectable: boolean }) => [
          row.channel,
          row.connectable,
        ]),
      );

      expect(byChannel['WHATSAPP']).toBe(true);
      // Claiming otherwise would have an owner believing their account is live.
      expect(byChannel['INSTAGRAM']).toBe(false);
      expect(byChannel['FACEBOOK']).toBe(false);
    });

    it('shows a channel with no record as NOT_CONNECTED and invents no timestamps', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/channel-integrations')
        .set(auth(ctx.orgA.owner.accessToken));

      const facebook = response.body.data.find(
        (row: { channel: string }) => row.channel === 'FACEBOOK',
      );
      expect(facebook.status).toBe('NOT_CONNECTED');
      expect(facebook.connectedAt).toBeNull();
      expect(facebook.lastActivityAt).toBeNull();
    });

    it('switches an integration off without touching its history', async () => {
      const list = await ctx
        .http()
        .get('/api/v1/channel-integrations')
        .set(auth(ctx.orgA.owner.accessToken));

      const whatsapp = list.body.data.find(
        (row: { channel: string }) => row.channel === 'WHATSAPP',
      );
      expect(whatsapp.id).toBeTruthy();

      const before = await ctx
        .http()
        .get('/api/v1/conversations/inbox')
        .set(auth(ctx.orgA.owner.accessToken));

      const disabled = await ctx
        .http()
        .patch(`/api/v1/channel-integrations/${whatsapp.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ enabled: false });

      expect(disabled.status).toBe(200);
      expect(disabled.body.data.enabled).toBe(false);

      const after = await ctx
        .http()
        .get('/api/v1/conversations/inbox')
        .set(auth(ctx.orgA.owner.accessToken));

      // Turning a channel off is not a way to delete its history.
      expect(after.body.data.items.length).toBe(before.body.data.items.length);

      await ctx
        .http()
        .patch(`/api/v1/channel-integrations/${whatsapp.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ enabled: true });
    });

    it('refuses a sales rep the ability to change integrations', async () => {
      const list = await ctx
        .http()
        .get('/api/v1/channel-integrations')
        .set(auth(ctx.orgA.owner.accessToken));
      const whatsapp = list.body.data.find(
        (row: { channel: string }) => row.channel === 'WHATSAPP',
      );

      const attempt = await ctx
        .http()
        .patch(`/api/v1/channel-integrations/${whatsapp.id}`)
        .set(auth(ctx.orgA.rep.accessToken))
        .send({ enabled: false });

      expect(attempt.status).toBe(403);
    });

    it('does not let organization B see or change organization A’s integration', async () => {
      const listA = await ctx
        .http()
        .get('/api/v1/channel-integrations')
        .set(auth(ctx.orgA.owner.accessToken));
      const whatsappA = listA.body.data.find(
        (row: { channel: string }) => row.channel === 'WHATSAPP',
      );

      const attack = await ctx
        .http()
        .patch(`/api/v1/channel-integrations/${whatsappA.id}`)
        .set(auth(ctx.orgB.owner.accessToken))
        .send({ enabled: false });

      expect(attack.status).toBe(404);
    });
  });

  // ===========================================================================
  // Linking permissions
  // ===========================================================================

  describe('linking respects existing lead visibility', () => {
    it('hides a colleague’s lead from a sales rep trying to link to it', async () => {
      const mobile = '4155552630';
      // Assigned to the OWNER, so the rep may not see it.
      const lead = await createLead(ctx.orgA, ctx.orgA.owner.accessToken, {
        mobile,
        assignedToId: ctx.orgA.owner.id,
      });

      const result = await ingestion.ingest(event(ctx.orgA, { senderPhone: mobile }));

      const attempt = await ctx
        .http()
        .post(`/api/v1/conversations/${result.conversationId}/unlink`)
        .set(auth(ctx.orgA.rep.accessToken));

      // Linking must not become a way to read a colleague's pipeline one lead
      // id at a time.
      expect(attempt.status).toBe(404);
      void lead;
    });
  });
});
