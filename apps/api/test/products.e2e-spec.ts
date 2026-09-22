import { createTestContext, type TestContext } from './helpers/test-app';
import { fixtureMobile } from './helpers/phone-fixtures';

/**
 * Product master and product KPIs.
 *
 * Two groups carry the weight.
 *
 * The TENANT cases: a product id is what a lead references and what every KPI
 * groups by, so a leak here is not just "Org A saw a name" — it would let Org
 * A attach Org B's product to their own lead, and Org B's numbers would then
 * silently include leads they cannot see. Nothing would look wrong until the
 * figures were compared with reality.
 *
 * The KPI cases: these numbers get quoted in meetings. A win rate that counts
 * open leads, or a "0%" for a product nothing has closed on yet, is a
 * confident wrong answer — worse than a missing one.
 */
describe('Products', () => {
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

  async function createProduct(
    token: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; sku: string; name: string }> {
    const response = await ctx
      .http()
      .post('/api/v1/products')
      .set(auth(token))
      .send({
        name: `Product ${unique()}`,
        sku: `SKU-${unique()}`,
        category: 'Powders',
        ...overrides,
      });

    expect(response.status).toBe(201);
    return response.body.data;
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

  // ===========================================================================
  // Catalogue
  // ===========================================================================

  describe('the catalogue', () => {
    it('creates a product', async () => {
      const product = await createProduct(ctx.orgA.owner.accessToken, {
        name: 'White Onion Powder',
        sku: `WOP-${unique()}`,
      });

      expect(product.name).toBe('White Onion Powder');
    });

    it('uppercases the SKU so two casings cannot both exist', async () => {
      const sku = `lower-${unique()}`;
      const product = await createProduct(ctx.orgA.owner.accessToken, { sku });

      expect(product.sku).toBe(sku.toUpperCase());
    });

    it('refuses a duplicate SKU within the organization', async () => {
      const sku = `DUP-${unique()}`;
      await createProduct(ctx.orgA.owner.accessToken, { sku });

      const second = await ctx
        .http()
        .post('/api/v1/products')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ name: 'Another product', sku });

      expect(second.status).toBe(409);
      expect(second.body.error.message).toMatch(/already exists/i);
    });

    it('ALLOWS the same SKU in a different organization', async () => {
      // SKUs are the tenant's own codes. Two customers using "SKU-1" is
      // normal, and a global unique index would make one of them fail for a
      // reason they could never diagnose.
      const sku = `SHARED-${unique()}`;
      await createProduct(ctx.orgA.owner.accessToken, { sku });

      const other = await ctx
        .http()
        .post('/api/v1/products')
        .set(auth(ctx.orgB.owner.accessToken))
        .send({ name: 'Their product', sku });

      expect(other.status).toBe(201);
    });

    it('renames without moving any historical figure', async () => {
      /*
       * The reason this is a table and not a string on the lead. Leads
       * reference the id, so a rename cannot reassign anybody's history.
       */
      const product = await createProduct(ctx.orgA.owner.accessToken);
      await createLead(ctx.orgA.owner.accessToken, { productId: product.id });

      const renamed = await ctx
        .http()
        .patch(`/api/v1/products/${product.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ name: 'Renamed Product' });

      expect(renamed.status).toBe(200);

      const kpi = await ctx
        .http()
        .get('/api/v1/products/kpi/performance')
        .set(auth(ctx.orgA.owner.accessToken));

      const row = kpi.body.data.items.find(
        (item: { productId: string }) => item.productId === product.id,
      );
      expect(row.name).toBe('Renamed Product');
      expect(row.totalLeads).toBe(1);
    });

    it('filters by active state', async () => {
      const product = await createProduct(ctx.orgA.owner.accessToken, { active: false });

      const inactive = await ctx
        .http()
        .get('/api/v1/products?active=false&limit=200')
        .set(auth(ctx.orgA.owner.accessToken));

      const ids = inactive.body.data.items.map((item: { id: string }) => item.id);
      expect(ids).toContain(product.id);
    });
  });

  // ===========================================================================
  // Retiring
  // ===========================================================================

  describe('retiring a product', () => {
    it('DELETES one that was never used', async () => {
      // A catalogue mistake, with no history to protect.
      const product = await createProduct(ctx.orgA.owner.accessToken);

      const response = await ctx
        .http()
        .delete(`/api/v1/products/${product.id}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.body.data).toMatchObject({ deleted: true, deactivated: false });

      const after = await ctx
        .http()
        .get(`/api/v1/products/${product.id}`)
        .set(auth(ctx.orgA.owner.accessToken));
      expect(after.status).toBe(404);
    });

    it('DEACTIVATES one with leads, and keeps it in reporting', async () => {
      /*
       * The important half. Retiring something you no longer sell must not
       * remove it from last quarter's numbers.
       */
      const product = await createProduct(ctx.orgA.owner.accessToken);
      await createLead(ctx.orgA.owner.accessToken, { productId: product.id });

      const response = await ctx
        .http()
        .delete(`/api/v1/products/${product.id}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.body.data).toMatchObject({ deleted: false, deactivated: true });

      const kpi = await ctx
        .http()
        .get('/api/v1/products/kpi/performance')
        .set(auth(ctx.orgA.owner.accessToken));

      const row = kpi.body.data.items.find(
        (item: { productId: string }) => item.productId === product.id,
      );
      expect(row).toBeDefined();
      expect(row.totalLeads).toBe(1);
      expect(row.active).toBe(false);
    });
  });

  // ===========================================================================
  // The lead relationship
  // ===========================================================================

  describe('assigning a product to a lead', () => {
    it('keeps the free-text enquiry alongside it', async () => {
      /*
       * The whole point of having both. "White Onion Powder" is the grouping
       * key; "500 kg monthly, food manufacturing use" is what was actually
       * asked for, and no catalogue can carry it.
       */
      const product = await createProduct(ctx.orgA.owner.accessToken);
      const lead = await createLead(ctx.orgA.owner.accessToken, {
        productId: product.id,
        productInterest: '500 kg monthly, food manufacturing use',
      });

      const detail = await ctx
        .http()
        .get(`/api/v1/leads/${lead.id}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(detail.body.data.productInterest).toBe('500 kg monthly, food manufacturing use');
    });

    it('accepts a lead with no product at all', async () => {
      // Permanently optional: an enquiry can be for something not catalogued.
      const lead = await createLead(ctx.orgA.owner.accessToken, {
        productInterest: 'Something we do not stock',
      });

      expect(lead.id).toBeTruthy();
    });

    it('refuses a product id that does not exist', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          firstName: 'Test',
          mobile: '4155551234',
          nextFollowUpAt: tomorrow(),
          productId: '01a029bb-0000-7000-8000-000000000000',
        });

      expect(response.status).toBe(400);
    });
  });

  // ===========================================================================
  // Tenant isolation
  // ===========================================================================

  describe('tenant isolation', () => {
    it('never lists another organization’s products', async () => {
      const mine = await createProduct(ctx.orgA.owner.accessToken);

      const theirs = await ctx
        .http()
        .get('/api/v1/products?limit=200')
        .set(auth(ctx.orgB.owner.accessToken));

      const ids = theirs.body.data.items.map((item: { id: string }) => item.id);
      expect(ids).not.toContain(mine.id);
    });

    it('never reads another organization’s product by id', async () => {
      const mine = await createProduct(ctx.orgA.owner.accessToken);

      const response = await ctx
        .http()
        .get(`/api/v1/products/${mine.id}`)
        .set(auth(ctx.orgB.owner.accessToken));

      // 404, not 403: confirming the id exists would be an enumeration oracle.
      expect(response.status).toBe(404);
    });

    it('never updates another organization’s product', async () => {
      const mine = await createProduct(ctx.orgA.owner.accessToken, { name: 'Mine' });

      const response = await ctx
        .http()
        .patch(`/api/v1/products/${mine.id}`)
        .set(auth(ctx.orgB.owner.accessToken))
        .send({ name: 'Hijacked' });

      expect(response.status).toBe(404);

      const still = await ctx
        .http()
        .get(`/api/v1/products/${mine.id}`)
        .set(auth(ctx.orgA.owner.accessToken));
      expect(still.body.data.name).toBe('Mine');
    });

    it('never deactivates another organization’s product', async () => {
      const mine = await createProduct(ctx.orgA.owner.accessToken);

      const response = await ctx
        .http()
        .delete(`/api/v1/products/${mine.id}`)
        .set(auth(ctx.orgB.owner.accessToken));

      expect(response.status).toBe(404);
    });

    it('never ATTACHES another organization’s product to a lead', async () => {
      /*
       * The case this file exists for.
       *
       * The tenant extension scopes queries; a foreign key does not. Without
       * an explicit check the insert would succeed, the FK would be satisfied,
       * and Org A's product would start accumulating Org B's leads in its
       * KPIs — invisible until somebody compared the numbers with reality.
       */
      const mine = await createProduct(ctx.orgA.owner.accessToken);

      const response = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgB.owner.accessToken))
        .send({
          firstName: 'Cross',
          lastName: 'Tenant',
          mobile: '4155559999',
          nextFollowUpAt: tomorrow(),
          productId: mine.id,
        });

      expect(response.status).toBe(400);
    });

    it('never attaches one through an UPDATE either', async () => {
      const mine = await createProduct(ctx.orgA.owner.accessToken);
      const theirLead = await createLead(ctx.orgB.owner.accessToken);

      const response = await ctx
        .http()
        .patch(`/api/v1/leads/${theirLead.id}`)
        .set(auth(ctx.orgB.owner.accessToken))
        .send({ productId: mine.id });

      expect(response.status).toBe(400);
    });

    it('never maps another organization’s leads', async () => {
      const mine = await createProduct(ctx.orgA.owner.accessToken);
      const theirLead = await createLead(ctx.orgB.owner.accessToken);

      const response = await ctx
        .http()
        .post('/api/v1/products/mapping/assign')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ productId: mine.id, leadIds: [theirLead.id] });

      // The product is ours, the lead is not: nothing matches the scoped
      // update, so nothing moves.
      expect(response.body.data.updated).toBe(0);
    });

    it('keeps KPI figures inside the organization', async () => {
      const mine = await createProduct(ctx.orgA.owner.accessToken);
      await createLead(ctx.orgA.owner.accessToken, { productId: mine.id });

      const theirs = await ctx
        .http()
        .get('/api/v1/products/kpi/performance')
        .set(auth(ctx.orgB.owner.accessToken));

      const ids = theirs.body.data.items.map((item: { productId: string }) => item.productId);
      expect(ids).not.toContain(mine.id);
    });
  });

  // ===========================================================================
  // Authorization
  // ===========================================================================

  describe('who may do what', () => {
    it('lets a sales rep READ the catalogue, because lead creation needs it', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/products')
        .set(auth(ctx.orgA.rep.accessToken));

      expect(response.status).toBe(200);
    });

    it('refuses a sales rep the ability to create products', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/products')
        .set(auth(ctx.orgA.rep.accessToken))
        .send({ name: 'Unauthorised', sku: `X-${unique()}` });

      expect(response.status).toBe(403);
    });

    it('refuses a sales rep the mapping tool', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/products/mapping/unmapped')
        .set(auth(ctx.orgA.rep.accessToken));

      expect(response.status).toBe(403);
    });

    it('requires a session', async () => {
      const response = await ctx.http().get('/api/v1/products');
      expect(response.status).toBe(401);
    });
  });

  // ===========================================================================
  // KPIs
  // ===========================================================================

  describe('KPIs', () => {
    it('counts a new lead against its product', async () => {
      const product = await createProduct(ctx.orgA.owner.accessToken);
      await createLead(ctx.orgA.owner.accessToken, {
        productId: product.id,
        estimatedValue: 50000,
      });

      const kpi = await ctx
        .http()
        .get('/api/v1/products/kpi/performance')
        .set(auth(ctx.orgA.owner.accessToken));

      const row = kpi.body.data.items.find(
        (item: { productId: string }) => item.productId === product.id,
      );

      expect(row.totalLeads).toBe(1);
      expect(row.openLeads).toBe(1);
      expect(Number(row.openPipeline)).toBe(50000);
    });

    it('withholds a win rate until something has closed', async () => {
      /*
       * NOT zero. "Nothing has finished yet" and "we won none of them" are
       * different facts, and 0% makes a healthy new product look failed.
       */
      const product = await createProduct(ctx.orgA.owner.accessToken);
      await createLead(ctx.orgA.owner.accessToken, { productId: product.id });

      const kpi = await ctx
        .http()
        .get('/api/v1/products/kpi/performance')
        .set(auth(ctx.orgA.owner.accessToken));

      const row = kpi.body.data.items.find(
        (item: { productId: string }) => item.productId === product.id,
      );

      expect(row.winRate).toBeNull();
      expect(row.averageWonValue).toBeNull();
      expect(row.averageDaysToClose).toBeNull();
    });

    it('publishes how many leads have NO product', async () => {
      // Every figure covers only leads that have one. Without this number a
      // dashboard built on a fraction of the data looks like it covers all.
      const kpi = await ctx
        .http()
        .get('/api/v1/products/kpi/performance')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(kpi.body.data.totals).toHaveProperty('leadsWithoutProduct');
      expect(typeof kpi.body.data.totals.leadsWithoutProduct).toBe('number');
    });

    it('breaks demand down by source', async () => {
      const product = await createProduct(ctx.orgA.owner.accessToken);
      await createLead(ctx.orgA.owner.accessToken, {
        productId: product.id,
        source: 'WhatsApp',
      });

      const response = await ctx
        .http()
        .get('/api/v1/products/kpi/by-source')
        .set(auth(ctx.orgA.owner.accessToken));

      const row = response.body.data.items.find(
        (item: { productId: string }) => item.productId === product.id,
      );
      expect(row.counts.WhatsApp).toBe(1);
    });

    it('breaks demand down by salesperson', async () => {
      const product = await createProduct(ctx.orgA.owner.accessToken);
      await createLead(ctx.orgA.owner.accessToken, {
        productId: product.id,
        assignedToId: ctx.orgA.rep.id,
      });

      const response = await ctx
        .http()
        .get('/api/v1/products/kpi/by-agent')
        .set(auth(ctx.orgA.owner.accessToken));

      const row = response.body.data.items.find(
        (item: { productId: string; agentId: string | null }) =>
          item.productId === product.id && item.agentId === ctx.orgA.rep.id,
      );
      expect(row.leads).toBe(1);
    });

    it('refuses a sales rep the KPI endpoints', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/products/kpi/performance')
        .set(auth(ctx.orgA.rep.accessToken));

      expect(response.status).toBe(403);
    });

    it('validates a bad date range rather than guessing', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/products/kpi/trend?preset=not_a_range')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(400);
    });

    it('accepts the rolling windows a trend needs', async () => {
      for (const preset of ['last_7_days', 'last_30_days', 'last_90_days']) {
        const response = await ctx
          .http()
          .get(`/api/v1/products/kpi/trend?preset=${preset}`)
          .set(auth(ctx.orgA.owner.accessToken));

        expect(response.status).toBe(200);
      }
    });
  });

  // ===========================================================================
  // Backfill
  // ===========================================================================

  describe('mapping historical leads', () => {
    it('reports how much is still unmapped', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/products/mapping/progress')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.body.data).toHaveProperty('unmapped');
      expect(response.body.data).toHaveProperty('mapped');
    });

    it('attaches a product to chosen leads and KEEPS their free text', async () => {
      const product = await createProduct(ctx.orgA.owner.accessToken);
      const lead = await createLead(ctx.orgA.owner.accessToken, {
        productInterest: 'White onion powder 25kg requirement',
      });

      const mapped = await ctx
        .http()
        .post('/api/v1/products/mapping/assign')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ productId: product.id, leadIds: [lead.id] });

      expect(mapped.body.data.updated).toBe(1);

      const detail = await ctx
        .http()
        .get(`/api/v1/leads/${lead.id}`)
        .set(auth(ctx.orgA.owner.accessToken));

      // The evidence of what was actually asked for survives the mapping.
      expect(detail.body.data.productInterest).toBe('White onion powder 25kg requirement');
    });

    it('suggests, but never applies, a match', async () => {
      /*
       * A substring match would file "onion storage crates" under White Onion
       * Powder. A wrong mapping is worse than an absent one: it produces a
       * confident KPI that is quietly false.
       */
      const product = await createProduct(ctx.orgA.owner.accessToken, {
        name: 'Garlic Powder',
        sku: `GP-${unique()}`,
      });
      const lead = await createLead(ctx.orgA.owner.accessToken, {
        productInterest: 'Bulk Garlic Powder for export',
      });

      const suggestions = await ctx
        .http()
        .get(`/api/v1/products/mapping/suggestions/${lead.id}`)
        .set(auth(ctx.orgA.owner.accessToken));

      const ids = suggestions.body.data.suggestions.map((s: { id: string }) => s.id);
      expect(ids).toContain(product.id);

      // Suggested only — the lead is untouched until somebody confirms.
      const detail = await ctx
        .http()
        .get(`/api/v1/leads/${lead.id}`)
        .set(auth(ctx.orgA.owner.accessToken));
      expect(detail.body.data.productId ?? null).toBeNull();
    });

    it('refuses an empty mapping request', async () => {
      const product = await createProduct(ctx.orgA.owner.accessToken);

      const response = await ctx
        .http()
        .post('/api/v1/products/mapping/assign')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ productId: product.id, leadIds: [] });

      expect(response.status).toBe(400);
    });
  });
});
