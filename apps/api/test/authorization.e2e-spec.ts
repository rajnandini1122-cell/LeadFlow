import { ERROR_CODES } from '@leadflow/api-types';
import { createTestContext, type TestContext } from './helpers/test-app';

/**
 * Authorization boundaries beyond tenant isolation.
 *
 * Tenant isolation answers "can org A reach org B's data?". These tests answer
 * the harder question: within ONE organization, can a user reach data or
 * perform actions their role does not permit?
 */
describe('Authorization boundaries', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const uniqueMobile = (): string =>
    `9${String(Math.floor(100000000 + Math.random() * 899999999))}`;
  const tomorrow = (): string => new Date(Date.now() + 86_400_000).toISOString();

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ---------------------------------------------------------------------------
  // Lead visibility: LEAD_VIEW_OWN vs LEAD_VIEW_TEAM / ALL
  // ---------------------------------------------------------------------------

  describe('lead visibility by role', () => {
    it('a SALES_REP sees only leads assigned to them', async () => {
      // Owner creates one lead for the rep and one for themselves.
      const repLead = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          firstName: 'RepOwned',
          mobile: uniqueMobile(),
          nextFollowUpAt: tomorrow(),
          assignedToId: ctx.orgA.rep.id,
        })
        .expect(201);

      const ownerLead = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          firstName: 'OwnerOwned',
          mobile: uniqueMobile(),
          nextFollowUpAt: tomorrow(),
          assignedToId: ctx.orgA.owner.id,
        })
        .expect(201);

      const asRep = await ctx
        .http()
        .get('/api/v1/leads')
        .query({ limit: 100 })
        .set(auth(ctx.orgA.rep.accessToken))
        .expect(200);

      const ids = (asRep.body.data.items as { id: string }[]).map((lead) => lead.id);

      expect(ids).toContain(repLead.body.data.id);
      // The rep has LEAD_VIEW_OWN only. Someone else's lead is not theirs to see.
      expect(ids).not.toContain(ownerLead.body.data.id);
    });

    it('a SALES_REP gets 404 opening a colleague’s lead directly', async () => {
      const ownerLead = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          firstName: 'NotYours',
          mobile: uniqueMobile(),
          nextFollowUpAt: tomorrow(),
          assignedToId: ctx.orgA.owner.id,
        })
        .expect(201);

      // Filtering the list but leaving the detail endpoint open would make the
      // restriction cosmetic.
      const response = await ctx
        .http()
        .get(`/api/v1/leads/${ownerLead.body.data.id}`)
        .set(auth(ctx.orgA.rep.accessToken))
        .expect(404);

      expect(response.body.error.code).toBe(ERROR_CODES.LEAD_NOT_FOUND);
    });

    it('an OWNER sees every lead in the organization', async () => {
      const repLead = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          firstName: 'VisibleToOwner',
          mobile: uniqueMobile(),
          nextFollowUpAt: tomorrow(),
          assignedToId: ctx.orgA.rep.id,
        })
        .expect(201);

      const asOwner = await ctx
        .http()
        .get('/api/v1/leads')
        .query({ limit: 100 })
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      const ids = (asOwner.body.data.items as { id: string }[]).map((lead) => lead.id);
      expect(ids).toContain(repLead.body.data.id);
    });

    it('a SALES_REP sees a lead they created and own', async () => {
      const own = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.rep.accessToken))
        .send({
          firstName: 'SelfCreated',
          mobile: uniqueMobile(),
          nextFollowUpAt: tomorrow(),
          assignedToId: ctx.orgA.rep.id,
        })
        .expect(201);

      await ctx
        .http()
        .get(`/api/v1/leads/${own.body.data.id}`)
        .set(auth(ctx.orgA.rep.accessToken))
        .expect(200);
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-organization assignment
  // ---------------------------------------------------------------------------

  describe('lead assignment validation', () => {
    it('refuses to assign a lead to a user from ANOTHER organization', async () => {
      // `leads.assigned_to` references the GLOBAL users table, so nothing in the
      // schema stops this. Without an explicit membership check, org B's user
      // would appear as the owner of an org A lead.
      const response = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          firstName: 'ForeignAssignee',
          mobile: uniqueMobile(),
          nextFollowUpAt: tomorrow(),
          assignedToId: ctx.orgB.rep.id,
        })
        .expect(400);

      expect(response.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    });

    it('refuses to assign a lead to a user id that does not exist', async () => {
      await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          firstName: 'GhostAssignee',
          mobile: uniqueMobile(),
          nextFollowUpAt: tomorrow(),
          assignedToId: '01a01d8b-0000-7000-8000-000000009999',
        })
        .expect(400);
    });

    it('assignable-users lists only members of the caller’s organization', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/leads/assignable-users')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      const ids = (response.body.data as { id: string }[]).map((user) => user.id);

      expect(ids).toContain(ctx.orgA.owner.id);
      expect(ids).not.toContain(ctx.orgB.owner.id);
      expect(ids).not.toContain(ctx.orgB.rep.id);
    });
  });

  // ---------------------------------------------------------------------------
  // Role hierarchy and owner protection
  // ---------------------------------------------------------------------------

  describe('role hierarchy and owner protection', () => {
    /**
     * Promotes org A's rep to ADMIN so the checks below exercise a REAL
     * privilege boundary. Testing an owner acting on themselves would pass on
     * the self-action guards alone and prove nothing about owner protection.
     */
    beforeAll(async () => {
      await ctx
        .http()
        .patch(`/api/v1/users/${ctx.orgA.rep.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ role: 'ADMIN' })
        .expect(200);

      // The guard reads the LIVE membership, so the existing token now carries
      // ADMIN without re-authenticating. That is the design working.
      ctx.redis.flush();
    });

    it('an ADMIN cannot demote the only OWNER', async () => {
      const response = await ctx
        .http()
        .patch(`/api/v1/users/${ctx.orgA.owner.id}`)
        .set(auth(ctx.orgA.rep.accessToken))
        .send({ role: 'MANAGER' })
        .expect(403);

      expect(response.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });

    it('an ADMIN cannot suspend the only OWNER', async () => {
      await ctx
        .http()
        .patch(`/api/v1/users/${ctx.orgA.owner.id}`)
        .set(auth(ctx.orgA.rep.accessToken))
        .send({ status: 'SUSPENDED' })
        .expect(403);
    });

    it('an ADMIN cannot promote anyone to OWNER', async () => {
      // Otherwise an admin could grant themselves ownership and take over.
      const response = await ctx
        .http()
        .patch(`/api/v1/users/${ctx.orgA.rep.id}`)
        .set(auth(ctx.orgA.rep.accessToken))
        .send({ role: 'OWNER' })
        .expect(403);

      expect(response.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });

    it('the OWNER themselves cannot self-demote while they are the last one', async () => {
      await ctx
        .http()
        .patch(`/api/v1/users/${ctx.orgB.owner.id}`)
        .set(auth(ctx.orgB.owner.accessToken))
        .send({ role: 'MANAGER' })
        .expect(403);
    });

    it('an ADMIN may still update an ordinary profile field', async () => {
      // The restrictions above must not accidentally block routine admin work.
      await ctx
        .http()
        .patch(`/api/v1/users/${ctx.orgA.rep.id}`)
        .set(auth(ctx.orgA.rep.accessToken))
        .send({ fullName: 'Renamed By Admin' })
        .expect(200);
    });
  });
});
