import { ERROR_CODES } from '@idea001/api-types';
import { createTestContext, type TestContext } from './helpers/test-app';

/**
 * THE MANDATORY TEST (spec §29).
 *
 *   "Create Organization A. Create Organization B. Create leads in both.
 *    Ensure a user from Organization A can NEVER retrieve, modify, or access
 *    a lead belonging to Organization B."
 *
 * Phase 1 is not done until every case here passes. This suite runs in CI on
 * every commit; any new tenant-owned table must gain cases here at the same
 * time it gains endpoints.
 *
 * Note on status codes: a foreign resource returns 404, never 403. A 403 would
 * confirm the id exists and turn these endpoints into an enumeration oracle.
 */
describe('Tenant isolation (Organization A vs Organization B)', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('seeds two genuinely separate organizations', () => {
    expect(ctx.orgA.id).not.toBe(ctx.orgB.id);
    expect(ctx.orgA.leadId).not.toBe(ctx.orgB.leadId);
    expect(ctx.orgA.owner.accessToken).toBeTruthy();
    expect(ctx.orgB.owner.accessToken).toBeTruthy();
  });

  // ---------------------------------------------------------------------------
  // READ
  // ---------------------------------------------------------------------------

  describe('reading another organization’s data', () => {
    it("GET /leads/{B} with A's token returns 404 LEAD_NOT_FOUND", async () => {
      const response = await ctx
        .http()
        .get(`/api/v1/leads/${ctx.orgB.leadId}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe(ERROR_CODES.LEAD_NOT_FOUND);
    });

    it('GET /leads never includes another organization’s leads', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      const ids = (response.body.data.items as { id: string }[]).map((lead) => lead.id);

      expect(ids).toContain(ctx.orgA.leadId);
      expect(ids).not.toContain(ctx.orgB.leadId);
    });

    it('GET /leads with a filter still cannot reach across the tenant boundary', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/leads')
        .query({ status: 'NEW', limit: 100 })
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      const ids = (response.body.data.items as { id: string }[]).map((lead) => lead.id);
      expect(ids).not.toContain(ctx.orgB.leadId);
    });

    it('GET /users lists only members of the caller’s organization', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/users')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      const ids = (response.body.data as { id: string }[]).map((user) => user.id);

      expect(ids).toEqual(expect.arrayContaining([ctx.orgA.owner.id, ctx.orgA.rep.id]));
      expect(ids).not.toContain(ctx.orgB.owner.id);
      expect(ids).not.toContain(ctx.orgB.rep.id);
    });

    it("GET /users/{B-user} with A's token returns 404", async () => {
      const response = await ctx
        .http()
        .get(`/api/v1/users/${ctx.orgB.rep.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(404);

      expect(response.body.error.code).toBe(ERROR_CODES.USER_NOT_FOUND);
    });

    it('GET /organizations/current returns the caller’s own organization only', async () => {
      const [a, b] = await Promise.all([
        ctx.http().get('/api/v1/organizations/current').set(auth(ctx.orgA.owner.accessToken)),
        ctx.http().get('/api/v1/organizations/current').set(auth(ctx.orgB.owner.accessToken)),
      ]);

      expect(a.body.data.id).toBe(ctx.orgA.id);
      expect(b.body.data.id).toBe(ctx.orgB.id);
      expect(a.body.data.id).not.toBe(b.body.data.id);
    });

    it('GET /auth/me reports the correct organization for each tenant', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/auth/me')
        .set(auth(ctx.orgB.rep.accessToken))
        .expect(200);

      expect(response.body.data.organization.id).toBe(ctx.orgB.id);
      expect(response.body.data.role).toBe('SALES_REP');
    });
  });

  // ---------------------------------------------------------------------------
  // WRITE
  // ---------------------------------------------------------------------------

  describe('modifying another organization’s data', () => {
    it("PATCH /users/{B-user} with A's owner token returns 404 and changes nothing", async () => {
      await ctx
        .http()
        .patch(`/api/v1/users/${ctx.orgB.rep.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ fullName: 'Tampered By Org A' })
        .expect(404);

      // Confirm from B's own side that nothing changed. This is the assertion
      // that would have caught a global `user.update` bypassing the membership
      // check.
      const check = await ctx
        .http()
        .get(`/api/v1/users/${ctx.orgB.rep.id}`)
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(200);

      expect(check.body.data.fullName).not.toBe('Tampered By Org A');
    });

    it("PATCH /users/{B-user} role escalation with A's token returns 404", async () => {
      await ctx
        .http()
        .patch(`/api/v1/users/${ctx.orgB.rep.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ role: 'OWNER' })
        .expect(404);

      const check = await ctx
        .http()
        .get(`/api/v1/users/${ctx.orgB.rep.id}`)
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(200);

      expect(check.body.data.role).toBe('SALES_REP');
    });

    it('PATCH /organizations/current cannot touch the other organization', async () => {
      await ctx
        .http()
        .patch('/api/v1/organizations/current')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ name: 'Renamed By A' })
        .expect(200);

      const b = await ctx
        .http()
        .get('/api/v1/organizations/current')
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(200);

      expect(b.body.data.name).toBe('ABC Foods');
    });
  });

  // ---------------------------------------------------------------------------
  // INJECTION
  // ---------------------------------------------------------------------------

  describe('client-supplied tenant identifiers', () => {
    it('ignores an injected organizationId in a request body', async () => {
      // The interceptor strips the field, so this succeeds and applies to the
      // CALLER's organization. The attempt must not be honoured, and must not
      // error in a way that reveals whether the target org exists.
      await ctx
        .http()
        .patch('/api/v1/organizations/current')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ organizationId: ctx.orgB.id, name: 'Injection Attempt' })
        .expect(200);

      const b = await ctx
        .http()
        .get('/api/v1/organizations/current')
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(200);

      expect(b.body.data.name).toBe('ABC Foods');

      const a = await ctx
        .http()
        .get('/api/v1/organizations/current')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect(a.body.data.name).toBe('Injection Attempt');
      expect(a.body.data.id).toBe(ctx.orgA.id);
    });

    it('ignores an injected organizationId in a query string', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/leads')
        .query({ organizationId: ctx.orgB.id })
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      const ids = (response.body.data.items as { id: string }[]).map((lead) => lead.id);
      expect(ids).not.toContain(ctx.orgB.leadId);
    });
  });

  // ---------------------------------------------------------------------------
  // AUTHORIZATION (spec §5 — enforced in the backend, not the UI)
  // ---------------------------------------------------------------------------

  describe('role enforcement', () => {
    it('SALES_REP cannot invite users', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/users/invite')
        .set(auth(ctx.orgA.rep.accessToken))
        .send({ email: 'newbie@example.test', fullName: 'New Bie', role: 'SALES_REP' })
        .expect(403);

      expect(response.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });

    it('SALES_REP cannot update the organization', async () => {
      await ctx
        .http()
        .patch('/api/v1/organizations/current')
        .set(auth(ctx.orgA.rep.accessToken))
        .send({ name: 'Rep Rename' })
        .expect(403);
    });

    it('OWNER can invite users', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/users/invite')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          email: `invited.${Date.now()}@example.test`,
          fullName: 'Invited Person',
          role: 'SALES_REP',
        })
        .expect(201);

      expect(response.body.data.userId).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------------
  // UNAUTHENTICATED
  // ---------------------------------------------------------------------------

  describe('unauthenticated access', () => {
    it.each([
      ['get', '/api/v1/leads'],
      ['get', '/api/v1/users'],
      ['get', '/api/v1/auth/me'],
      ['get', '/api/v1/organizations/current'],
    ])('%s %s requires a token', async (method, path) => {
      await ctx.http()[method as 'get'](path).expect(401);
    });

    it('rejects a malformed token', async () => {
      await ctx
        .http()
        .get('/api/v1/leads')
        .set({ Authorization: 'Bearer not-a-real-token' })
        .expect(401);
    });

    it("rejects org A's token signed with the wrong secret", async () => {
      const tampered = `${ctx.orgA.owner.accessToken.slice(0, -6)}AAAAAA`;
      await ctx.http().get('/api/v1/leads').set(auth(tampered)).expect(401);
    });
  });
});
