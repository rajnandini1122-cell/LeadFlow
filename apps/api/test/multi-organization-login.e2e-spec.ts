import { PLATFORM_ROLE_KEY } from '@leadflow/api-types';
import { createTestContext, type TestContext } from './helpers/test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';

/**
 * Signing in when the account belongs to more than one organization.
 *
 * This covers a production outage: no multi-organization user could log in at
 * all. The chooser rendered, clicking a card returned HTTP 200, and the chooser
 * rendered again — forever.
 *
 * The cause was a collision between two correct rules.
 * `StripTenantFieldsInterceptor` deletes any field named `organizationId` from
 * every request body before a controller sees it, which is Layer 1 of tenant
 * isolation and has no exemptions. `LoginDto` named its selection field
 * `organizationId`. So the user's choice was deleted in flight, the server saw
 * an unresolved account again, and answered with the chooser.
 *
 * Nothing in the suite caught it, because no test had ever completed a
 * multi-organization login by actually supplying the id — the flow was tested
 * only up to the point where the chooser appears. These tests go the rest of
 * the way, and the first one below is the one that would have failed.
 */
describe('Multi-organization login', () => {
  let ctx: TestContext;

  const PASSWORD = 'CorrectHorse!2026';
  const prisma = () => ctx.app.get(PrismaService).client;

  const asSystem = async <T>(run: () => Promise<T>): Promise<T> =>
    ctx.app.get(TenantContextService).runAsSystem('e2e multi-org login', run);

  /** The Org A owner, additionally made a member of Org B. */
  let dualEmail: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    dualEmail = ctx.orgA.owner.email;

    await asSystem(async () => {
      const user = await prisma().user.findFirst({
        where: { email: dualEmail },
        select: { id: true },
      });

      const role = await prisma().role.findFirst({
        where: { key: 'ADMIN', organizationId: null, isSystem: true },
        select: { id: true },
      });

      await prisma().organizationUser.create({
        data: {
          organizationId: ctx.orgB.id,
          userId: user!.id,
          roleId: role!.id,
          status: 'ACTIVE',
          joinedAt: new Date(),
        },
      });
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const login = (body: Record<string, unknown>) =>
    ctx.http().post('/api/v1/auth/login').send({ platform: 'ANDROID', ...body });

  describe('choosing an organization', () => {
    it('asks which organization when the account has several', async () => {
      const response = await login({ email: dualEmail, password: PASSWORD }).expect(200);

      expect(response.body.data.requiresOrganizationSelection).toBe(true);
      expect(response.body.data.organizations).toHaveLength(2);
      expect(response.body.data.tokens).toBeUndefined();
    });

    it('COMPLETES the login when given the choice', async () => {
      /*
       * THE regression test.
       *
       * Before the fix this returned `requiresOrganizationSelection: true`
       * again — a 200 that looked like success and left the client exactly
       * where it started. The field name is the whole fix: `organizationId`
       * was deleted in flight by the tenant-field interceptor.
       */
      const response = await login({
        email: dualEmail,
        password: PASSWORD,
        targetOrganizationId: ctx.orgB.id,
      }).expect(200);

      expect(response.body.data.requiresOrganizationSelection).toBe(false);
      expect(response.body.data.tokens.accessToken).toBeTruthy();
      expect(response.body.data.user.organization.id).toBe(ctx.orgB.id);
    });

    it('enters the organization that was actually chosen', async () => {
      // Both directions, so a fix that simply always picks the first
      // membership would fail here.
      const intoA = await login({
        email: dualEmail,
        password: PASSWORD,
        targetOrganizationId: ctx.orgA.id,
      }).expect(200);

      const intoB = await login({
        email: dualEmail,
        password: PASSWORD,
        targetOrganizationId: ctx.orgB.id,
      }).expect(200);

      expect(intoA.body.data.user.organization.id).toBe(ctx.orgA.id);
      expect(intoB.body.data.user.organization.id).toBe(ctx.orgB.id);
    });

    it('issues a token scoped to the chosen organization', async () => {
      const response = await login({
        email: dualEmail,
        password: PASSWORD,
        targetOrganizationId: ctx.orgB.id,
      }).expect(200);

      const token = response.body.data.tokens.accessToken as string;

      // The session really is Org B's: Org A's lead is invisible through it.
      await ctx
        .http()
        .get(`/api/v1/leads/${ctx.orgA.leadId}`)
        .set({ Authorization: `Bearer ${token}` })
        .expect(404);

      await ctx
        .http()
        .get(`/api/v1/leads/${ctx.orgB.leadId}`)
        .set({ Authorization: `Bearer ${token}` })
        .expect(200);
    });
  });

  describe('fail-closed', () => {
    it('refuses an organization the account does not belong to', async () => {
      const stranger = await asSystem(() =>
        prisma().organization.create({
          data: { name: `Stranger ${Date.now()}`, slug: `stranger-${Date.now()}` },
          select: { id: true },
        }),
      );

      const response = await login({
        email: dualEmail,
        password: PASSWORD,
        targetOrganizationId: stranger.id,
      });

      // A selector, never an assertion of scope. The server re-reads live
      // membership, so naming somebody else's organization mints nothing.
      expect(response.status).toBe(403);
      expect(response.body.data?.tokens).toBeUndefined();
    });

    it('refuses a malformed organization id rather than ignoring it', async () => {
      const response = await login({
        email: dualEmail,
        password: PASSWORD,
        targetOrganizationId: 'not-a-uuid',
      });

      /*
       * 400, not a silent fall-through to the chooser.
       *
       * Ignoring an unparseable selection is how the original bug FELT to a
       * user: the request succeeded and nothing happened.
       */
      expect(response.status).toBe(400);
      expect(response.body.error.details).toHaveProperty('targetOrganizationId');
    });

    it('still refuses a wrong password even with a valid selection', async () => {
      const response = await login({
        email: dualEmail,
        password: 'WrongPassword!2026',
        targetOrganizationId: ctx.orgB.id,
      });

      // Choosing an organization is not a way around authentication.
      expect(response.status).toBe(401);
    });
  });

  describe('the forbidden field name is still stripped everywhere', () => {
    it('ignores a body that uses organizationId, rather than honouring it', async () => {
      const response = await login({
        email: dualEmail,
        password: PASSWORD,
        organizationId: ctx.orgB.id,
      }).expect(200);

      /*
       * The isolation rule is INTACT, and this test pins it.
       *
       * The fix renamed the login field rather than exempting the route,
       * precisely so `organizationId` keeps being deleted from every request.
       * A future "convenience" that accepted both names would reopen the hole
       * this interceptor exists to close, and would fail here.
       */
      expect(response.body.data.requiresOrganizationSelection).toBe(true);
    });
  });

  describe('a single-organization account is unaffected', () => {
    it('signs straight in with no chooser', async () => {
      const response = await login({
        email: ctx.orgB.rep.email,
        password: PASSWORD,
      }).expect(200);

      expect(response.body.data.requiresOrganizationSelection).toBe(false);
      expect(response.body.data.user.organization.id).toBe(ctx.orgB.id);
    });
  });

  describe('PLATFORM_OWNER', () => {
    it('chooses the CRAVION organization like any other membership', async () => {
      const stamp = Date.now();
      const email = `dual.platform.${stamp}@cravion.test`;

      const internalId = await asSystem(async () => {
        // Clear the singleton first: at most one INTERNAL organization may
        // exist database-wide, and other suites create one too.
        const existing = await prisma().organization.findMany({
          where: { organizationType: 'INTERNAL' },
          select: { id: true },
        });
        for (const organization of existing) {
          await prisma().organizationUser.deleteMany({
            where: { organizationId: organization.id },
          });
          await prisma().organizationSettings.deleteMany({
            where: { organizationId: organization.id },
          });
          await prisma().organization.delete({ where: { id: organization.id } });
        }

        const internal = await prisma().organization.create({
          data: {
            name: 'CRAVION VENTURES (OPC) PRIVATE LIMITED',
            slug: `cravion-login-${stamp}`,
            organizationType: 'INTERNAL',
            status: 'ACTIVE',
          },
          select: { id: true },
        });
        await prisma().organizationSettings.create({
          data: { organizationId: internal.id },
        });

        const argon2 = await import('argon2');
        const passwordHash = await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: 8192,
          timeCost: 2,
          parallelism: 1,
        });

        const user = await prisma().user.create({
          data: {
            email,
            fullName: 'Dual Platform Owner',
            passwordHash,
            status: 'ACTIVE',
            // Stands for an account that predates verification, which the
            // migration back-fills. Signing in is the point of the fixture.
            emailVerifiedAt: new Date(),
          },
          select: { id: true },
        });

        const platformRole = await prisma().role.findFirst({
          where: { key: PLATFORM_ROLE_KEY, organizationId: null, isSystem: true },
          select: { id: true },
        });
        const ownerRole = await prisma().role.findFirst({
          where: { key: 'OWNER', organizationId: null, isSystem: true },
          select: { id: true },
        });

        // Two memberships, exactly like the production account: OWNER of a
        // customer organization and PLATFORM_OWNER of CRAVION's own.
        await prisma().organizationUser.create({
          data: {
            organizationId: ctx.orgA.id,
            userId: user.id,
            roleId: ownerRole!.id,
            status: 'ACTIVE',
            joinedAt: new Date(),
          },
        });
        await prisma().organizationUser.create({
          data: {
            organizationId: internal.id,
            userId: user.id,
            roleId: platformRole!.id,
            status: 'ACTIVE',
            joinedAt: new Date(),
          },
        });

        return internal.id;
      });

      // The chooser, with both memberships.
      const first = await login({ email, password: PASSWORD }).expect(200);
      expect(first.body.data.requiresOrganizationSelection).toBe(true);
      expect(
        (first.body.data.organizations as { role: string }[]).map((o) => o.role).sort(),
      ).toEqual(['OWNER', PLATFORM_ROLE_KEY]);

      // Choosing the internal one completes the login and reports the role.
      const chosen = await login({
        email,
        password: PASSWORD,
        targetOrganizationId: internalId,
      }).expect(200);

      expect(chosen.body.data.requiresOrganizationSelection).toBe(false);
      expect(chosen.body.data.user.organization.id).toBe(internalId);
      expect(chosen.body.data.user.role).toBe(PLATFORM_ROLE_KEY);

      // NOT auto-selected. The customer organization is equally reachable —
      // being the platform owner does not decide where they land.
      const customer = await login({
        email,
        password: PASSWORD,
        targetOrganizationId: ctx.orgA.id,
      }).expect(200);

      expect(customer.body.data.user.organization.id).toBe(ctx.orgA.id);
      expect(customer.body.data.user.role).toBe('OWNER');
    });

    it('does not widen tenant scope when signed into the internal organization', async () => {
      const stamp = Date.now();
      const email = `scope.platform.${stamp}@cravion.test`;

      const internalId = await asSystem(async () => {
        const internal = await prisma().organization.findFirst({
          where: { organizationType: 'INTERNAL' },
          select: { id: true },
        });

        const argon2 = await import('argon2');
        const passwordHash = await argon2.hash(PASSWORD, {
          type: argon2.argon2id,
          memoryCost: 8192,
          timeCost: 2,
          parallelism: 1,
        });

        const user = await prisma().user.create({
          data: {
            email,
            fullName: 'Scope Platform Owner',
            passwordHash,
            status: 'ACTIVE',
            // Stands for an account that predates verification, which the
            // migration back-fills. Signing in is the point of the fixture.
            emailVerifiedAt: new Date(),
          },
          select: { id: true },
        });

        const platformRole = await prisma().role.findFirst({
          where: { key: PLATFORM_ROLE_KEY, organizationId: null, isSystem: true },
          select: { id: true },
        });

        await prisma().organizationUser.create({
          data: {
            organizationId: internal!.id,
            userId: user.id,
            roleId: platformRole!.id,
            status: 'ACTIVE',
            joinedAt: new Date(),
          },
        });

        return internal!.id;
      });

      const response = await login({ email, password: PASSWORD }).expect(200);
      const token = response.body.data.tokens.accessToken as string;

      expect(response.body.data.user.organization.id).toBe(internalId);

      /*
       * Signing in as the platform owner does not widen the Prisma tenant
       * scope. Ordinary endpoints still see only the organization the token is
       * scoped to — a customer's lead is a 404, exactly as it is for anybody
       * else. Cross-tenant reads happen only through the platform console.
       */
      await ctx
        .http()
        .get(`/api/v1/leads/${ctx.orgA.leadId}`)
        .set({ Authorization: `Bearer ${token}` })
        .expect(404);
    });
  });
});
