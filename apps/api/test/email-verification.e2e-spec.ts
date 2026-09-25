import { ERROR_CODES } from '@leadflow/api-types';
import { createTestContext, markMailboxProven, type TestContext } from './helpers/test-app';
import { EmailService } from '../src/common/email/email.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { createHash } from 'node:crypto';

/**
 * Mandatory email verification, end to end.
 *
 * The defect this closes: registering put the person straight into the
 * dashboard. Nobody ever proved they owned the address they typed, so a typo
 * produced a working account whose owner could never recover it — password
 * reset goes to a mailbox they do not control — and nothing at all stopped
 * somebody registering under another person's address.
 *
 * The raw token is captured at the MAIL SEAM rather than from any response.
 * That is deliberate twice over: the API never returns a live token, so there
 * is nothing here that could tempt somebody into exposing one in production;
 * and reading it where the email is sent means these tests exercise the same
 * value a real recipient receives.
 */
describe('Email verification', () => {
  let ctx: TestContext;
  let sentTokens: { email: string; token: string }[];

  const PASSWORD = 'CorrectHorse!2026';
  const unique = (prefix: string): string =>
    `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`;

  const prisma = () => ctx.app.get(PrismaService).client;
  const asSystem = async <T>(run: () => Promise<T>): Promise<T> =>
    ctx.app.get(TenantContextService).runAsSystem('e2e email verification', run);

  /** The token most recently emailed to this address. */
  const tokenFor = (email: string): string => {
    const match = [...sentTokens].reverse().find((sent) => sent.email === email.toLowerCase());
    if (!match) throw new Error(`No verification email was sent to ${email}`);
    return match.token;
  };

  const register = async (overrides: Record<string, unknown> = {}) => {
    const email = (overrides['email'] as string) ?? `${unique('newcomer')}@example.test`;

    const response = await ctx
      .http()
      .post('/api/v1/auth/register')
      .send({
        organizationName: `Verify ${unique('org')}`,
        firstName: 'Vera',
        lastName: 'Verify',
        password: PASSWORD,
        ...overrides,
        email,
      });

    return { response, email };
  };

  const login = (email: string, password = PASSWORD) =>
    ctx.http().post('/api/v1/auth/login').send({ email, password, platform: 'ANDROID' });

  const verify = (token: string) =>
    ctx.http().post('/api/v1/auth/verify-email').send({ token });

  const resend = (email: string) =>
    ctx.http().post('/api/v1/auth/verify-email/resend').send({ email });

  beforeAll(async () => {
    ctx = await createTestContext();
    sentTokens = [];

    /*
     * Wraps the real method rather than replacing it, so the template, the
     * link construction and the provider all still run. A stub would make
     * every test below pass against an email that is never actually built.
     */
    const emails = ctx.app.get(EmailService);
    const original = emails.sendEmailVerification.bind(emails);

    jest
      .spyOn(emails, 'sendEmailVerification')
      .mockImplementation(async (input: Parameters<typeof original>[0]) => {
        sentTokens.push({ email: input.to.toLowerCase(), token: input.token });
        return original(input);
      });
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await ctx?.close();
  });

  // ---------------------------------------------------------------------------
  // Registration no longer signs anybody in
  // ---------------------------------------------------------------------------

  describe('registering', () => {
    it('creates the account but issues NO session', async () => {
      const { response } = await register();

      expect(response.status).toBe(201);
      expect(response.body.data.verified).toBe(false);
      expect(response.body.data.tokens).toBeUndefined();
    });

    it('sets no refresh cookie', async () => {
      const { response } = await register({ platform: 'WEB' });

      /*
       * The cookie is the other half of a session. Returning no access token
       * while still setting this would leave a browser able to mint one from
       * /auth/refresh — the enforcement bypassed by the thing it protects.
       */
      const raw = response.headers['set-cookie'] ?? [];
      const cookies = Array.isArray(raw) ? raw : [raw];
      expect(cookies.join(';')).not.toContain('refresh');
    });

    it('leaves the mailbox unproven in the database', async () => {
      const { email } = await register();

      const user = await asSystem(() =>
        prisma().user.findFirst({ where: { email }, select: { emailVerifiedAt: true } }),
      );

      expect(user?.emailVerifiedAt).toBeNull();
    });

    it('sends exactly one verification email', async () => {
      const { email } = await register();

      expect(sentTokens.filter((sent) => sent.email === email)).toHaveLength(1);
    });

    it('reports whether the provider accepted the message', async () => {
      const { response } = await register();

      // Acceptance, never delivery — nothing in this process can know an
      // inbox received anything.
      expect(typeof response.body.data.verificationEmailSent).toBe('boolean');
    });

    it('stores only the HASH of the token', async () => {
      const { email } = await register();
      const raw = tokenFor(email);

      const stored = await asSystem(() =>
        prisma().emailVerificationToken.findFirst({
          where: { tokenHash: createHash('sha256').update(raw).digest('hex') },
          select: { id: true },
        }),
      );

      expect(stored).not.toBeNull();

      // The raw token is not queryable, so a database disclosure yields
      // nothing that can be redeemed.
      const byRaw = await asSystem(() =>
        prisma().emailVerificationToken.findFirst({
          where: { tokenHash: raw },
          select: { id: true },
        }),
      );

      expect(byRaw).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Signing in
  // ---------------------------------------------------------------------------

  describe('login enforcement', () => {
    it('REFUSES an unverified account even with the correct password', async () => {
      const { email } = await register();

      const response = await login(email).expect(403);

      expect(response.body.error.code).toBe(ERROR_CODES.EMAIL_VERIFICATION_REQUIRED);
      expect(response.body.data).toBeUndefined();
    });

    it('still refuses with the wrong password, and says nothing more', async () => {
      const { email } = await register();

      /*
       * The refusal must not become an oracle. A wrong password on an
       * unverified account answers as a wrong password does, so the
       * verification state of somebody else's account cannot be probed by
       * guessing at it.
       */
      const response = await login(email, 'WrongPassword!2026').expect(401);

      expect(response.body.error.code).not.toBe(ERROR_CODES.EMAIL_VERIFICATION_REQUIRED);
    });

    it('lets the same account in once the mailbox is proven', async () => {
      const { email } = await register();
      await verify(tokenFor(email)).expect(200);

      const response = await login(email).expect(200);

      expect(response.body.data.tokens.accessToken).toBeTruthy();
    });

    it('does not disturb accounts that already existed', async () => {
      /*
       * The migration back-fills every pre-existing user, and the harness
       * fixtures stand for exactly those. If this fails, shipping the feature
       * locks the entire customer base out of their own accounts.
       */
      const response = await login(ctx.orgA.owner.email).expect(200);

      expect(response.body.data.tokens.accessToken).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------------
  // Redeeming a link
  // ---------------------------------------------------------------------------

  describe('the verification link', () => {
    it('verifies the address and says which one', async () => {
      const { email } = await register();

      const response = await verify(tokenFor(email)).expect(200);

      expect(response.body.data.email).toBe(email);
    });

    it('records the moment in the database', async () => {
      const { email } = await register();
      await verify(tokenFor(email)).expect(200);

      const user = await asSystem(() =>
        prisma().user.findFirst({ where: { email }, select: { emailVerifiedAt: true } }),
      );

      expect(user?.emailVerifiedAt).toBeInstanceOf(Date);
    });

    it('is SINGLE USE', async () => {
      const { email } = await register();
      const token = tokenFor(email);

      await verify(token).expect(200);
      const second = await verify(token).expect(409);

      // Not reported as a failure: clicking twice, or a mail client
      // prefetching the URL, is the ordinary cause and the account is fine.
      expect(second.body.error.code).toBe(ERROR_CODES.EMAIL_VERIFICATION_ALREADY_COMPLETED);
    });

    it('survives two simultaneous redemptions without double-verifying', async () => {
      const { email } = await register();
      const token = tokenFor(email);

      const [a, b] = await Promise.all([verify(token), verify(token)]);
      const statuses = [a.status, b.status].sort();

      // Exactly one wins. Both succeeding would mean the single-use guard is
      // a read-then-write and not the conditional update it must be.
      expect(statuses).toEqual([200, 409]);
    });

    it('refuses a token that never existed', async () => {
      const response = await verify('not-a-real-token-at-all').expect(404);

      expect(response.body.error.code).toBe(ERROR_CODES.EMAIL_VERIFICATION_INVALID);
    });

    it('refuses an expired token, distinguishably', async () => {
      const { email } = await register();
      const token = tokenFor(email);

      await asSystem(() =>
        prisma().emailVerificationToken.updateMany({
          where: { tokenHash: createHash('sha256').update(token).digest('hex') },
          data: { expiresAt: new Date(Date.now() - 1_000) },
        }),
      );

      const response = await verify(token).expect(409);

      // Its own code, because "expired" sends the person to a resend form
      // while "invalid" does not mean the same thing to them.
      expect(response.body.error.code).toBe(ERROR_CODES.EMAIL_VERIFICATION_EXPIRED);
    });

    it('needs no authentication', async () => {
      const { email } = await register();

      // Nobody can be signed in at this point — that is the whole situation
      // this endpoint exists for.
      await verify(tokenFor(email)).expect(200);
    });
  });

  // ---------------------------------------------------------------------------
  // Asking for another link
  // ---------------------------------------------------------------------------

  describe('resending', () => {
    it('sends a new link and invalidates the previous one', async () => {
      const { email } = await register();
      const first = tokenFor(email);

      await resend(email).expect(200);
      const second = tokenFor(email);

      expect(second).not.toBe(first);

      // Only one live link at a time: a superseded one must not still work.
      await verify(first).expect(409);
      await verify(second).expect(200);
    });

    it('answers identically for an address with no account', async () => {
      const real = await register();
      const realAnswer = await resend(real.email).expect(200);
      const strangerAnswer = await resend(`${unique('nobody')}@example.test`).expect(200);

      /*
       * Enumeration safety. An unauthenticated endpoint that distinguishes
       * these tells a competitor precisely who uses this product.
       */
      expect(strangerAnswer.body.data.message).toBe(realAnswer.body.data.message);
    });

    it('answers identically for an address that is already verified', async () => {
      const { email } = await register();
      await verify(tokenFor(email)).expect(200);
      const before = sentTokens.length;

      const response = await resend(email).expect(200);

      expect(response.body.data.message).toBeTruthy();
      // Nothing to send, and nothing sent.
      expect(sentTokens).toHaveLength(before);
    });

    it('stops sending once the per-account budget is spent', async () => {
      const { email } = await register();

      // One was sent by registration; the budget is five per hour.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await resend(email).expect(200);
      }

      const sentBefore = sentTokens.filter((sent) => sent.email === email).length;
      expect(sentBefore).toBe(5);

      const refused = await resend(email).expect(200);
      const sentAfter = sentTokens.filter((sent) => sent.email === email).length;

      // Refused silently: a distinguishable rate-limit error would confirm a
      // real unverified account exists, which is the oracle the neutral
      // message above exists to close.
      expect(sentAfter).toBe(sentBefore);
      expect(refused.body.data.message).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------------
  // The other ways a mailbox gets proven
  // ---------------------------------------------------------------------------

  describe('proving ownership another way', () => {
    it('counts accepting an emailed invitation as proof', async () => {
      const ownerToken = ctx.orgA.owner.accessToken;
      const email = `${unique('invitee')}@example.test`;

      const invite = await ctx
        .http()
        .post('/api/v1/users/invite')
        .set({ Authorization: `Bearer ${ownerToken}` })
        .send({ email, fullName: 'Ivy Invitee', role: 'SALES_REP' })
        .expect(201);

      await ctx
        .http()
        .post(`/api/v1/invitations/${invite.body.data.inviteToken}/accept`)
        .send({ firstName: 'Ivy', lastName: 'Invitee', password: PASSWORD })
        .expect(200);

      /*
       * The invitation token only ever reached the invited mailbox, so
       * redeeming it proves the same thing a verification link proves. Asking
       * for a second proof would send a confirmation email to somebody who has
       * just demonstrably read one.
       */
      const user = await asSystem(() =>
        prisma().user.findFirst({ where: { email }, select: { emailVerifiedAt: true } }),
      );

      expect(user?.emailVerifiedAt).toBeInstanceOf(Date);
      await login(email).expect(200);
    });
  });

  // ---------------------------------------------------------------------------
  // Sessions that outlive the proof
  // ---------------------------------------------------------------------------

  describe('refreshing', () => {
    it('refuses to renew a session whose account is no longer verified', async () => {
      const { email } = await register();
      await verify(tokenFor(email)).expect(200);

      const session = await login(email).expect(200);
      const refreshToken = session.body.data.tokens.refreshToken as string;

      /*
       * Stands in for an account whose verification is revoked while it holds
       * a live session. The refresh path has to re-check the database rather
       * than trust the claim baked into the token when it was minted —
       * otherwise a 30-day refresh token outlives the decision by a month.
       */
      await asSystem(() =>
        prisma().user.updateMany({ where: { email }, data: { emailVerifiedAt: null } }),
      );

      const response = await ctx
        .http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe(ERROR_CODES.EMAIL_VERIFICATION_REQUIRED);

      // Put it back, so nothing after this inherits a half-broken account.
      await markMailboxProven(ctx.app, email);
    });
  });
});
