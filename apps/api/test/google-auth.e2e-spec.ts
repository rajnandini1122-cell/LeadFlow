import { createTestContext, type TestContext } from './helpers/test-app';

/**
 * Signing in with Google.
 *
 * The valuable cases are the refusals. A sign-in route that accepts a token it
 * has not properly verified is not a convenience feature — it is a way into
 * every account on the deployment, and the failure is silent.
 *
 * These run WITHOUT a GOOGLE_CLIENT_ID configured, which is itself the state
 * most deployments are in. That pins the two properties that matter when it is
 * absent: the feature reports itself unavailable, and the endpoints refuse
 * rather than falling open.
 */
describe('Google sign-in', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  describe('advertising itself', () => {
    it('reports whether Google sign-in is available', async () => {
      const response = await ctx.http().get('/api/v1/auth/providers');

      expect(response.status).toBe(200);
      expect(response.body.data.google).toHaveProperty('enabled');
    });

    it('is readable without a session', async () => {
      // The login page needs it before anybody has signed in.
      const response = await ctx.http().get('/api/v1/auth/providers');
      expect(response.status).toBe(200);
    });

    it('never exposes a client secret', async () => {
      const response = await ctx.http().get('/api/v1/auth/providers');
      const body = JSON.stringify(response.body).toLowerCase();

      // The client id is public by design; a secret has no place in this flow
      // and must never appear in a public response.
      expect(body).not.toContain('secret');
      expect(body).not.toContain('client_secret');
    });

    it('reports disabled when no client id is configured', async () => {
      // The test app runs without one, and the button is hidden on that basis.
      const response = await ctx.http().get('/api/v1/auth/providers');
      expect(response.body.data.google.enabled).toBe(false);
      expect(response.body.data.google.clientId).toBeNull();
    });
  });

  describe('what it refuses', () => {
    it('refuses a made-up token rather than trusting its contents', async () => {
      /*
       * The assertion this file exists for. A JWT is only base64 — anybody can
       * write one claiming any email. It is worthless without a signature
       * check against Google's keys, and accepting the payload unverified
       * would hand over any account by asking for it.
       */
      const forged = [
        Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
        Buffer.from(
          JSON.stringify({
            sub: '1',
            email: 'owner@northwind.example',
            email_verified: true,
            aud: 'anything',
          }),
        ).toString('base64url'),
        '',
      ].join('.');

      const response = await ctx.http().post('/api/v1/auth/google').send({ idToken: forged });

      expect([401, 409]).toContain(response.status);
      expect(response.body.success).toBe(false);
      expect(response.body.data).toBeUndefined();
    });

    it('refuses an empty token', async () => {
      const response = await ctx.http().post('/api/v1/auth/google').send({ idToken: '' });
      expect(response.body.success).toBe(false);
    });

    it('refuses a request with no token at all', async () => {
      const response = await ctx.http().post('/api/v1/auth/google').send({});
      expect(response.status).toBe(400);
    });

    it('refuses registration with a forged token', async () => {
      // Creating a tenant is the more damaging half: it would make an
      // organization owned by an address nobody proved they control.
      const response = await ctx
        .http()
        .post('/api/v1/auth/google/register')
        .send({ idToken: 'not.a.token', organizationName: 'Forged Co' });

      expect([401, 409]).toContain(response.status);
      expect(response.body.success).toBe(false);
    });

    it('requires an organization name to register', async () => {
      // The one thing Google cannot supply. Guessing it from the email domain
      // would name tenants after mail providers.
      const response = await ctx
        .http()
        .post('/api/v1/auth/google/register')
        .send({ idToken: 'not.a.token' });

      expect(response.status).toBe(400);
    });

    it('never leaks the token back in an error', async () => {
      const token = 'sensitive.looking.token';
      const response = await ctx.http().post('/api/v1/auth/google').send({ idToken: token });

      expect(JSON.stringify(response.body)).not.toContain(token);
    });
  });

  describe('what it does not change', () => {
    it('leaves password login working', async () => {
      // Adding a second way in must not disturb the first.
      const response = await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email: ctx.orgA.owner.email, password: 'CorrectHorse!2026', platform: 'WEB' });

      expect(response.status).toBe(200);
      expect(response.body.data.tokens.accessToken).toBeTruthy();
    });

    it('leaves a wrong password refused', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email: ctx.orgA.owner.email, password: 'wrong-password', platform: 'WEB' });

      expect(response.status).toBe(401);
    });
  });
});
