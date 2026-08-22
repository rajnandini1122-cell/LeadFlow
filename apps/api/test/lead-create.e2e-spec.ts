import { ERROR_CODES } from '@leadflow/api-types';
import { createTestContext, type TestContext } from './helpers/test-app';

/**
 * Lead creation: the "no lead left behind" rule, duplicate detection (spec §23)
 * and — most importantly — that a created lead lands in the CALLER's
 * organization no matter what the client claims.
 */
describe('Lead creation', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Unique per call, and valid as a US national number for the test tenants. */
  const uniqueMobile = (): string =>
    `415${String(Math.floor(1000000 + Math.random() * 8999999))}`;

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

    it('stores the mobile in E.164 regardless of how it was typed', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ ...validLead(), mobile: '+1 (415) 555-0142' })
        .expect(201);

      // Canonical form, so the same customer typed two ways is one record.
      expect(response.body.data.mobile).toBe('+14155550142');
    });

    it('applies the ORGANIZATION country to a local-format number', async () => {
      // The seeded test organizations default to US, so a bare national number
      // resolves with +1 rather than a hardcoded region.
      const response = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ ...validLead(), mobile: '4155550188' })
        .expect(201);

      expect(response.body.data.mobile).toBe('+14155550188');
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

  /*
   * A lead with no phone number.
   *
   * Instagram and Messenger hand over an opaque, provider-scoped account id
   * and nothing else — there is no number to record. Requiring one made
   * "create a lead" impossible from exactly the conversations the review queue
   * exists to triage, and forced whoever was triaging to invent a number,
   * which is worse than recording that there is not one.
   *
   * The schema always allowed this: `leads.mobile` is nullable and the
   * duplicate index is `WHERE mobile IS NOT NULL`.
   */
  describe('leads without a mobile', () => {
    const withoutMobile = () => {
      const lead = validLead() as Record<string, unknown>;
      delete lead['mobile'];
      return lead;
    };

    it('creates one', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send(withoutMobile());

      expect(response.status).toBe(201);
      expect(response.body.data.mobile).toBeNull();
    });

    it('treats an empty string as no number rather than a validation error', async () => {
      // The form sends "" when the field is left blank.
      const response = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ ...withoutMobile(), mobile: '' });

      expect(response.status).toBe(201);
      expect(response.body.data.mobile).toBeNull();
    });

    it('does NOT treat two numberless leads as duplicates of each other', async () => {
      /*
       * The mobile IS the duplicate key. Without one there is nothing to match
       * on, and matching on name or company instead would collide constantly
       * — wrongly refusing to create a lead loses a real enquiry.
       */
      const first = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ ...withoutMobile(), firstName: 'John', lastName: 'Smith' });

      const second = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ ...withoutMobile(), firstName: 'John', lastName: 'Smith' });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.data.id).not.toBe(first.body.data.id);
    });

    it('keeps two numberless leads as separate records', async () => {
      // Each gets its own contact behind the scenes. Collapsing them onto one
      // would put several unrelated customers' history in a single record.
      const first = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send(withoutMobile());

      const second = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send(withoutMobile());

      const [one, two] = await Promise.all([
        ctx.http().get(`/api/v1/leads/${first.body.data.id}`).set(auth(ctx.orgA.owner.accessToken)),
        ctx.http().get(`/api/v1/leads/${second.body.data.id}`).set(auth(ctx.orgA.owner.accessToken)),
      ]);

      expect(one.status).toBe(200);
      expect(two.status).toBe(200);
      expect(one.body.data.leadNumber).not.toBe(two.body.data.leadNumber);
      expect(one.body.data.mobile).toBeNull();
      expect(two.body.data.mobile).toBeNull();
    });

    it('still enforces the follow-up rule', async () => {
      /*
       * "No lead left behind" is untouched by this change: an active lead
       * still needs a next action, with or without a phone number. Dropping
       * the mobile requirement must not quietly relax anything else.
       */
      const lead = withoutMobile();
      delete lead['nextFollowUpAt'];

      const response = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send(lead);

      expect(response.status).toBe(400);
      expect(response.body.error.message).toMatch(/follow-up/i);
    });

    it('still rejects a mobile that is present but nonsense', async () => {
      // Optional does not mean unvalidated.
      const response = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ ...withoutMobile(), mobile: 'not-a-number' });

      expect(response.status).toBe(400);
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
