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
