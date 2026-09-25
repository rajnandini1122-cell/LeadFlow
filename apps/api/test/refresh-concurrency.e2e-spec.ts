import {
  createTestContext,
  PASSWORD,
  registerVerifiedOrganization,
  type TestContext,
} from './helpers/test-app';
import { AUDIT_ACTIONS } from '../src/common/audit/audit.repository';
import { AuthRepository } from '../src/modules/auth/auth.repository';
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
    const freshSession = async (): Promise<{
      refreshToken: string;
      userId: string;
      email: string;
    }> => {
      const email = `${unique('rotator')}@example.test`;

      // Registration issues no session at all now — the mailbox has to be
      // proven first — so the helper registers, verifies and signs in as a
      // non-cookie client, which is how a body-carried refresh token is got.
      const registered = await registerVerifiedOrganization(ctx.app, {
        organizationName: `Rotate ${unique('org')}`,
        email,
        password: PASSWORD,
        firstName: 'Rita',
        lastName: 'Rotate',
        platform: 'ANDROID',
      });

      return {
        email,
        refreshToken: registered.tokens.refreshToken,
        userId: registered.registration.body.data.user.id as string,
      };
    };

    const sessionsFor = async (userId: string) =>
      asSystem((prisma) =>
        prisma.session.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      );

    /**
     * Moves a rotation's revocation in the DATABASE's clock domain.
     *
     * Sleeping for real seconds would make the suite slow and timing-fragile;
     * restamping the revocation reaches the same state instantly.
     *
     * The seconds come from `clock_timestamp()` rather than from `new Date()`
     * deliberately, and the suite proved why: PGlite's clock runs hours away
     * from this machine's, so a fixture written with the application clock is
     * in a different domain from the value a rotation actually writes, and the
     * comparison under test becomes meaningless. Production reads and writes
     * both sides with the database clock; so does this.
     */
    const restampRevocation = async (sessionId: string, seconds: number): Promise<void> => {
      await asSystem(
        (prisma) =>
          prisma.$executeRaw`
            UPDATE "sessions"
               SET "revoked_at" = clock_timestamp() + make_interval(secs => ${seconds}::double precision)
             WHERE "id" = ${sessionId}::uuid
          ` as Promise<number>,
      );
    };

    /** Older than the approved 2000 ms interval, in database time. */
    const ageRevocation = async (sessionId: string, secondsAgo: number): Promise<void> =>
      restampRevocation(sessionId, -secondsAgo);

    /** Comfortably outside the approved 2000 ms interval. */
    const BEYOND_INTERVAL_SECONDS = 30;

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

      /*
       * Two: the sign-in made one, and the single winning rotation made its
       * replacement. More than two means one token was rotated into several
       * live sessions — the bug this test exists for.
       *
       * It was three before mandatory email verification, because registration
       * used to issue a session of its own. It no longer does, so the count
       * dropped by exactly one and nothing else about the rotation changed.
       */
      expect(sessions).toHaveLength(2);

      // Of the rotated pair, exactly one survives.
      const live = sessions.filter((session) => session.revokedAt === null);
      expect(live).toHaveLength(1);
    });

    it('marks the consumed session as replaced by the winner', async () => {
      const { refreshToken, userId } = await freshSession();

      await Promise.all(
        Array.from({ length: 4 }, () =>
          ctx.http().post('/api/v1/auth/refresh').send({ refreshToken }),
        ),
      );

      const sessions = await sessionsFor(userId);
      // [0] is the sign-in session, which was rotated; [1] is its replacement.
      // Registration issues no session of its own, so there is nothing before
      // these two.
      const original = sessions[0];
      const replacement = sessions[1];

      expect(original?.revokedAt).not.toBeNull();
      expect(original?.revokedReason).toBe('ROTATED');
      // The chain must point at the session that actually exists.
      expect(original?.replacedById).toBe(replacement?.id);
    });

    it('still detects reuse of a consumed token once the interval has passed', async () => {
      const { refreshToken, userId } = await freshSession();

      await Promise.all(
        Array.from({ length: 3 }, () =>
          ctx.http().post('/api/v1/auth/refresh').send({ refreshToken }),
        ),
      );

      // Age the rotation past the reuse interval. Beyond it, presenting the
      // spent token is a leak rather than a straggler, and the whole family
      // dies — tolerance for stragglers must not soften that.
      const rotated = (await sessionsFor(userId))[0];
      await ageRevocation(rotated?.id as string, BEYOND_INTERVAL_SECONDS);

      const replay = await ctx.http().post('/api/v1/auth/refresh').send({ refreshToken });
      expect(replay.status).toBe(401);

      // Reuse kills the whole FAMILY, which is the rotated chain.
      const sessions = await sessionsFor(userId);
      const familyId = sessions[0]?.familyId;
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

    it('tolerates reuse INSIDE the interval without killing the family', async () => {
      /*
       * The straggler case, and the reason the interval exists.
       *
       * Requests sent together can reach the database far apart — a saturated
       * pool is enough — so a legitimate late arrival looks exactly like a
       * replay sent immediately after the rotation (CI runs #3 and #4). Inside
       * the interval the benefit of the doubt goes to the client, and what is
       * withheld is only the family-wide revocation: the spent token still
       * fails, and still mints nothing.
       */
      const { refreshToken, userId } = await freshSession();

      const winner = await ctx
        .http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken })
        .expect(200);

      const before = await sessionsFor(userId);
      // [0] is the sign-in session, the one the winning rotation consumed.
      const parent = before[0];
      expect(parent?.revokedReason).toBe('ROTATED');

      const straggler = await ctx.http().post('/api/v1/auth/refresh').send({ refreshToken });

      // 401, never a 500, and never a credential.
      expect(straggler.status).toBe(401);
      expect(straggler.body?.data).toBeUndefined();

      const after = await sessionsFor(userId);
      const family = after.filter((session) => session.familyId === parent?.familyId);

      // No second child, and the winner's session is still usable.
      expect(after).toHaveLength(before.length);
      expect(family.filter((session) => session.revokedAt === null)).toHaveLength(1);

      await ctx
        .http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: winner.body.data.tokens.refreshToken })
        .expect(200);
    });

    it('measures the interval on the DATABASE clock, not this process clock', async () => {
      /*
       * The guarantee that matters once there is more than one API replica.
       *
       * Their clocks can disagree; the database cannot disagree with itself.
       * Here the stored revocation is moved an hour into the FUTURE. Elapsed
       * time in this process says the rotation just happened, and a rule built
       * on Date.now() would agree — but the database computes
       * clock_timestamp() - revoked_at, which is negative and therefore inside
       * any interval, so the family survives. The decision follows the
       * database's arithmetic, not this process's stopwatch.
       */
      const { refreshToken, userId } = await freshSession();

      await ctx.http().post('/api/v1/auth/refresh').send({ refreshToken }).expect(200);

      const parent = (await sessionsFor(userId))[0];
      // An hour into the future, in the database's own clock domain.
      await restampRevocation(parent?.id as string, 60 * 60);

      // The database's own answer, asked directly: a revocation it believes is
      // in the future is inside any interval.
      const repository = ctx.app.get(AuthRepository);
      await expect(
        repository.isWithinRotationReuseInterval({
          sessionId: parent?.id as string,
          organizationId: parent?.organizationId as string,
          intervalMs: 2000,
        }),
      ).resolves.toBe(true);

      const replay = await ctx.http().post('/api/v1/auth/refresh').send({ refreshToken });
      expect(replay.status).toBe(401);

      const family = (await sessionsFor(userId)).filter(
        (session) => session.familyId === parent?.familyId,
      );
      expect(family.filter((session) => session.revokedAt === null)).toHaveLength(1);
    });

    it('gives NO grace to a token revoked for any reason other than rotation', async () => {
      /*
       * The interval is tolerance for a rotation race and nothing else. A
       * session ended by logout, a password change, lost membership or an
       * earlier reuse detection is invalid for reasons that have nothing to do
       * with racing, however recently it happened.
       */
      const { refreshToken, userId } = await freshSession();

      const parent = (await sessionsFor(userId))[0];
      await asSystem((prisma) =>
        prisma.session.update({
          where: { id: parent?.id },
          // Revoked a moment ago — well inside the interval — but not by a
          // rotation.
          data: { revokedAt: new Date(), revokedReason: 'LOGOUT' },
        }),
      );

      const replay = await ctx.http().post('/api/v1/auth/refresh').send({ refreshToken });
      expect(replay.status).toBe(401);

      const family = (await sessionsFor(userId)).filter(
        (session) => session.familyId === parent?.familyId,
      );
      expect(family.every((session) => session.revokedAt !== null)).toBe(true);
    });

    it('leaves an unrelated family live when reuse is detected', async () => {
      const { refreshToken, userId, email } = await freshSession();

      /*
       * A second device, signed in separately, so there is genuinely another
       * family to protect.
       *
       * This used to lean on the session registration issued — which no longer
       * exists, now that a mailbox has to be proven first. Opening the second
       * family explicitly says what the test is actually about: one family's
       * compromise must not sign the person out of a device that never held
       * the leaked token.
       */
      await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email, password: PASSWORD, platform: 'ANDROID' })
        .expect(200);

      await ctx.http().post('/api/v1/auth/refresh').send({ refreshToken }).expect(200);

      const rotated = (await sessionsFor(userId))[0];
      await ageRevocation(rotated?.id as string, BEYOND_INTERVAL_SECONDS);

      const replay = await ctx.http().post('/api/v1/auth/refresh').send({ refreshToken });
      expect(replay.status).toBe(401);

      const sessions = await sessionsFor(userId);
      const rotatedFamily = rotated?.familyId;
      const unrelated = sessions.filter((session) => session.familyId !== rotatedFamily);

      // The other device's family is untouched.
      expect(unrelated.length).toBeGreaterThan(0);
      expect(unrelated.every((session) => session.revokedAt === null)).toBe(true);
    });

    it('mints no session when reuse is detected', async () => {
      const { refreshToken, userId } = await freshSession();

      await ctx.http().post('/api/v1/auth/refresh').send({ refreshToken }).expect(200);
      const before = await sessionsFor(userId);
      await ageRevocation(before[0]?.id as string, BEYOND_INTERVAL_SECONDS);

      const replay = await ctx.http().post('/api/v1/auth/refresh').send({ refreshToken });
      expect(replay.status).toBe(401);

      // A replay mints nothing: reuse detection revokes, it never issues.
      expect(await sessionsFor(userId)).toHaveLength(before.length);
    });

    it('audits a real replay, and stays silent for concurrent losers', async () => {
      const reuseAudits = async (userId: string): Promise<number> =>
        asSystem((prisma) =>
          prisma.auditLog.count({
            where: { actorUserId: userId, action: AUDIT_ACTIONS.TOKEN_REUSE_DETECTED },
          }),
        );

      const { refreshToken, userId } = await freshSession();

      await Promise.all(
        Array.from({ length: 5 }, () =>
          ctx.http().post('/api/v1/auth/refresh').send({ refreshToken }),
        ),
      );

      // Four people losing a race is not a security event. Recording it as one
      // teaches whoever reads the audit trail to ignore the real thing.
      expect(await reuseAudits(userId)).toBe(0);

      // Past the interval, the same token presented again IS the real thing.
      const rotated = (await sessionsFor(userId))[0];
      await ageRevocation(rotated?.id as string, BEYOND_INTERVAL_SECONDS);

      const replay = await ctx.http().post('/api/v1/auth/refresh').send({ refreshToken });
      expect(replay.status).toBe(401);

      expect(await reuseAudits(userId)).toBeGreaterThan(0);
    });
  });
});
