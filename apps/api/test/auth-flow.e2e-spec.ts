import { ERROR_CODES } from '@leadflow/api-types';
import { createTestContext, PASSWORD, type TestContext } from './helpers/test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';

/**
 * Authentication lifecycle: login, refresh rotation, reuse detection, logout.
 *
 * The reuse-detection case is the important one. It is the difference between
 * a stolen refresh token granting indefinite access and granting access only
 * until the legitimate client next refreshes.
 */
describe('Authentication flow', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const refreshWith = (token: string) =>
    ctx.http().post('/api/v1/auth/refresh').send({ refreshToken: token });

  /**
   * Ages a rotation past REFRESH_REUSE_INTERVAL_MS, in the DATABASE's clock.
   *
   * Requests sent together can reach the database far apart, so a rotated
   * token presented immediately afterwards is treated as a straggler rather
   * than a leak. Reuse detection begins once that short interval has passed,
   * and this is how a test reaches that point without sleeping. The seconds
   * come from `clock_timestamp()` because that is what the rotation itself
   * wrote — mixing in this process's clock would compare two different
   * timelines.
   */
  const ageRotation = async (userId: string, secondsAgo: number): Promise<void> => {
    const tenantContext = ctx.app.get(TenantContextService);
    const prisma = ctx.app.get(PrismaService);

    await tenantContext.runAsSystem(
      'e2e fixture: age a rotation past the reuse interval',
      () =>
        prisma.client.$executeRaw`
          UPDATE "sessions"
             SET "revoked_at" = clock_timestamp() - make_interval(secs => ${secondsAgo}::double precision)
           WHERE "user_id" = ${userId}::uuid
             AND "revoked_reason" = 'ROTATED'
        ` as Promise<number>,
    );
  };

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  describe('login', () => {
    it('returns a usable access token and the user’s organization', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email: ctx.orgA.owner.email, password: PASSWORD, platform: 'ANDROID' })
        .expect(200);

      expect(response.body.data.requiresOrganizationSelection).toBe(false);
      expect(response.body.data.tokens.accessToken).toEqual(expect.any(String));
      expect(response.body.data.tokens.tokenType).toBe('Bearer');
      expect(response.body.data.user.organization.id).toBe(ctx.orgA.id);
      expect(response.body.data.user.role).toBe('OWNER');
      expect(response.body.data.user.permissions).toContain('user.invite');
    });

    it('never returns the password hash', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email: ctx.orgA.owner.email, password: PASSWORD, platform: 'ANDROID' })
        .expect(200);

      expect(JSON.stringify(response.body)).not.toContain('$argon2');
      expect(response.body.data.user.passwordHash).toBeUndefined();
    });

    it('rejects a wrong password', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email: ctx.orgA.owner.email, password: 'WrongPassword!99', platform: 'WEB' })
        .expect(401);

      expect(response.body.error.code).toBe(ERROR_CODES.INVALID_CREDENTIALS);
    });

    it('gives an unknown email the SAME response as a wrong password', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email: 'nobody@example.test', password: PASSWORD, platform: 'WEB' })
        .expect(401);

      // Identical code and message, so login cannot be used to discover which
      // email addresses have accounts.
      expect(response.body.error.code).toBe(ERROR_CODES.INVALID_CREDENTIALS);
      expect(response.body.error.message).toBe('Email or password is incorrect.');
    });

    it('rejects a malformed email before touching the database', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email: 'not-an-email', password: PASSWORD })
        .expect(400);

      expect(response.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    });
  });

  describe('refresh rotation', () => {
    it('issues a NEW refresh token and invalidates the old one', async () => {
      const login = await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email: ctx.orgB.rep.email, password: PASSWORD, platform: 'ANDROID' })
        .expect(200);

      const original = login.body.data.tokens.refreshToken as string;

      const rotated = await refreshWith(original).expect(200);
      const next = rotated.body.data.tokens.refreshToken as string;

      expect(next).toBeTruthy();
      expect(next).not.toBe(original);
      expect(rotated.body.data.user.organization.id).toBe(ctx.orgB.id);

      // The new token works.
      await refreshWith(next).expect(200);
    });

    it('detects reuse of a revoked token and kills the whole family', async () => {
      const login = await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email: ctx.orgA.rep.email, password: PASSWORD, platform: 'ANDROID' })
        .expect(200);

      const first = login.body.data.tokens.refreshToken as string;

      const rotated = await refreshWith(first).expect(200);
      const second = rotated.body.data.tokens.refreshToken as string;

      /*
       * Immediately after the rotation, the spent token is refused but the
       * family survives: at that distance a straggler from the same wave and
       * a stolen copy are indistinguishable, so the benefit of the doubt goes
       * to the client. Nothing is issued either way.
       */
      const straggler = await refreshWith(first).expect(401);
      expect(straggler.body.error.code).toBe(ERROR_CODES.TOKEN_INVALID);

      // The family is untouched, so the legitimate client carries on.
      const carriedOn = await refreshWith(second).expect(200);
      const third = carriedOn.body.data.tokens.refreshToken as string;

      // Past the interval, the same replay is what a stolen token looks like
      // once the real client has moved on.
      await ageRotation(login.body.data.user.id as string, 30);

      const replay = await refreshWith(first).expect(401);
      expect(replay.body.error.code).toBe(ERROR_CODES.TOKEN_REUSE_DETECTED);

      // The critical assertion: the CURRENT token is now dead too. Revoking
      // only the replayed token would leave the attacker's copy working.
      await refreshWith(third).expect(401);
    });

    it('rejects an unknown refresh token', async () => {
      const response = await refreshWith('completely-made-up-token').expect(401);
      expect(response.body.error.code).toBe(ERROR_CODES.TOKEN_INVALID);
    });
  });

  describe('logout', () => {
    it('revokes the access token immediately, not when it expires', async () => {
      const login = await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email: ctx.orgB.owner.email, password: PASSWORD, platform: 'ANDROID' })
        .expect(200);

      const accessToken = login.body.data.tokens.accessToken as string;
      const refreshToken = login.body.data.tokens.refreshToken as string;

      await ctx.http().get('/api/v1/auth/me').set(auth(accessToken)).expect(200);

      await ctx.http().post('/api/v1/auth/logout').set(auth(accessToken)).expect(204);

      // Deny-listed by jti — the token is still cryptographically valid and
      // unexpired, but is refused.
      await ctx.http().get('/api/v1/auth/me').set(auth(accessToken)).expect(401);

      // And the refresh token cannot resurrect the session.
      await refreshWith(refreshToken).expect(401);
    });
  });

  describe('GET /auth/me', () => {
    it('reports role and permissions from the live membership', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/auth/me')
        .set(auth(ctx.orgA.rep.accessToken))
        .expect(200);

      expect(response.body.data.role).toBe('SALES_REP');
      expect(response.body.data.permissions).toContain('lead.view.own');
      expect(response.body.data.permissions).not.toContain('user.invite');
    });
  });

  describe('response envelope (spec §21)', () => {
    it('wraps successes consistently', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/auth/me')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: expect.any(Object),
        meta: { timestamp: expect.any(String), requestId: expect.any(String) },
      });
    });

    it('wraps failures consistently', async () => {
      const response = await ctx.http().get('/api/v1/auth/me').expect(401);

      expect(response.body).toMatchObject({
        success: false,
        error: { code: expect.any(String), message: expect.any(String) },
        meta: { timestamp: expect.any(String), requestId: expect.any(String) },
      });
    });
  });

  describe('health probes', () => {
    it('/health responds without authentication and without touching the database', async () => {
      const response = await ctx.http().get('/health').expect(200);
      expect(response.body.status).toBe('ok');
    });

    it('/readiness reports dependency health', async () => {
      const response = await ctx.http().get('/readiness').expect(200);
      expect(response.body.checks).toEqual({ database: true, cache: true });
    });
  });
});
