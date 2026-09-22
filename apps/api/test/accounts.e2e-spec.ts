import { createTestContext, type TestContext } from './helpers/test-app';
import { fixtureMobile } from './helpers/phone-fixtures';

/**
 * Customers, Customer 360, and the relationship lifecycle.
 *
 * Three groups carry the weight here.
 *
 * The TENANT cases. An account id is what leads, contacts and follow-ups
 * reference and what every customer KPI groups by. A leak is not "Org A saw a
 * company name" — it would let Org A attach Org B's customer to their own lead,
 * and Org B's Customer 360 would then show revenue from opportunities they
 * cannot see. Nothing looks wrong until the figures are compared with reality.
 * The Prisma extension scopes QUERIES; a foreign key assignment is not a query,
 * so those cases are tested explicitly.
 *
 * The MERGE cases. Merging fuses two customers' histories and there is no undo.
 * So: it needs its own permission, it must never cross a tenant, and it must
 * move everything or nothing.
 *
 * The LIFECYCLE cases. The whole feature exists so that winning a repeat deal
 * does not manufacture a second customer. That is asserted directly.
 */
describe('Accounts and Customer 360', () => {
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

  async function createAccount(
    token: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; name: string; status: string }> {
    const response = await ctx
      .http()
      .post('/api/v1/accounts')
      .set(auth(token))
      .send({ name: `Company ${unique()}`, ...overrides });

    expect(response.status).toBe(201);
    return response.body.data.account;
  }

  async function createLead(
    token: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string }> {
    const response = await ctx
      .http()
      .post('/api/v1/leads')
      .set(auth(token))
      .send({
        firstName: 'Test',
        lastName: 'Buyer',
        mobile: fixtureMobile(),
        nextFollowUpAt: tomorrow(),
        ...overrides,
      });

    expect(response.status).toBe(201);
    return response.body.data;
  }

  async function winLead(token: string, leadId: string, wonValue: number): Promise<void> {
    const response = await ctx
      .http()
      .patch(`/api/v1/leads/${leadId}`)
      .set(auth(token))
      .send({ status: 'WON', wonValue });

    expect(response.status).toBe(200);
  }

  // ===========================================================================
  // Tenant isolation
  // ===========================================================================

  describe('tenant isolation', () => {
    it('does not list another organization customers', async () => {
      const mine = await createAccount(ctx.orgA.owner.accessToken, { name: `A ${unique()}` });
      await createAccount(ctx.orgB.owner.accessToken, { name: `B ${unique()}` });

      const response = await ctx
        .http()
        .get('/api/v1/accounts')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(200);

      const ids = response.body.data.items.map((item: { id: string }) => item.id);
      expect(ids).toContain(mine.id);

      const names = response.body.data.items.map((item: { name: string }) => item.name);
      expect(names.every((name: string) => !name.startsWith('B '))).toBe(true);
    });

    it('returns 404 — not 403 — for another organization customer', async () => {
      /*
       * 403 would confirm the id exists, turning the endpoint into an
       * enumeration oracle over the customer list.
       */
      const theirs = await createAccount(ctx.orgB.owner.accessToken);

      const response = await ctx
        .http()
        .get(`/api/v1/accounts/${theirs.id}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(404);
    });

    it('returns 404 for another organization Customer 360', async () => {
      const theirs = await createAccount(ctx.orgB.owner.accessToken);

      const response = await ctx
        .http()
        .get(`/api/v1/accounts/${theirs.id}/360`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(404);
    });

    it('REFUSES to attach another organization customer when CREATING a lead', async () => {
      /*
       * The gap the Prisma extension cannot close. The extension narrows
       * queries; a foreign key assignment is not a query. Without the explicit
       * check the insert would succeed, the FK would be satisfied, and Org B's
       * Customer 360 would quietly begin showing Org A's opportunities.
       */
      const theirs = await createAccount(ctx.orgB.owner.accessToken);

      const response = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          firstName: 'Cross',
          lastName: 'Tenant',
          mobile: fixtureMobile(),
          nextFollowUpAt: tomorrow(),
          accountId: theirs.id,
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('REFUSES to attach another organization customer when UPDATING a lead', async () => {
      // The same hole through the other door.
      const theirs = await createAccount(ctx.orgB.owner.accessToken);
      const lead = await createLead(ctx.orgA.owner.accessToken);

      const response = await ctx
        .http()
        .patch(`/api/v1/leads/${lead.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ accountId: theirs.id });

      expect(response.status).toBe(400);
    });

    it('REFUSES to map leads onto another organization customer', async () => {
      const theirs = await createAccount(ctx.orgB.owner.accessToken);
      const lead = await createLead(ctx.orgA.owner.accessToken);

      const response = await ctx
        .http()
        .post('/api/v1/accounts/mapping/assign')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ accountId: theirs.id, leadIds: [lead.id] });

      expect(response.status).toBe(404);
    });

    it('does not leak another organization revenue into customer KPIs', async () => {
      const theirAccount = await createAccount(ctx.orgB.owner.accessToken);
      const theirLead = await createLead(ctx.orgB.owner.accessToken, {
        accountId: theirAccount.id,
      });
      await winLead(ctx.orgB.owner.accessToken, theirLead.id, 999_999);

      const response = await ctx
        .http()
        .get('/api/v1/accounts/kpi/top-customers')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(200);

      const ids = response.body.data.items.map((item: { accountId: string }) => item.accountId);
      expect(ids).not.toContain(theirAccount.id);
    });

    it('REFUSES a cross-tenant merge', async () => {
      /*
       * The most damaging single operation available. Both ids are read
       * through the tenant-scoped repository, so the foreign one resolves to
       * nothing and the caller gets the ordinary 404.
       */
      const mine = await createAccount(ctx.orgA.owner.accessToken);
      const theirs = await createAccount(ctx.orgB.owner.accessToken);

      const response = await ctx
        .http()
        .post(`/api/v1/accounts/${mine.id}/merge`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ survivorId: theirs.id });

      expect(response.status).toBe(404);
    });
  });

  // ===========================================================================
  // Authorization
  // ===========================================================================

  describe('authorization', () => {
    it('lets a sales rep READ customers', async () => {
      // A rep has to pick a customer when creating a lead.
      const response = await ctx
        .http()
        .get('/api/v1/accounts')
        .set(auth(ctx.orgA.rep.accessToken));

      expect(response.status).toBe(200);
    });

    it('lets a sales rep CREATE a customer', async () => {
      /*
       * A rep on a call with a company nobody has dealt with must be able to
       * record it. Withholding this is how the free-text company field became
       * unusable in the first place.
       */
      const response = await ctx
        .http()
        .post('/api/v1/accounts')
        .set(auth(ctx.orgA.rep.accessToken))
        .send({ name: `Rep Co ${unique()}` });

      expect(response.status).toBe(201);
    });

    it('refuses a sales rep EDITING a customer', async () => {
      const account = await createAccount(ctx.orgA.owner.accessToken);

      const response = await ctx
        .http()
        .patch(`/api/v1/accounts/${account.id}`)
        .set(auth(ctx.orgA.rep.accessToken))
        .send({ industry: 'Food' });

      expect(response.status).toBe(403);
    });

    it('refuses a sales rep RECLASSIFYING a customer', async () => {
      const account = await createAccount(ctx.orgA.owner.accessToken);

      const response = await ctx
        .http()
        .patch(`/api/v1/accounts/${account.id}/status`)
        .set(auth(ctx.orgA.rep.accessToken))
        .send({ status: 'FORMER_CUSTOMER' });

      expect(response.status).toBe(403);
    });

    it('refuses a sales rep MERGING customers', async () => {
      // Irreversible, so it holds its own permission.
      const one = await createAccount(ctx.orgA.owner.accessToken);
      const two = await createAccount(ctx.orgA.owner.accessToken);

      const response = await ctx
        .http()
        .post(`/api/v1/accounts/${one.id}/merge`)
        .set(auth(ctx.orgA.rep.accessToken))
        .send({ survivorId: two.id });

      expect(response.status).toBe(403);
    });

    it('refuses a sales rep reading customer KPIs', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/accounts/kpi/overview')
        .set(auth(ctx.orgA.rep.accessToken));

      expect(response.status).toBe(403);
    });
  });

  // ===========================================================================
  // Duplicate detection
  // ===========================================================================

  describe('duplicate detection', () => {
    it('refuses a second account for the same company, and names it', async () => {
      const name = `Duplicate Test ${unique()}`;
      const first = await createAccount(ctx.orgA.owner.accessToken, { name });

      const response = await ctx
        .http()
        .post('/api/v1/accounts')
        .set(auth(ctx.orgA.owner.accessToken))
        // A legal suffix is not a different company.
        .send({ name: `${name} Pvt Ltd` });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('DUPLICATE_ACCOUNT');
      // The evidence, so the client can offer "open the existing one".
      expect(response.body.error.details.duplicateAccountIds).toContain(first.id);
      expect(response.body.error.details.duplicateMatchedOn[0]).toContain('name');
    });

    it('creates anyway when the caller confirms it is a different company', async () => {
      // Franchises and separately-run branches are real.
      const name = `Forced ${unique()}`;
      await createAccount(ctx.orgA.owner.accessToken, { name });

      const response = await ctx
        .http()
        .post('/api/v1/accounts')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ name, force: true });

      expect(response.status).toBe(201);
    });

    it('does NOT flag a merely similar name', async () => {
      // "Sun Foods" and "Sen Foods" are two businesses.
      await createAccount(ctx.orgA.owner.accessToken, { name: `Sunburst ${unique()}` });

      const response = await ctx
        .http()
        .post('/api/v1/accounts')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ name: `Sunburnt ${unique()}` });

      expect(response.status).toBe(201);
    });

    it('does not treat a shared free-mail domain as a duplicate', async () => {
      /*
       * Half a city shares gmail.com. Matching on it would propose merging
       * every small customer into one.
       */
      await createAccount(ctx.orgA.owner.accessToken, {
        name: `Gmail One ${unique()}`,
        email: 'one@gmail.com',
      });

      const response = await ctx
        .http()
        .post('/api/v1/accounts')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ name: `Gmail Two ${unique()}`, email: 'two@gmail.com' });

      expect(response.status).toBe(201);
    });

    it('flags a shared company domain even under a different name', async () => {
      const domain = `acme${unique()}.com`;
      await createAccount(ctx.orgA.owner.accessToken, {
        name: `Acme Trading ${unique()}`,
        website: `https://${domain}`,
      });

      const response = await ctx
        .http()
        .post('/api/v1/accounts')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ name: `Completely Different ${unique()}`, website: `www.${domain}` });

      expect(response.status).toBe(409);
      expect(response.body.error.details.duplicateConfidences[0]).toBe('HIGH');
    });
  });

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  describe('lifecycle', () => {
    it('starts every new account as a PROSPECT', async () => {
      // Being a customer is earned, not declared.
      const account = await createAccount(ctx.orgA.owner.accessToken);
      expect(account.status).toBe('PROSPECT');
    });

    it('promotes a prospect to CUSTOMER when its opportunity is won', async () => {
      const account = await createAccount(ctx.orgA.owner.accessToken);
      const lead = await createLead(ctx.orgA.owner.accessToken, { accountId: account.id });

      await winLead(ctx.orgA.owner.accessToken, lead.id, 50_000);

      const response = await ctx
        .http()
        .get(`/api/v1/accounts/${account.id}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.body.data.status).toBe('CUSTOMER');
      expect(response.body.data.firstWonAt).not.toBeNull();
    });

    it('does NOT create a second customer when an existing one buys again', async () => {
      /*
       * The reason this whole feature exists. Before accounts, a repeat
       * customer's second win produced a record indistinguishable from a new
       * customer — double-counting acquisition and making retention
       * impossible to measure.
       */
      const account = await createAccount(ctx.orgA.owner.accessToken);

      const first = await createLead(ctx.orgA.owner.accessToken, { accountId: account.id });
      await winLead(ctx.orgA.owner.accessToken, first.id, 50_000);

      const before = await ctx
        .http()
        .get(`/api/v1/accounts/${account.id}`)
        .set(auth(ctx.orgA.owner.accessToken));
      const firstWonAt = before.body.data.firstWonAt;

      const second = await createLead(ctx.orgA.owner.accessToken, { accountId: account.id });
      await winLead(ctx.orgA.owner.accessToken, second.id, 30_000);

      const after = await ctx
        .http()
        .get(`/api/v1/accounts/${account.id}/360`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(after.body.data.commercial.wonCount).toBe(2);
      expect(after.body.data.commercial.isRepeatCustomer).toBe(true);
      // The acquisition date must NOT move forward on a repeat purchase.
      expect(after.body.data.account.firstWonAt).toBe(firstWonAt);
    });

    it('does NOT demote a customer when a later deal is lost', async () => {
      // Five wins and one loss is still a customer.
      const account = await createAccount(ctx.orgA.owner.accessToken);

      const won = await createLead(ctx.orgA.owner.accessToken, { accountId: account.id });
      await winLead(ctx.orgA.owner.accessToken, won.id, 20_000);

      const lost = await createLead(ctx.orgA.owner.accessToken, { accountId: account.id });
      await ctx
        .http()
        .patch(`/api/v1/leads/${lost.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ status: 'LOST', lostReason: 'Price' });

      const response = await ctx
        .http()
        .get(`/api/v1/accounts/${account.id}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.body.data.status).toBe('CUSTOMER');
    });

    it('refuses to DECLARE a prospect a customer', async () => {
      /*
       * If this were settable by hand, the customer count and the won-deal
       * count could disagree with no way to tell which was right.
       */
      const account = await createAccount(ctx.orgA.owner.accessToken);

      const response = await ctx
        .http()
        .patch(`/api/v1/accounts/${account.id}/status`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ status: 'CUSTOMER' });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toContain('winning an opportunity');
    });

    it('allows a person to mark a customer as former', async () => {
      const account = await createAccount(ctx.orgA.owner.accessToken);
      const lead = await createLead(ctx.orgA.owner.accessToken, { accountId: account.id });
      await winLead(ctx.orgA.owner.accessToken, lead.id, 10_000);

      const response = await ctx
        .http()
        .patch(`/api/v1/accounts/${account.id}/status`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ status: 'FORMER_CUSTOMER', reason: 'Moved to a competitor' });

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('FORMER_CUSTOMER');
    });

    it('promotes a former customer back when they buy again', async () => {
      const account = await createAccount(ctx.orgA.owner.accessToken);

      const first = await createLead(ctx.orgA.owner.accessToken, { accountId: account.id });
      await winLead(ctx.orgA.owner.accessToken, first.id, 10_000);

      await ctx
        .http()
        .patch(`/api/v1/accounts/${account.id}/status`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ status: 'FORMER_CUSTOMER' });

      const second = await createLead(ctx.orgA.owner.accessToken, { accountId: account.id });
      await winLead(ctx.orgA.owner.accessToken, second.id, 15_000);

      const response = await ctx
        .http()
        .get(`/api/v1/accounts/${account.id}`)
        .set(auth(ctx.orgA.owner.accessToken));

      // Someone who buys again is a customer again.
      expect(response.body.data.status).toBe('CUSTOMER');
    });
  });

  // ===========================================================================
  // Customer 360
  // ===========================================================================

  describe('Customer 360', () => {
    it('shows opportunities, products and commercial figures together', async () => {
      const account = await createAccount(ctx.orgA.owner.accessToken);

      const product = await ctx
        .http()
        .post('/api/v1/products')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ name: `Garlic Powder ${unique()}`, sku: `GP-${unique()}` });

      const won = await createLead(ctx.orgA.owner.accessToken, {
        accountId: account.id,
        productId: product.body.data.id,
        productInterest: '500 kg monthly, food manufacturing use',
      });
      await winLead(ctx.orgA.owner.accessToken, won.id, 80_000);

      await createLead(ctx.orgA.owner.accessToken, {
        accountId: account.id,
        productId: product.body.data.id,
      });

      const response = await ctx
        .http()
        .get(`/api/v1/accounts/${account.id}/360`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(200);

      const body = response.body.data;
      expect(body.commercial.wonCount).toBe(1);
      expect(body.commercial.wonValue).toBe(80000);
      expect(body.openOpportunities.total).toBe(1);
      expect(body.closedOpportunities.total).toBe(1);

      // Product history, grouped.
      expect(body.products.items).toHaveLength(1);
      expect(body.products.items[0].enquiries).toBe(2);
      expect(body.products.items[0].won).toBe(1);
    });

    it('labels commercial figures as CRM opportunities, not invoiced revenue', async () => {
      /*
       * LeadFlow has no order table. Saying plainly what these numbers are
       * beats inventing an order concept to fill the section.
       */
      const account = await createAccount(ctx.orgA.owner.accessToken);

      const response = await ctx
        .http()
        .get(`/api/v1/accounts/${account.id}/360`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.body.data.commercial.basis).toBe('crm-opportunities');
    });

    it('preserves the free-text enquiry beside the standardised product', async () => {
      // The catalogue entry is the grouping key; the free text is what the
      // customer actually asked for. Neither replaces the other.
      const account = await createAccount(ctx.orgA.owner.accessToken);
      await createLead(ctx.orgA.owner.accessToken, {
        accountId: account.id,
        productInterest: '250 kg trial order, export grade',
      });

      const response = await ctx
        .http()
        .get(`/api/v1/accounts/${account.id}/360`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.body.data.openOpportunities.items[0].productInterest).toBe(
        '250 kg trial order, export grade',
      );
    });

    it('reports how many of a customer opportunities have NO product', async () => {
      /*
       * Without this, a customer with two mapped leads out of forty looks like
       * a two-product customer.
       */
      const account = await createAccount(ctx.orgA.owner.accessToken);
      await createLead(ctx.orgA.owner.accessToken, { accountId: account.id });

      const response = await ctx
        .http()
        .get(`/api/v1/accounts/${account.id}/360`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.body.data.products.leadsWithoutProduct).toBe(1);
    });

    it('suggests products this customer has never enquired about', async () => {
      const account = await createAccount(ctx.orgA.owner.accessToken);

      const bought = await ctx
        .http()
        .post('/api/v1/products')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ name: `Bought ${unique()}`, sku: `B-${unique()}` });

      const never = await ctx
        .http()
        .post('/api/v1/products')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ name: `Never ${unique()}`, sku: `N-${unique()}` });

      await createLead(ctx.orgA.owner.accessToken, {
        accountId: account.id,
        productId: bought.body.data.id,
      });

      const response = await ctx
        .http()
        .get(`/api/v1/accounts/${account.id}/360`)
        .set(auth(ctx.orgA.owner.accessToken));

      const gapIds = response.body.data.crossSell.map((row: { productId: string }) => row.productId);
      expect(gapIds).toContain(never.body.data.id);
      expect(gapIds).not.toContain(bought.body.data.id);
    });
  });

  // ===========================================================================
  // Merge
  // ===========================================================================

  describe('merge', () => {
    it('moves every opportunity to the survivor and retains the merged record', async () => {
      const loser = await createAccount(ctx.orgA.owner.accessToken);
      const survivor = await createAccount(ctx.orgA.owner.accessToken);

      const lead = await createLead(ctx.orgA.owner.accessToken, { accountId: loser.id });

      const response = await ctx
        .http()
        .post(`/api/v1/accounts/${loser.id}/merge`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ survivorId: survivor.id });

      expect(response.status).toBe(201);
      expect(response.body.data.moved.leads).toBe(1);

      const after = await ctx
        .http()
        .get(`/api/v1/leads/${lead.id}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(after.body.data.accountId).toBe(survivor.id);
    });

    it('points a merged account at its survivor rather than vanishing', async () => {
      /*
       * A reference to a merged account must still resolve to something. A
       * bare 404 for a company whose history is sitting right there under a
       * different id is worse than useless.
       */
      const loser = await createAccount(ctx.orgA.owner.accessToken);
      const survivor = await createAccount(ctx.orgA.owner.accessToken, {
        name: `Survivor ${unique()}`,
      });

      await ctx
        .http()
        .post(`/api/v1/accounts/${loser.id}/merge`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ survivorId: survivor.id });

      const response = await ctx
        .http()
        .get(`/api/v1/accounts/${loser.id}/360`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(404);
      expect(response.body.error.message).toContain(survivor.name);
    });

    it('carries the EARLIER first-won date onto the survivor', async () => {
      /*
       * Acquisition is counted from this date. Keeping the survivor's own
       * would lose the fact that the merged customer bought earlier.
       */
      const loser = await createAccount(ctx.orgA.owner.accessToken);
      const survivor = await createAccount(ctx.orgA.owner.accessToken);

      const oldDeal = await createLead(ctx.orgA.owner.accessToken, { accountId: loser.id });
      await winLead(ctx.orgA.owner.accessToken, oldDeal.id, 5_000);

      await ctx
        .http()
        .post(`/api/v1/accounts/${loser.id}/merge`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ survivorId: survivor.id });

      const response = await ctx
        .http()
        .get(`/api/v1/accounts/${survivor.id}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.body.data.firstWonAt).not.toBeNull();
      // Inheriting a won deal makes the survivor a customer.
      expect(response.body.data.status).toBe('CUSTOMER');
    });

    it('refuses to merge an account into itself', async () => {
      const account = await createAccount(ctx.orgA.owner.accessToken);

      const response = await ctx
        .http()
        .post(`/api/v1/accounts/${account.id}/merge`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ survivorId: account.id });

      expect(response.status).toBe(400);
    });

    it('refuses to merge into an account that was itself already merged', async () => {
      // Otherwise the survivor chain grows and the customer ends up nowhere
      // obvious.
      const first = await createAccount(ctx.orgA.owner.accessToken);
      const second = await createAccount(ctx.orgA.owner.accessToken);
      const third = await createAccount(ctx.orgA.owner.accessToken);

      await ctx
        .http()
        .post(`/api/v1/accounts/${first.id}/merge`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ survivorId: second.id });

      await ctx
        .http()
        .post(`/api/v1/accounts/${second.id}/merge`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ survivorId: third.id });

      const response = await ctx
        .http()
        .post(`/api/v1/accounts/${third.id}/merge`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ survivorId: second.id });

      expect(response.status).toBe(400);
    });
  });

  // ===========================================================================
  // Backfill
  // ===========================================================================

  describe('backfill', () => {
    it('reports progress including leads with no company name to group on', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/accounts/mapping/progress')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty('withoutCompanyName');
      expect(response.body.data).toHaveProperty('percentMapped');
    });

    it('groups unmapped leads by company name and shows every spelling', async () => {
      const base = `Grouped ${unique()}`;

      await createLead(ctx.orgA.owner.accessToken, { companyName: base });
      await createLead(ctx.orgA.owner.accessToken, { companyName: `${base} Pvt Ltd` });

      const response = await ctx
        .http()
        .get('/api/v1/accounts/mapping/suggestions')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(200);

      const group = response.body.data.groups.find(
        (candidate: { variants: string[] }) => candidate.variants.includes(base),
      );

      expect(group).toBeDefined();
      expect(group.leadCount).toBe(2);
      // The evidence the reviewer judges the grouping by.
      expect(group.variants).toContain(`${base} Pvt Ltd`);
    });

    it('attaches selected leads WITHOUT overwriting their company text', async () => {
      /*
       * The free text is the evidence. The account is a grouping key placed
       * beside it, exactly as productId sits beside productInterest.
       */
      const companyName = `Preserve ${unique()}`;
      const account = await createAccount(ctx.orgA.owner.accessToken);
      const lead = await createLead(ctx.orgA.owner.accessToken, { companyName });

      const response = await ctx
        .http()
        .post('/api/v1/accounts/mapping/assign')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ accountId: account.id, leadIds: [lead.id] });

      expect(response.status).toBe(201);
      expect(response.body.data.leadsUpdated).toBe(1);

      const after = await ctx
        .http()
        .get(`/api/v1/leads/${lead.id}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(after.body.data.accountId).toBe(account.id);
      expect(after.body.data.companyName).toBe(companyName);
    });

    it('does NOT re-parent a lead that already has a customer', async () => {
      /*
       * Re-parenting is a different operation with different consequences, and
       * must not happen as a side effect of a bulk classify. The count comes
       * back lower and the difference is reported rather than smoothed over.
       */
      const first = await createAccount(ctx.orgA.owner.accessToken);
      const second = await createAccount(ctx.orgA.owner.accessToken);
      const lead = await createLead(ctx.orgA.owner.accessToken, { accountId: first.id });

      const response = await ctx
        .http()
        .post('/api/v1/accounts/mapping/assign')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ accountId: second.id, leadIds: [lead.id] });

      expect(response.status).toBe(201);
      expect(response.body.data.leadsUpdated).toBe(0);
      expect(response.body.data.requested).toBe(1);

      const after = await ctx
        .http()
        .get(`/api/v1/leads/${lead.id}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(after.body.data.accountId).toBe(first.id);
    });

    it('recognises a customer whose newly-mapped leads were already won', async () => {
      // The account has been a customer all along; the milestones were simply
      // unknown. Rebuilt from the opportunity history rather than assumed.
      const account = await createAccount(ctx.orgA.owner.accessToken);
      const lead = await createLead(ctx.orgA.owner.accessToken);
      await winLead(ctx.orgA.owner.accessToken, lead.id, 25_000);

      await ctx
        .http()
        .post('/api/v1/accounts/mapping/assign')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ accountId: account.id, leadIds: [lead.id] });

      const response = await ctx
        .http()
        .get(`/api/v1/accounts/${account.id}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.body.data.status).toBe('CUSTOMER');
      expect(response.body.data.firstWonAt).not.toBeNull();
    });
  });

  // ===========================================================================
  // Customer KPIs
  // ===========================================================================

  describe('customer KPIs', () => {
    it('reports counts and withholds rates that the sample cannot support', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/accounts/kpi/overview')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(200);

      const body = response.body.data;
      expect(body.counts).toHaveProperty('prospects');
      expect(body.counts).toHaveProperty('customers');
      expect(body.repeat).toHaveProperty('repeatRate');
      // Null or a number — never a fabricated zero.
      expect(
        body.repeat.repeatRate === null || typeof body.repeat.repeatRate === 'number',
      ).toBe(true);
    });

    it('splits product demand into prospect, existing customer and unknown', async () => {
      const product = await ctx
        .http()
        .post('/api/v1/products')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ name: `Split ${unique()}`, sku: `SP-${unique()}` });

      const productId = product.body.data.id;

      // An existing customer: won once, then enquires again.
      const customer = await createAccount(ctx.orgA.owner.accessToken);
      const firstDeal = await createLead(ctx.orgA.owner.accessToken, {
        accountId: customer.id,
        productId,
      });
      await winLead(ctx.orgA.owner.accessToken, firstDeal.id, 10_000);
      await createLead(ctx.orgA.owner.accessToken, { accountId: customer.id, productId });

      // A prospect who has never bought.
      const prospect = await createAccount(ctx.orgA.owner.accessToken);
      await createLead(ctx.orgA.owner.accessToken, { accountId: prospect.id, productId });

      // A lead nobody has classified.
      await createLead(ctx.orgA.owner.accessToken, { productId });

      const response = await ctx
        .http()
        .get('/api/v1/accounts/kpi/product-demand')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(200);

      const row = response.body.data.items.find(
        (item: { productId: string }) => item.productId === productId,
      );

      expect(row).toBeDefined();
      expect(row.existingCustomer).toBe(2);
      expect(row.prospect).toBe(1);
      // Reported separately, never folded into either side.
      expect(row.unknown).toBe(1);
      expect(row.total).toBe(4);
    });

    it('reports coverage so a partial breakdown cannot look complete', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/accounts/kpi/product-demand')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.body.data.coverage).toHaveProperty('leadsWithoutProduct');
      expect(response.body.data.coverage).toHaveProperty('leadsWithoutAccount');
    });

    it('ranks top customers by won value and marks repeat buyers', async () => {
      const account = await createAccount(ctx.orgA.owner.accessToken);

      for (const value of [40_000, 60_000]) {
        const lead = await createLead(ctx.orgA.owner.accessToken, { accountId: account.id });
        await winLead(ctx.orgA.owner.accessToken, lead.id, value);
      }

      const response = await ctx
        .http()
        .get('/api/v1/accounts/kpi/top-customers')
        .set(auth(ctx.orgA.owner.accessToken));

      const row = response.body.data.items.find(
        (item: { accountId: string }) => item.accountId === account.id,
      );

      expect(row).toBeDefined();
      expect(row.wonDeals).toBe(2);
      expect(row.wonValue).toBe(100000);
      expect(row.isRepeatCustomer).toBe(true);
    });
  });

  // ===========================================================================
  // Account-level follow-ups
  // ===========================================================================

  describe('customer-level follow-ups', () => {
    it('keeps existing lead follow-ups working exactly as before', async () => {
      // The nullable lead_id is a widening. Nothing that worked may break.
      //
      // The follow-up is created explicitly: nextFollowUpAt on a lead is a
      // denormalised column, not a FollowUp row.
      const lead = await createLead(ctx.orgA.owner.accessToken);

      const created = await ctx
        .http()
        .post(`/api/v1/leads/${lead.id}/follow-ups`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ scheduledAt: tomorrow(), type: 'CALL', title: 'Ring back' });

      expect(created.status).toBe(201);

      const response = await ctx
        .http()
        .get(`/api/v1/leads/${lead.id}/follow-ups`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThan(0);
      expect(response.body.data[0].leadId).toBe(lead.id);
      // Present and null, so a client can tell the two kinds apart.
      expect(response.body.data[0].accountId).toBeNull();
    });
  });
});
