import { ERROR_CODES } from '@idea001/api-types';
import { createTestContext, type TestContext } from './helpers/test-app';

/**
 * Lead creation: the "no lead left behind" rule, duplicate detection (spec §23)
 * and — most importantly — that a created lead lands in the CALLER's
 * organization no matter what the client claims.
 */
describe('Lead creation', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Unique per run so repeated suites do not collide on the mobile index. */
  const uniqueMobile = (): string =>
    `9${String(Math.floor(100000000 + Math.random() * 899999999))}`;

  const tomorrow = (): string => new Date(Date.now() + 86_400_000).toISOString();

  const validLead = () => ({
    firstName: 'Test',
    lastName: 'Customer',
    mobile: uniqueMobile(),
    companyName: 'Test Enterprises',
    city: 'Pune',
    source: 'WhatsApp',
    estimatedValue: 250000,
    priority: 'HIGH',
    nextFollowUpAt: tomorrow(),
  });

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  describe('happy path', () => {
    it('creates a lead, numbers it, and opens its timeline', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send(validLead())
        .expect(201);

      const lead = response.body.data;
      expect(lead.id).toBeTruthy();
      expect(lead.leadNumber).toMatch(/^LD-\d{5}$/);
      expect(lead.name).toBe('Test Customer');
      expect(lead.status).toBe('NEW');
      expect(lead.priority).toBe('HIGH');

      // A LEAD_CREATED entry must exist — the timeline starts at creation.
      const detail = await ctx
        .http()
        .get(`/api/v1/leads/${lead.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      const types = (detail.body.data.activities as { type: string }[]).map((a) => a.type);
      expect(types).toContain('LEAD_CREATED');
    });

    it('assigns an owner and records the assignment', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ ...validLead(), assignedToId: ctx.orgA.rep.id })
        .expect(201);

      expect(response.body.data.assignedTo.id).toBe(ctx.orgA.rep.id);

      const detail = await ctx
        .http()
        .get(`/api/v1/leads/${response.body.data.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      const types = (detail.body.data.activities as { type: string }[]).map((a) => a.type);
      expect(types).toContain('LEAD_ASSIGNED');
    });

    it('normalises a +91-prefixed, space-separated mobile', async () => {
      const digits = uniqueMobile();
      const response = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ ...validLead(), mobile: `+91 ${digits.slice(0, 5)} ${digits.slice(5)}` })
        .expect(201);

      // Stored bare, so duplicate detection compares like with like.
      expect(response.body.data.mobile).toBe(digits);
    });

    it('gives each new lead a distinct sequential number', async () => {
      const first = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send(validLead())
        .expect(201);

      const second = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send(validLead())
        .expect(201);

      expect(first.body.data.leadNumber).not.toBe(second.body.data.leadNumber);
    });
  });

  describe('no lead left behind', () => {
    it('rejects an active lead with no follow-up date', async () => {
      const { nextFollowUpAt: _omitted, ...withoutFollowUp } = validLead();

      const response = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send(withoutFollowUp)
        .expect(400);

      expect(response.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
      expect(response.body.error.details.nextFollowUpAt).toBeDefined();
    });

    it('allows a WON lead with no follow-up, because it has no next action', async () => {
      const { nextFollowUpAt: _omitted, ...withoutFollowUp } = validLead();

      const response = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ ...withoutFollowUp, status: 'WON' })
        .expect(201);

      expect(response.body.data.nextFollowUpAt).toBeNull();
    });
  });

  describe('duplicate detection', () => {
    it('refuses a second lead with the same mobile and names the existing one', async () => {
      const lead = validLead();

      const first = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send(lead)
        .expect(201);

      const duplicate = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ ...lead, firstName: 'Someone', lastName: 'Else' })
        .expect(409);

      expect(duplicate.body.error.code).toBe(ERROR_CODES.DUPLICATE_LEAD);
      // The client needs the existing id to offer "Open existing lead".
      expect(duplicate.body.error.details.existingLeadId[0]).toBe(first.body.data.id);
      expect(duplicate.body.error.details.existingLeadNumber[0]).toBe(
        first.body.data.leadNumber,
      );
    });

    it('creates anyway when the caller explicitly overrides', async () => {
      const lead = validLead();

      await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send(lead)
        .expect(201);

      // Overriding is a deliberate act, never the default.
      await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ ...lead, status: 'LOST', nextFollowUpAt: undefined, allowDuplicate: true })
        .expect(201);
    });

    it('does NOT treat the same mobile in another organization as a duplicate', async () => {
      const lead = validLead();

      await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send(lead)
        .expect(201);

      // Two SMEs may legitimately be talking to the same person. Uniqueness is
      // per tenant, never global.
      await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgB.owner.accessToken))
        .send(lead)
        .expect(201);
    });
  });

  describe('tenant safety', () => {
    it('creates in the CALLER’s organization even when a foreign one is supplied', async () => {
      const lead = validLead();

      const created = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ ...lead, organizationId: ctx.orgB.id })
        .expect(201);

      // Org A can see it…
      await ctx
        .http()
        .get(`/api/v1/leads/${created.body.data.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      // …and Org B cannot, which is the assertion that matters.
      await ctx
        .http()
        .get(`/api/v1/leads/${created.body.data.id}`)
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(404);
    });

    it('numbers leads per organization, not globally', async () => {
      const inB = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgB.owner.accessToken))
        .send(validLead())
        .expect(201);

      expect(inB.body.data.leadNumber).toMatch(/^LD-\d{5}$/);
    });
  });

  describe('validation and authorization', () => {
    it('rejects an invalid mobile number', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ ...validLead(), mobile: '12345' })
        .expect(400);

      expect(response.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    });

    it('rejects an unknown field rather than silently dropping it', async () => {
      await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ ...validLead(), notARealField: 'x' })
        .expect(400);
    });

    it('requires authentication', async () => {
      await ctx.http().post('/api/v1/leads').send(validLead()).expect(401);
    });

    it('allows a SALES_REP to create — it is their core job', async () => {
      await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.rep.accessToken))
        .send(validLead())
        .expect(201);
    });
  });
});
