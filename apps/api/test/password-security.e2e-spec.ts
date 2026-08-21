import { ERROR_CODES } from '@leadflow/api-types';
import { createTestContext, type TestContext } from './helpers/test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';

/**
 * Phase 3 — password reset, password change, session management.
 *
 * Written before the implementation.
 *
 * Password reset is the single most attacked flow in any SaaS product: it is
 * unauthenticated, it grants full account access, and it is the one place where
 * a leaked token is equivalent to a leaked password. Every case here is a
 * boundary that has been exploited in real products.
 */
describe('Password security and sessions', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const unique = (prefix: string): string =>
    `${prefix}.${Date.now()}.${Math.floor(Math.random() * 100000)}`;

  /** Registers a throwaway owner so destructive password tests are isolated. */
  const freshUser = async () => {
    const email = `${unique('reset')}@example.test`;
    const password = 'OriginalPassword1';

    const response = await ctx
      .http()
      .post('/api/v1/auth/register')
      .send({
        organizationName: `Reset ${unique('org')}`,
        email,
        password,
        firstName: 'Reset',
        lastName: 'Tester',
        platform: 'ANDROID',
      })
      .expect(201);

    return {
      email,
      password,
      userId: response.body.data.user.id as string,
      accessToken: response.body.data.tokens.accessToken as string,
      refreshToken: response.body.data.tokens.refreshToken as string,
    };
  };

  /** Requests a reset and returns the token the API exposes outside production. */
  const requestReset = async (email: string): Promise<string> => {
    const response = await ctx
      .http()
      .post('/api/v1/auth/forgot-password')
      .send({ email })
      .expect(202);

    return response.body.data.resetToken as string;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ---------------------------------------------------------------------------
  // Requesting a reset
  // ---------------------------------------------------------------------------

  describe('requesting a password reset', () => {
    it('issues a token for a known email', async () => {
      const user = await freshUser();
      const token = await requestReset(user.email);
      expect(token).toBeTruthy();
    });

    it('responds identically for an unknown email', async () => {
      // Any difference — status, body shape, or timing — turns this endpoint
      // into a way to discover who has an account.
      const known = await ctx
        .http()
        .post('/api/v1/auth/forgot-password')
        .send({ email: ctx.orgA.owner.email })
        .expect(202);

      const unknown = await ctx
        .http()
        .post('/api/v1/auth/forgot-password')
        .send({ email: `${unique('ghost')}@example.test` })
        .expect(202);

      expect(unknown.body.data.message).toBe(known.body.data.message);
      // No token is minted for an address with no account.
      expect(unknown.body.data.resetToken).toBeUndefined();
    });

    it('rejects a malformed email', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'not-an-email' })
        .expect(400);

      expect(response.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    });

    it('invalidates a previously issued token when a new one is requested', async () => {
      const user = await freshUser();
      const first = await requestReset(user.email);
      const second = await requestReset(user.email);

      expect(second).not.toBe(first);

      // Otherwise every request leaves another live key to the account.
      await ctx
        .http()
        .post(`/api/v1/auth/reset-password/${first}`)
        .send({ password: 'BrandNewPassword1' })
        .expect(404);

      await ctx
        .http()
        .post(`/api/v1/auth/reset-password/${second}`)
        .send({ password: 'BrandNewPassword1' })
        .expect(200);
    });
  });

  // ---------------------------------------------------------------------------
  // Performing the reset
  // ---------------------------------------------------------------------------

  describe('resetting the password', () => {
    it('sets the new password and refuses the old one', async () => {
      const user = await freshUser();
      const token = await requestReset(user.email);

      await ctx
        .http()
        .post(`/api/v1/auth/reset-password/${token}`)
        .send({ password: 'BrandNewPassword1' })
        .expect(200);

      await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: 'BrandNewPassword1', platform: 'ANDROID' })
        .expect(200);

      await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: user.password, platform: 'ANDROID' })
        .expect(401);
    });

    it('revokes every existing session', async () => {
      const user = await freshUser();

      // Session is live before the reset.
      await ctx.http().get('/api/v1/auth/me').set(auth(user.accessToken)).expect(200);

      const token = await requestReset(user.email);
      await ctx
        .http()
        .post(`/api/v1/auth/reset-password/${token}`)
        .send({ password: 'BrandNewPassword1' })
        .expect(200);

      ctx.redis.flush();

      // A reset is usually a response to compromise, so every existing session
      // must die — including the attacker's.
      await ctx
        .http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: user.refreshToken })
        .expect(401);
    });

    it('refuses to reuse a spent token', async () => {
      const user = await freshUser();
      const token = await requestReset(user.email);

      await ctx
        .http()
        .post(`/api/v1/auth/reset-password/${token}`)
        .send({ password: 'BrandNewPassword1' })
        .expect(200);

      await ctx
        .http()
        .post(`/api/v1/auth/reset-password/${token}`)
        .send({ password: 'AttackerPassword1' })
        .expect(404);
    });

    it('refuses an expired token', async () => {
      const user = await freshUser();
      const token = await requestReset(user.email);

      const prisma = ctx.app.get(PrismaService);
      const tenantContext = ctx.app.get(TenantContextService);

      await tenantContext.runAsSystem('test: expire a reset token', async () => {
        await prisma.client.passwordResetToken.updateMany({
          where: { userId: user.userId, usedAt: null },
          data: { expiresAt: new Date(Date.now() - 60_000) },
        });
      });

      await ctx
        .http()
        .post(`/api/v1/auth/reset-password/${token}`)
        .send({ password: 'BrandNewPassword1' })
        .expect(410);
    });

    it('refuses an unknown token', async () => {
      await ctx
        .http()
        .post('/api/v1/auth/reset-password/not-a-real-token')
        .send({ password: 'BrandNewPassword1' })
        .expect(404);
    });

    it('enforces the password policy', async () => {
      const user = await freshUser();
      const token = await requestReset(user.email);

      const response = await ctx
        .http()
        .post(`/api/v1/auth/reset-password/${token}`)
        .send({ password: 'short' })
        .expect(400);

      expect(response.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    });

    it('does not sign the user in', async () => {
      const user = await freshUser();
      const token = await requestReset(user.email);

      const response = await ctx
        .http()
        .post(`/api/v1/auth/reset-password/${token}`)
        .send({ password: 'BrandNewPassword1' })
        .expect(200);

      // An unauthenticated endpoint that mints sessions is a bigger target.
      // The user proves the new password by signing in with it.
      expect(response.body.data.tokens).toBeUndefined();
      expect(response.body.data.accessToken).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Changing a password while signed in
  // ---------------------------------------------------------------------------

  describe('changing the password', () => {
    it('requires the current password', async () => {
      const user = await freshUser();

      const response = await ctx
        .http()
        .post('/api/v1/auth/change-password')
        .set(auth(user.accessToken))
        .send({ currentPassword: 'WrongPassword1', newPassword: 'BrandNewPassword1' })
        .expect(401);

      // Without this, a stolen access token upgrades to permanent account
      // takeover rather than expiring in 15 minutes.
      expect(response.body.error.code).toBe(ERROR_CODES.INVALID_CREDENTIALS);
    });

    it('changes the password when the current one is correct', async () => {
      const user = await freshUser();

      await ctx
        .http()
        .post('/api/v1/auth/change-password')
        .set(auth(user.accessToken))
        .send({ currentPassword: user.password, newPassword: 'BrandNewPassword1' })
        .expect(200);

      await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: 'BrandNewPassword1', platform: 'ANDROID' })
        .expect(200);
    });

    it('revokes OTHER sessions but keeps the current one working', async () => {
      const user = await freshUser();

      const other = await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: user.password, platform: 'ANDROID' })
        .expect(200);

      await ctx
        .http()
        .post('/api/v1/auth/change-password')
        .set(auth(user.accessToken))
        .send({ currentPassword: user.password, newPassword: 'BrandNewPassword1' })
        .expect(200);

      ctx.redis.flush();

      // The other device is signed out…
      await ctx
        .http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: other.body.data.tokens.refreshToken })
        .expect(401);

      // …but the person who just changed it is not, which would be a hostile
      // experience for the common case of routine hygiene.
      await ctx
        .http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: user.refreshToken })
        .expect(200);
    });

    it('requires authentication', async () => {
      await ctx
        .http()
        .post('/api/v1/auth/change-password')
        .send({ currentPassword: 'x', newPassword: 'BrandNewPassword1' })
        .expect(401);
    });

    it('rejects a new password that fails the policy', async () => {
      const user = await freshUser();

      await ctx
        .http()
        .post('/api/v1/auth/change-password')
        .set(auth(user.accessToken))
        .send({ currentPassword: user.password, newPassword: 'short' })
        .expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  describe('session management', () => {
    it('lists the caller’s own active sessions and flags the current one', async () => {
      const user = await freshUser();

      await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: user.password, platform: 'WEB' })
        .expect(200);

      const response = await ctx
        .http()
        .get('/api/v1/auth/sessions')
        .set(auth(user.accessToken))
        .expect(200);

      const sessions = response.body.data as { id: string; current: boolean }[];
      expect(sessions.length).toBeGreaterThanOrEqual(2);
      expect(sessions.filter((s) => s.current)).toHaveLength(1);

      // A session list must never expose the credential itself.
      expect(JSON.stringify(sessions)).not.toContain('refreshToken');
    });

    it('never lists another user’s sessions', async () => {
      const mine = await freshUser();
      const theirs = await freshUser();

      const response = await ctx
        .http()
        .get('/api/v1/auth/sessions')
        .set(auth(mine.accessToken))
        .expect(200);

      const ids = (response.body.data as { id: string }[]).map((s) => s.id);
      const theirSessions = await ctx
        .http()
        .get('/api/v1/auth/sessions')
        .set(auth(theirs.accessToken))
        .expect(200);

      for (const session of theirSessions.body.data as { id: string }[]) {
        expect(ids).not.toContain(session.id);
      }
    });

    it('revokes a single session', async () => {
      const user = await freshUser();

      const other = await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: user.password, platform: 'ANDROID' })
        .expect(200);

      const sessions = await ctx
        .http()
        .get('/api/v1/auth/sessions')
        .set(auth(user.accessToken))
        .expect(200);

      const target = (sessions.body.data as { id: string; current: boolean }[]).find(
        (s) => !s.current,
      );

      await ctx
        .http()
        .delete(`/api/v1/auth/sessions/${target?.id as string}`)
        .set(auth(user.accessToken))
        .expect(204);

      await ctx
        .http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: other.body.data.tokens.refreshToken })
        .expect(401);
    });

    it('cannot revoke a session belonging to someone else', async () => {
      const mine = await freshUser();
      const theirs = await freshUser();

      const theirSessions = await ctx
        .http()
        .get('/api/v1/auth/sessions')
        .set(auth(theirs.accessToken))
        .expect(200);

      const target = (theirSessions.body.data as { id: string }[])[0];

      // 404, not 403 — confirming the id exists would let someone enumerate
      // other people's sessions.
      await ctx
        .http()
        .delete(`/api/v1/auth/sessions/${target?.id as string}`)
        .set(auth(mine.accessToken))
        .expect(404);

      // And it must still work for its real owner.
      await ctx.http().get('/api/v1/auth/me').set(auth(theirs.accessToken)).expect(200);
    });
  });
});
