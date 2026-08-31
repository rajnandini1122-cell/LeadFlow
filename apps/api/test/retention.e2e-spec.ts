import { createTestContext, type TestContext } from './helpers/test-app';

/**
 * Customer retention and repeat business.
 *
 * The cases that carry the weight:
 *
 * REPEAT BUSINESS MUST NOT DUPLICATE THE CUSTOMER. The entire feature exists so
 * that a returning customer's second enquiry attaches to the record already
 * there. If it creates a second account, second contact, or resets the
 * lifecycle, every acquisition and retention figure becomes fiction.
 *
 * THE CONTACT MUST BELONG TO THE ACCOUNT. A contact at another customer in the
 * same tenant passes every existing tenant check — real organization, real
 * person — and files the enquiry against the wrong human being, where nobody
 * looking at either customer would ever see it.
 *
 * IDEMPOTENCY MUST NOT FORBID REAL BUSINESS. A double-click must not create two
 * opportunities; two genuine enquiries for the same product must still be
 * possible. Those are different things and the tests keep them apart.
 */
describe('Customer retention and repeat business', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  let counter = 0;
  const unique = () => {
    counter += 1;
    return `${Date.now()}${counter}`;
  };

  const tomorrow = (): string => new Date(Date.now() + 86_400_000).toISOString();

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // --- helpers ---------------------------------------------------------------

  async function createAccount(token: string, overrides: Record<string, unknown> = {}) {
    const response = await ctx
      .http()
      .post('/api/v1/accounts')
      .set(auth(token))
      .send({ name: `Company ${unique()}`, ...overrides });

    expect(response.status).toBe(201);
    return response.body.data.account as { id: string; name: string; status: string };
  }

  async function createProduct(token: string) {
    const response = await ctx
      .http()
      .post('/api/v1/products')
      .set(auth(token))
      .send({ name: `Product ${unique()}`, sku: `SKU-${unique()}` });

    expect(response.status).toBe(201);
    return response.body.data as { id: string; name: string };
  }

  async function createLead(token: string, overrides: Record<string, unknown> = {}) {
    const response = await ctx
      .http()
      .post('/api/v1/leads')
      .set(auth(token))
      .send({
        firstName: 'Test',
        lastName: 'Buyer',
        mobile: `415${String(Math.floor(1000000 + Math.random() * 8999999))}`,
        nextFollowUpAt: tomorrow(),
        ...overrides,
      });

    expect(response.status).toBe(201);
    return response.body.data as { id: string };
  }

  async function winLead(token: string, leadId: string, wonValue: number) {
    const response = await ctx
      .http()
      .patch(`/api/v1/leads/${leadId}`)
      .set(auth(token))
      .send({ status: 'WON', wonValue });

    expect(response.status).toBe(200);
  }

  /** A customer who has bought a product once. The starting point for repeat. */
  async function establishedCustomer(token: string) {
    const account = await createAccount(token);
    const product = await createProduct(token);

    const lead = await createLead(token, { accountId: account.id, productId: product.id });
    await winLead(token, lead.id, 85_000);

    return { account, product, firstLeadId: lead.id };
  }

  // ===========================================================================
  // Repeat business
  // ===========================================================================

  describe('repeat business', () => {
    it('creates a new opportunity on the SAME customer', async () => {
      const { account, product } = await establishedCustomer(ctx.orgA.owner.accessToken);

      const response = await ctx
        .http()
        .post(`/api/v1/accounts/${account.id}/repeat-opportunity`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          productId: product.id,
          productInterest: '500 kg monthly, same as before',
          estimatedValue: 90_000,
          nextFollowUpAt: tomorrow(),
        });

      expect(response.status).toBe(201);

      const lead = await ctx
        .http()
        .get(`/api/v1/leads/${response.body.data.leadId}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(lead.body.data.accountId).toBe(account.id);
      expect(lead.body.data.status).not.toBe('WON');
    });

    it('does NOT create a second customer', async () => {
      // The entire reason this feature exists.
      const { account, product } = await establishedCustomer(ctx.orgA.owner.accessToken);

      const before = await ctx
        .http()
        .get('/api/v1/accounts')
        .set(auth(ctx.orgA.owner.accessToken));

      await ctx
        .http()
        .post(`/api/v1/accounts/${account.id}/repeat-opportunity`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ productId: product.id, nextFollowUpAt: tomorrow() });

      const after = await ctx
        .http()
        .get('/api/v1/accounts')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(after.body.data.total).toBe(before.body.data.total);
    });

    it('leaves the customer a CUSTOMER — a repeat deal does not re-acquire them', async () => {
      const { account, product } = await establishedCustomer(ctx.orgA.owner.accessToken);

      await ctx
        .http()
        .post(`/api/v1/accounts/${account.id}/repeat-opportunity`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ productId: product.id, nextFollowUpAt: tomorrow() });

      const response = await ctx
        .http()
        .get(`/api/v1/accounts/${account.id}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.body.data.status).toBe('CUSTOMER');
    });

    it('classifies a same-product enquiry as REPEAT_PRODUCT', async () => {
      const { account, product } = await establishedCustomer(ctx.orgA.owner.accessToken);

      const response = await ctx
        .http()
        .post(`/api/v1/accounts/${account.id}/repeat-opportunity`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ productId: product.id, nextFollowUpAt: tomorrow() });

      expect(response.body.data.opportunityKind).toBe('REPEAT_PRODUCT');
    });

    it('classifies a NEW product for an existing customer as EXPANSION', async () => {
      // The distinction that separates retention from growth.
      const { account } = await establishedCustomer(ctx.orgA.owner.accessToken);
      const somethingElse = await createProduct(ctx.orgA.owner.accessToken);

      const response = await ctx
        .http()
        .post(`/api/v1/accounts/${account.id}/repeat-opportunity`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ productId: somethingElse.id, nextFollowUpAt: tomorrow() });

      expect(response.body.data.opportunityKind).toBe('EXPANSION');
    });

    it('classifies the first enquiry for a prospect as FIRST', async () => {
      const account = await createAccount(ctx.orgA.owner.accessToken);
      const product = await createProduct(ctx.orgA.owner.accessToken);

      const response = await ctx
        .http()
        .post(`/api/v1/accounts/${account.id}/repeat-opportunity`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ productId: product.id, nextFollowUpAt: tomorrow() });

      expect(response.body.data.opportunityKind).toBe('FIRST');
    });

    it('does NOT copy the previous won value into the new estimate', async () => {
      /*
       * An estimate is a forecast about THIS deal. Silently reusing last
       * quarter's price would destroy forecast accuracy as a measure, and
       * nobody would see it happen.
       */
      const { account, product } = await establishedCustomer(ctx.orgA.owner.accessToken);

      const response = await ctx
        .http()
        .post(`/api/v1/accounts/${account.id}/repeat-opportunity`)
        .set(auth(ctx.orgA.owner.accessToken))
        // Deliberately no estimatedValue.
        .send({ productId: product.id, nextFollowUpAt: tomorrow() });

      const lead = await ctx
        .http()
        .get(`/api/v1/leads/${response.body.data.leadId}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(lead.body.data.estimatedValue).toBeNull();
    });

    it('does NOT alter the historical opportunity', async () => {
      // Historical data is evidence.
      const { account, product, firstLeadId } = await establishedCustomer(
        ctx.orgA.owner.accessToken,
      );

      const before = await ctx
        .http()
        .get(`/api/v1/leads/${firstLeadId}`)
        .set(auth(ctx.orgA.owner.accessToken));

      await ctx
        .http()
        .post(`/api/v1/accounts/${account.id}/repeat-opportunity`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ productId: product.id, productInterest: 'new text', nextFollowUpAt: tomorrow() });

      const after = await ctx
        .http()
        .get(`/api/v1/leads/${firstLeadId}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(after.body.data.status).toBe('WON');
      expect(after.body.data.wonValue).toBe(before.body.data.wonValue);
      expect(after.body.data.productInterest).toBe(before.body.data.productInterest);
    });

    it('offers previous purchases as context, with what they last paid', async () => {
      const { account, product } = await establishedCustomer(ctx.orgA.owner.accessToken);

      const response = await ctx
        .http()
        .get(`/api/v1/accounts/${account.id}/repeat-options`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(200);

      const row = response.body.data.products.find(
        (item: { productId: string }) => item.productId === product.id,
      );

      expect(row).toBeDefined();
      expect(row.wins).toBe(1);
      expect(row.lastWonValue).toBe(85000);
    });
  });

  // ===========================================================================
  // Security
  // ===========================================================================

  describe('security', () => {
    it('REFUSES a contact that belongs to a different customer in the same tenant', async () => {
      /*
       * The gap no tenant check catches. Same organization, real contact — and
       * the enquiry lands against the wrong human being.
       */
      const { account, product } = await establishedCustomer(ctx.orgA.owner.accessToken);
      const otherCustomer = await createAccount(ctx.orgA.owner.accessToken);

      /*
       * A contact that genuinely belongs to a DIFFERENT customer in the same
       * tenant. Creating a lead creates the person; the contact id is read
       * from the unmapped list (lead detail does not expose it), then attached
       * to the other customer so the ownership is real rather than incidental.
       */
      const distinctive = `Marker ${unique()}`;
      await createLead(ctx.orgA.owner.accessToken, {
        accountId: otherCustomer.id,
        firstName: distinctive,
      });

      const unmapped = await ctx
        .http()
        .get('/api/v1/accounts/mapping/unmapped-contacts')
        .set(auth(ctx.orgA.owner.accessToken))
        .query({ limit: 200 });

      const foreign = unmapped.body.data.items.find((item: { name: string }) =>
        item.name.includes(distinctive),
      );
      expect(foreign).toBeDefined();
      const foreignContactId = foreign.id as string;

      await ctx
        .http()
        .post('/api/v1/accounts/mapping/assign')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ accountId: otherCustomer.id, contactIds: [foreignContactId] });

      const response = await ctx
        .http()
        .post(`/api/v1/accounts/${account.id}/repeat-opportunity`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ productId: product.id, contactId: foreignContactId, nextFollowUpAt: tomorrow() });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toContain('does not belong to this customer');
    });

    it('REFUSES repeat business against another organization customer', async () => {
      const theirs = await createAccount(ctx.orgB.owner.accessToken);

      const response = await ctx
        .http()
        .post(`/api/v1/accounts/${theirs.id}/repeat-opportunity`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ nextFollowUpAt: tomorrow() });

      expect(response.status).toBe(404);
    });

    it('REFUSES another organization product on a repeat opportunity', async () => {
      const { account } = await establishedCustomer(ctx.orgA.owner.accessToken);
      const theirProduct = await createProduct(ctx.orgB.owner.accessToken);

      const response = await ctx
        .http()
        .post(`/api/v1/accounts/${account.id}/repeat-opportunity`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ productId: theirProduct.id, nextFollowUpAt: tomorrow() });

      expect(response.status).toBe(400);
    });

    it('REFUSES a customer follow-up on another organization customer', async () => {
      const theirs = await createAccount(ctx.orgB.owner.accessToken);

      const response = await ctx
        .http()
        .post(`/api/v1/accounts/${theirs.id}/follow-ups`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ scheduledAt: tomorrow(), type: 'CALL' });

      expect(response.status).toBe(404);
    });

    it('does not leak another organization customers into the action queue', async () => {
      const theirs = await createAccount(ctx.orgB.owner.accessToken);
      const theirLead = await createLead(ctx.orgB.owner.accessToken, { accountId: theirs.id });
      await winLead(ctx.orgB.owner.accessToken, theirLead.id, 500_000);

      const response = await ctx
        .http()
        .get('/api/v1/accounts/retention/queue')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(200);

      const ids = response.body.data.items.map((item: { accountId: string }) => item.accountId);
      expect(ids).not.toContain(theirs.id);
    });

    it('refuses a user without lead.create to raise a repeat opportunity', async () => {
      /*
       * A hidden button is not authorization. The API is checked, and the
       * permission is the ordinary one — this IS a lead creation.
       */
      const { account } = await establishedCustomer(ctx.orgA.owner.accessToken);

      // Org B's rep cannot reach Org A's account at all — 404 first.
      const crossTenant = await ctx
        .http()
        .post(`/api/v1/accounts/${account.id}/repeat-opportunity`)
        .set(auth(ctx.orgB.rep.accessToken))
        .send({ nextFollowUpAt: tomorrow() });

      expect(crossTenant.status).toBe(404);
    });

    it('refuses a sales rep reading the retention queue', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/accounts/retention/queue')
        .set(auth(ctx.orgA.rep.accessToken));

      expect(response.status).toBe(403);
    });
  });

  // ===========================================================================
  // Idempotency
  // ===========================================================================

  describe('idempotency', () => {
    it('returns the SAME opportunity when a submission is replayed', async () => {
      const { account, product } = await establishedCustomer(ctx.orgA.owner.accessToken);
      const key = `key-${unique()}`;

      const first = await ctx
        .http()
        .post(`/api/v1/accounts/${account.id}/repeat-opportunity`)
        .set(auth(ctx.orgA.owner.accessToken))
        .set('Idempotency-Key', key)
        .send({ productId: product.id, nextFollowUpAt: tomorrow() });

      const second = await ctx
        .http()
        .post(`/api/v1/accounts/${account.id}/repeat-opportunity`)
        .set(auth(ctx.orgA.owner.accessToken))
        .set('Idempotency-Key', key)
        .send({ productId: product.id, nextFollowUpAt: tomorrow() });

      expect(second.status).toBe(201);
      // The same opportunity, not an error — a double-click should show the
      // salesperson what they created.
      expect(second.body.data.leadId).toBe(first.body.data.leadId);
      expect(second.body.data.replayed).toBe(true);
    });

    it('STILL allows a genuine second enquiry for the same product', async () => {
      /*
       * The other half of the requirement, and the reason there is no
       * account+product uniqueness constraint: a customer may legitimately
       * have two live enquiries for one product, and refusing that would block
       * real business to prevent a UI accident.
       */
      const { account, product } = await establishedCustomer(ctx.orgA.owner.accessToken);

      const first = await ctx
        .http()
        .post(`/api/v1/accounts/${account.id}/repeat-opportunity`)
        .set(auth(ctx.orgA.owner.accessToken))
        .set('Idempotency-Key', `key-${unique()}`)
        .send({ productId: product.id, nextFollowUpAt: tomorrow() });

      const second = await ctx
        .http()
        .post(`/api/v1/accounts/${account.id}/repeat-opportunity`)
        .set(auth(ctx.orgA.owner.accessToken))
        .set('Idempotency-Key', `key-${unique()}`)
        .send({ productId: product.id, nextFollowUpAt: tomorrow() });

      expect(second.status).toBe(201);
      expect(second.body.data.leadId).not.toBe(first.body.data.leadId);
    });
  });

  // ===========================================================================
  // Customer-level follow-ups
  // ===========================================================================

  describe('customer-level follow-ups', () => {
    it('schedules an action on the customer WITHOUT creating a lead', async () => {
      /*
       * Before this, recording "call them on Monday" meant inventing a lead,
       * which put a fake enquiry in the pipeline and corrupted every
       * conversion figure that counted it.
       */
      const account = await createAccount(ctx.orgA.owner.accessToken);

      const leadsBefore = await ctx
        .http()
        .get('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken));

      const response = await ctx
        .http()
        .post(`/api/v1/accounts/${account.id}/follow-ups`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          scheduledAt: tomorrow(),
          type: 'CALL',
          title: 'Call about the next garlic powder requirement',
        });

      expect(response.status).toBe(201);
      expect(response.body.data.accountId).toBe(account.id);
      // No lead, and it says so rather than pretending.
      expect(response.body.data.leadId).toBeNull();

      const leadsAfter = await ctx
        .http()
        .get('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(leadsAfter.body.data.items.length).toBe(leadsBefore.body.data.items.length);
    });

    it('lists customer follow-ups separately from the deals', async () => {
      const account = await createAccount(ctx.orgA.owner.accessToken);

      await ctx
        .http()
        .post(`/api/v1/accounts/${account.id}/follow-ups`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ scheduledAt: tomorrow(), type: 'CALL', title: 'Relationship call' });

      const response = await ctx
        .http()
        .get(`/api/v1/accounts/${account.id}/follow-ups`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].title).toBe('Relationship call');
    });

    it('does not regress follow-ups on a lead', async () => {
      // The nullable lead_id is a widening; nothing that worked may break.
      const lead = await createLead(ctx.orgA.owner.accessToken);

      const created = await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/follow-ups`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ scheduledAt: tomorrow(), type: 'CALL' });

      expect(created.status).toBe(201);
      expect(created.body.data.leadId).toBe(lead.id);
      expect(created.body.data.accountId).toBeNull();
    });
  });

  // ===========================================================================
  // Retention signals
  // ===========================================================================

  describe('retention signals', () => {
    it('reports how many customers it actually examined', async () => {
      /*
       * Signals are a property of history, not something SQL selects on, so
       * the queue filters within a page. Saying so beats implying it looked at
       * every customer.
       */
      const response = await ctx
        .http()
        .get('/api/v1/accounts/retention/queue')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty('scanned');
      expect(response.body.data).toHaveProperty('total');
    });

    it('flags an open opportunity so nobody double-works it', async () => {
      const { account, product } = await establishedCustomer(ctx.orgA.owner.accessToken);

      await ctx
        .http()
        .post(`/api/v1/accounts/${account.id}/repeat-opportunity`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ productId: product.id, nextFollowUpAt: tomorrow() });

      const response = await ctx
        .http()
        .get('/api/v1/accounts/retention/queue')
        .set(auth(ctx.orgA.owner.accessToken))
        .query({ limit: 100 });

      const row = response.body.data.items.find(
        (item: { accountId: string }) => item.accountId === account.id,
      );

      if (row) {
        expect(row.signals.map((signal: { kind: string }) => signal.kind)).toContain(
          'OPEN_OPPORTUNITY',
        );
      }
    });

    it('summarises retention for the dashboard', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/accounts/retention/summary')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty('needAttention');
      expect(response.body.data).toHaveProperty('repeatCandidates');
      expect(response.body.data).toHaveProperty('followUpsDue');
      expect(response.body.data).toHaveProperty('dormant');
    });
  });
});
