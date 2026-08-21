import { createTestContext, PASSWORD, type TestContext } from './helpers/test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';

/**
 * Workstream 1 — one refresh token must mint exactly one child session.
 *
 * Before the fix, five concurrent requests carrying a single token all
 * succeeded and produced five live descendant sessions: one stolen credential
 * could be fanned out into as many valid sessions as the attacker cared to
 * request in parallel.
 */
/*
 * A note on what this environment can and cannot prove.
 *
 * Every case here fires REAL parallel requests with Promise.all. Sequential
 * calls cannot reproduce any of these bugs: each is a read that is still true
 * when it is made and false by the time it is acted on.
 *
 * The local harness runs PGlite, which serves one connection at a time, so
 * database statements serialize even though the application interleaves at
 * every await. That is enough to reproduce these races — they are lost between
 * an application-level read and its later write, not inside a single statement
 * — but it does NOT exercise truly simultaneous execution. CI runs the same
 * suite against real postgres:17.
 */
describe('Refresh token rotation under concurrency', () => {
  let ctx: TestContext;

  const unique = (prefix: string): string =>
    `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`;

  const asSystem = async <T>(fn: (prisma: PrismaService['client']) => Promise<T>): Promise<T> => {
    const tenantContext = ctx.app.get(TenantContextService);
    const prisma = ctx.app.get(PrismaService);
    return tenantContext.runAsSystem('e2e concurrency fixture', () => fn(prisma.client));
  };

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ---------------------------------------------------------------------------
  // Workstream 1 — one refresh token must mint exactly one child session
  // ---------------------------------------------------------------------------

  describe('refresh token rotation', () => {
    /** Signs in fresh so the returned refresh token has been used by nobody. */
    const freshSession = async (): Promise<{ refreshToken: string; userId: string }> => {
      const email = `${unique('rotator')}@example.test`;

      const registered = await ctx
        .http()
        .post('/api/v1/auth/register')
        .send({
          organizationName: `Rotate ${unique('org')}`,
          email,
          password: PASSWORD,
          firstName: 'Rita',
          lastName: 'Rotate',
        })
        .expect(201);

      // Registration returns the refresh token as an httpOnly cookie. Signing
      // in as a non-cookie client is how a body-carried token is obtained.
      const login = await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email, password: PASSWORD, platform: 'ANDROID' })
        .expect(200);

      return {
        refreshToken: login.body.data.tokens.refreshToken as string,
        userId: registered.body.data.user.id as string,
      };
    };

    const sessionsFor = async (userId: string) =>
      asSystem((prisma) =>
        prisma.session.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      );

    it('lets exactly ONE of several concurrent refreshes succeed', async () => {
      const { refreshToken } = await freshSession();

      // Five requests, one token, fired together. Every one of them reads the
      // session as valid before any of them writes.
      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          ctx.http().post('/api/v1/auth/refresh').send({ refreshToken }),
        ),
      );

      const succeeded = responses.filter((response) => response.status === 200);
      const rejected = responses.filter((response) => response.status !== 200);

      expect(succeeded).toHaveLength(1);
      expect(rejected).toHaveLength(4);
      // Losing a race is an authentication failure, never a 500.
      for (const response of rejected) {
        expect(response.status).toBe(401);
      }
    });

    it('creates exactly ONE descendant session', async () => {
      const { refreshToken, userId } = await freshSession();

      await Promise.all(
        Array.from({ length: 5 }, () =>
          ctx.http().post('/api/v1/auth/refresh').send({ refreshToken }),
        ),
      );

      const sessions = await sessionsFor(userId);

      // Registration and the sign-in each made one, and the single winning
      // rotation makes a third. More than three means one token was rotated
      // into several live sessions — the bug.
      expect(sessions).toHaveLength(3);

      // The registration session is still live and untouched; of the rotated
      // pair exactly one survives.
      const live = sessions.filter((session) => session.revokedAt === null);
      expect(live).toHaveLength(2);
    });

    it('marks the consumed session as replaced by the winner', async () => {
      const { refreshToken, userId } = await freshSession();

      await Promise.all(
        Array.from({ length: 4 }, () =>
          ctx.http().post('/api/v1/auth/refresh').send({ refreshToken }),
        ),
      );

      const sessions = await sessionsFor(userId);
      // [0] is the registration session; [1] is the one that was rotated.
      const original = sessions[1];
      const replacement = sessions[2];

      expect(original?.revokedAt).not.toBeNull();
      expect(original?.revokedReason).toBe('ROTATED');
      // The chain must point at the session that actually exists.
      expect(original?.replacedById).toBe(replacement?.id);
    });

    it('still detects reuse of a consumed token afterwards', async () => {
      const { refreshToken, userId } = await freshSession();

      await Promise.all(
        Array.from({ length: 3 }, () =>
          ctx.http().post('/api/v1/auth/refresh').send({ refreshToken }),
        ),
      );

      // Replaying the spent token later is a leak, not a race. The whole
      // family dies — concurrency safety must not soften that.
      const replay = await ctx.http().post('/api/v1/auth/refresh').send({ refreshToken });
      expect(replay.status).toBe(401);

      // Reuse kills the whole FAMILY, which is the rotated chain — the
      // separate registration session belongs to a different family.
      const sessions = await sessionsFor(userId);
      const familyId = sessions[1]?.familyId;
      const family = sessions.filter((session) => session.familyId === familyId);

      expect(family.length).toBeGreaterThan(1);
      expect(family.every((session) => session.revokedAt !== null)).toBe(true);
    });

    it('leaves a sequential rotation working normally', async () => {
      const { refreshToken } = await freshSession();

      const first = await ctx
        .http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken })
        .expect(200);

      const second = await ctx
        .http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: first.body.data.tokens.refreshToken })
        .expect(200);

      expect(second.body.data.tokens.accessToken).toBeTruthy();
    });
  });
});
