import { createTestContext, type TestContext } from './helpers/test-app';

/**
 * Which routes are reachable without a token.
 *
 * The guards deny by default, so a route is protected unless somebody
 * deliberately marked it `@Public()`. This suite is the check that nobody did
 * so by accident — the failure mode is silent, and the blast radius is every
 * tenant's data.
 */
describe('Public and protected routes', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  describe('deliberately public', () => {
    it.each([
      ['GET /plans — the pricing page reads it', 'get', '/api/v1/plans'],
      ['GET /health', 'get', '/health'],
      ['GET /readiness', 'get', '/readiness'],
    ])('%s', async (_label, method, path) => {
      const response = await (ctx.http() as never as Record<string, (p: string) => never>)[
        method
      ]?.(path);

      expect((response as unknown as { status: number }).status).toBeLessThan(400);
    });
  });

  describe('every CRM route stays protected', () => {
    // Anything returning tenant data. A 401 here is the whole point; a 200
    // would mean an anonymous request reading a customer's pipeline.
    const PROTECTED_GETS = [
      '/api/v1/leads',
      '/api/v1/contacts',
      '/api/v1/contacts/duplicates',
      '/api/v1/follow-ups?bucket=overdue',
      '/api/v1/dashboard',
      '/api/v1/reports/overview',
      '/api/v1/reports/daily',
      '/api/v1/reports/team',
      '/api/v1/users',
      '/api/v1/users/invitations',
      '/api/v1/organizations/current',
      '/api/v1/organizations/audit',
      '/api/v1/organizations/locale-options',
      '/api/v1/subscriptions/current',
      '/api/v1/auth/me',
      '/api/v1/auth/sessions',
    ];

    it.each(PROTECTED_GETS)('GET %s requires a token', async (path) => {
      await ctx.http().get(path).expect(401);
    });

    it.each([
      ['/api/v1/leads', { firstName: 'Anon' }],
      ['/api/v1/contacts', { firstName: 'Anon' }],
      ['/api/v1/leads/import', { csv: 'a,b\n1,2' }],
      ['/api/v1/users/invite', { email: 'x@example.test', fullName: 'X', role: 'SALES_REP' }],
      ['/api/v1/users/transfer-admin', { toUserId: '0199a000-0000-7000-8000-000000000000' }],
    ])('POST %s requires a token', async (path, body) => {
      await ctx.http().post(path).send(body).expect(401);
    });

    it.each([
      ['/api/v1/organizations/current', { name: 'Hijacked' }],
      ['/api/v1/subscriptions/current', { planCode: 'BUSINESS' }],
    ])('PATCH %s requires a token', async (path, body) => {
      await ctx.http().patch(path).send(body).expect(401);
    });

    it('a garbage token is refused, not ignored', async () => {
      await ctx
        .http()
        .get('/api/v1/leads')
        .set({ Authorization: 'Bearer not-a-real-token' })
        .expect(401);
    });
  });

  describe('the public catalogue leaks nothing', () => {
    it('returns no tenant identifiers even when tenants exist', async () => {
      // Prove there IS data to leak before asserting none of it appears.
      await ctx
        .http()
        .get('/api/v1/leads')
        .set({ Authorization: `Bearer ${ctx.orgA.owner.accessToken}` })
        .expect(200);

      const response = await ctx.http().get('/api/v1/plans').expect(200);
      const body = JSON.stringify(response.body);

      expect(body).not.toContain(ctx.orgA.id);
      expect(body).not.toContain(ctx.orgB.id);
      expect(body).not.toContain(ctx.orgA.owner.email);
      expect(body).not.toContain(ctx.orgA.leadId);
    });

    it('sends no session cookie to an anonymous caller', async () => {
      const response = await ctx.http().get('/api/v1/plans').expect(200);
      expect(response.headers['set-cookie']).toBeUndefined();
    });
  });
});
