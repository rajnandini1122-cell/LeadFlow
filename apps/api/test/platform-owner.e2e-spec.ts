import { PERMISSIONS, PLATFORM_ROLE_KEY, ROLE_PERMISSION_MATRIX } from '@leadflow/api-types';
import {
  createTestContext,
  registerVerifiedOrganization,
  type TestContext,
} from './helpers/test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';

/**
 * CRAVION as the platform operator.
 *
 * The property under test is a BOUNDARY, so most of these are refusals. A
 * platform role that works is easy; a platform role that cannot be reached by
 * any customer, cannot be handed out by a tenant API, and does not quietly widen
 * the tenant scope is the thing worth proving.
 */
describe('Platform owner', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const prisma = () => ctx.app.get(PrismaService).client;

  const asSystem = async <T>(run: () => Promise<T>): Promise<T> =>
    ctx.app.get(TenantContextService).runAsSystem('e2e platform owner', run);

  /** CRAVION's organization and its platform owner, built the way bootstrap does. */
  let platform: { organizationId: string; token: string; userId: string };

  const PASSWORD = 'CorrectHorse!2026';

  /**
   * Claims the platform-organization slot before using it.
   *
   * At most one INTERNAL organization may exist database-wide, enforced by a
   * partial unique index, and the e2e database is shared between the suites
   * that legitimately create one. Suites run sequentially, so each one clears
   * the slot on entry rather than depending on which file Jest scheduled first
   * — the previous arrangement passed by ordering luck, which is a green run
   * waiting to go red for no visible reason.
   */
  const clearPlatformOrganizations = async (): Promise<void> => {
    await asSystem(async () => {
      const internal = await prisma().organization.findMany({
        where: { organizationType: 'INTERNAL' },
        select: { id: true },
      });

      for (const organization of internal) {
        await prisma().organizationUser.deleteMany({
          where: { organizationId: organization.id },
        });
        await prisma().organizationSettings.deleteMany({
          where: { organizationId: organization.id },
        });
        await prisma().organization.delete({ where: { id: organization.id } });
      }
    });
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    await clearPlatformOrganizations();
    platform = await seedPlatformOwner();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  /**
   * Creates the internal organization and a PLATFORM_OWNER membership.
   *
   * Written through the unextended client under a system scope, the way the
   * bootstrap command does — the point of this suite is what the HTTP surface
   * then allows, not how the rows got there.
   */
  async function seedPlatformOwner(): Promise<typeof platform> {
    const stamp = Date.now();
    const email = `platform.owner.${stamp}@cravion.test`;

    return asSystem(async () => {
      const role = await prisma().role.findFirst({
        where: { key: PLATFORM_ROLE_KEY, organizationId: null, isSystem: true },
        select: { id: true },
      });

      const organization = await prisma().organization.create({
        data: {
          name: 'CRAVION VENTURES (OPC) PRIVATE LIMITED',
          slug: `cravion-ventures-${stamp}`,
          organizationType: 'INTERNAL',
          status: 'ACTIVE',
          country: 'IN',
        },
        select: { id: true },
      });
      await prisma().organizationSettings.create({
        data: { organizationId: organization.id },
      });

      // The same argon2 parameters the suite's own fixtures use.
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
          fullName: 'Platform Owner',
          passwordHash,
          status: 'ACTIVE',
          // Stands for an account that predates verification, which the
          // migration back-fills. Signing in is the point of the fixture.
          emailVerifiedAt: new Date(),
        },
        select: { id: true },
      });

      await prisma().organizationUser.create({
        data: {
          organizationId: organization.id,
          userId: user.id,
          roleId: role!.id,
          status: 'ACTIVE',
          joinedAt: new Date(),
        },
      });

      const login = await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email, password: PASSWORD, platform: 'ANDROID' })
        .expect(200);

      return {
        organizationId: organization.id,
        userId: user.id,
        token: login.body.data.tokens.accessToken as string,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // A. The role itself
  // ---------------------------------------------------------------------------

  describe('the role', () => {
    it('exists as a system role owned by no organization', async () => {
      const role = await asSystem(() =>
        prisma().role.findFirst({
          where: { key: PLATFORM_ROLE_KEY },
          select: { organizationId: true, isSystem: true },
        }),
      );

      expect(role).toMatchObject({ organizationId: null, isSystem: true });
    });

    it('holds every platform permission', async () => {
      const granted = await asSystem(() =>
        prisma().role.findFirst({
          where: { key: PLATFORM_ROLE_KEY, organizationId: null, isSystem: true },
          select: { permissions: { select: { permission: { select: { key: true } } } } },
        }),
      );

      const keys = granted!.permissions.map((row) => row.permission.key);

      for (const permission of ROLE_PERMISSION_MATRIX.PLATFORM_OWNER) {
        expect(keys).toContain(permission);
      }
    });

    it('is the only role holding platform permissions', async () => {
      // A tenant role that picked one up would be a customer able to reach the
      // platform console, which is the failure this whole design exists to
      // prevent.
      const rows = await asSystem(() =>
        prisma().rolePermission.findMany({
          where: { permission: { key: { startsWith: 'platform.' } } },
          select: { role: { select: { key: true } } },
        }),
      );

      const holders = new Set(rows.map((row) => row.role.key));
      expect([...holders]).toEqual([PLATFORM_ROLE_KEY]);
    });
  });

  // ---------------------------------------------------------------------------
  // B. No tenant can grant it
  // ---------------------------------------------------------------------------

  describe('no tenant API can hand it out', () => {
    it('refuses an invitation to the platform role', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/users/invite')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          email: `escalation.${Date.now()}@example.test`,
          fullName: 'Would Be Platform Owner',
          role: PLATFORM_ROLE_KEY,
        });

      /*
       * 400, from the DTO. PLATFORM_OWNER is absent from ROLE_KEYS, which is
       * what the invite DTO validates against — so this is refused by the
       * types rather than by a rule somebody has to maintain.
       */
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('creates no membership when it refuses', async () => {
      const email = `escalation.check.${Date.now()}@example.test`;

      await ctx
        .http()
        .post('/api/v1/users/invite')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ email, fullName: 'Would Be', role: PLATFORM_ROLE_KEY });

      const user = await asSystem(() => prisma().user.findFirst({ where: { email } }));
      expect(user).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // C. Tenant safety — the important half
  // ---------------------------------------------------------------------------

  describe('tenant roles cannot reach the platform console', () => {
    it.each([
      ['an OWNER', () => ctx.orgA.owner.accessToken],
      ['a SALES_REP', () => ctx.orgA.rep.accessToken],
      ['another organization’s OWNER', () => ctx.orgB.owner.accessToken],
    ])('refuses %s', async (_label, token) => {
      const response = await ctx.http().get('/api/v1/platform/organizations').set(auth(token()));

      expect(response.status).toBe(403);
    });

    it('refuses a tenant OWNER attempting to suspend another organization', async () => {
      const response = await ctx
        .http()
        .post(`/api/v1/platform/organizations/${ctx.orgB.id}/suspend`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(403);

      // And nothing happened.
      const orgB = await asSystem(() =>
        prisma().organization.findFirst({
          where: { id: ctx.orgB.id },
          select: { status: true },
        }),
      );
      expect(orgB!.status).not.toBe('SUSPENDED');
    });

    it('refuses an unauthenticated request', async () => {
      await ctx.http().get('/api/v1/platform/organizations').expect(401);
    });
  });

  describe('the platform owner does not get a wider tenant scope', () => {
    it('sees only its own organization through ordinary tenant endpoints', async () => {
      /*
       * THE assertion of this suite.
       *
       * A platform owner's ordinary requests go through the same Prisma tenant
       * extension as anybody else's. If platform privilege widened that scope,
       * every repository in the application would become cross-tenant for one
       * caller — and a bug in any of them would leak a customer's pipeline.
       *
       * CRAVION's organization has no leads, so the honest answer is an empty
       * list, not Org A's and Org B's.
       */
      const response = await ctx
        .http()
        .get('/api/v1/leads')
        .set(auth(platform.token))
        .expect(200);

      const ids = (response.body.data.items ?? response.body.data).map(
        (lead: { id: string }) => lead.id,
      );

      expect(ids).not.toContain(ctx.orgA.leadId);
      expect(ids).not.toContain(ctx.orgB.leadId);
    });

    it('cannot read another organization’s lead by id', async () => {
      // 404, not 403: a tenant-scoped miss must not confirm the id exists.
      await ctx
        .http()
        .get(`/api/v1/leads/${ctx.orgA.leadId}`)
        .set(auth(platform.token))
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------------
  // D. What the platform owner CAN do
  // ---------------------------------------------------------------------------

  describe('the platform console', () => {
    it('lists every organization', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/platform/organizations')
        .set(auth(platform.token))
        .expect(200);

      const slugs = response.body.data.map((row: { id: string }) => row.id);
      expect(slugs).toContain(ctx.orgA.id);
      expect(slugs).toContain(ctx.orgB.id);
      expect(slugs).toContain(platform.organizationId);
    });

    it('reports counts but no business data', async () => {
      const response = await ctx
        .http()
        .get(`/api/v1/platform/organizations/${ctx.orgA.id}`)
        .set(auth(platform.token))
        .expect(200);

      expect(response.body.data).toMatchObject({
        id: ctx.orgA.id,
        organizationType: 'CUSTOMER',
      });
      expect(response.body.data.leadCount).toBeGreaterThanOrEqual(1);

      // Counts, not contents. No lead, contact or activity may appear here.
      const serialised = JSON.stringify(response.body.data);
      expect(serialised).not.toContain(ctx.orgA.leadId);
    });

    it('audits reading one organization, against the TARGET tenant', async () => {
      await ctx
        .http()
        .get(`/api/v1/platform/organizations/${ctx.orgB.id}`)
        .set(auth(platform.token))
        .expect(200);

      const entry = await asSystem(() =>
        prisma().auditLog.findFirst({
          where: { action: 'platform.organization_viewed', organizationId: ctx.orgB.id },
          orderBy: { createdAt: 'desc' },
          select: { actorUserId: true, organizationId: true, entityId: true },
        }),
      );

      /*
       * The row lands in the CUSTOMER's history, with the platform operator as
       * actor. A customer asking "who looked at our account" gets an answer,
       * which is the difference between an administrative power and an
       * unaccountable one.
       */
      expect(entry).toMatchObject({
        organizationId: ctx.orgB.id,
        actorUserId: platform.userId,
        entityId: ctx.orgB.id,
      });
    });

    it('suspends and reactivates a customer organization, auditing both', async () => {
      await ctx
        .http()
        .post(`/api/v1/platform/organizations/${ctx.orgB.id}/suspend`)
        .set(auth(platform.token))
        .expect(201);

      const suspended = await asSystem(() =>
        prisma().organization.findFirst({
          where: { id: ctx.orgB.id },
          select: { status: true },
        }),
      );
      expect(suspended!.status).toBe('SUSPENDED');

      await ctx
        .http()
        .post(`/api/v1/platform/organizations/${ctx.orgB.id}/reactivate`)
        .set(auth(platform.token))
        .expect(201);

      const actions = await asSystem(() =>
        prisma().auditLog.findMany({
          where: {
            organizationId: ctx.orgB.id,
            action: { in: ['platform.organization_suspended', 'platform.organization_reactivated'] },
          },
          select: { action: true },
        }),
      );

      expect(actions.map((row) => row.action).sort()).toEqual([
        'platform.organization_reactivated',
        'platform.organization_suspended',
      ]);
    });

    it('refuses to suspend the platform organization itself', async () => {
      const response = await ctx
        .http()
        .post(`/api/v1/platform/organizations/${platform.organizationId}/suspend`)
        .set(auth(platform.token));

      // Locking CRAVION out of the console it would need to undo it is not a
      // mistake worth leaving available.
      expect(response.status).toBe(400);

      const unchanged = await asSystem(() =>
        prisma().organization.findFirst({
          where: { id: platform.organizationId },
          select: { status: true },
        }),
      );
      expect(unchanged!.status).toBe('ACTIVE');
    });
  });

  // ---------------------------------------------------------------------------
  // E. Authentication and the current user
  // ---------------------------------------------------------------------------

  describe('authentication', () => {
    it('signs in through the ordinary login flow', async () => {
      // Already exercised by the fixture, asserted here so a failure names the
      // cause: no separate login path, no weakened validation.
      expect(platform.token).toBeTruthy();
    });

    it('identifies the platform role on the current-user endpoint', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/auth/me')
        .set(auth(platform.token))
        .expect(200);

      expect(response.body.data.role).toBe(PLATFORM_ROLE_KEY);
      expect(response.body.data.permissions).toContain(PERMISSIONS.PLATFORM_ORGANIZATION_VIEW);
    });

    it('still identifies an ordinary OWNER as OWNER', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/auth/me')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect(response.body.data.role).toBe('OWNER');
      expect(response.body.data.permissions).not.toContain(
        PERMISSIONS.PLATFORM_ORGANIZATION_VIEW,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // F. Entitlement
  // ---------------------------------------------------------------------------

  describe('entitlement', () => {
    it('grants the platform organization access with no subscription', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/subscriptions/entitlement')
        .set(auth(platform.token))
        .expect(200);

      expect(response.body.data).toMatchObject({
        source: 'PLATFORM_INTERNAL',
        grantsAccess: true,
        billable: false,
        maxUsers: null,
        maxActiveLeads: null,
        subscription: null,
      });
    });

    it('has no subscription row at all, and no trial to expire', async () => {
      const subscription = await asSystem(() =>
        prisma().subscription.findFirst({
          where: { organizationId: platform.organizationId },
        }),
      );

      /*
       * Nothing, deliberately. The alternative — a fabricated ACTIVE row with a
       * zero-price plan — asserts a payment that never happened and appears in
       * every revenue query as a customer.
       */
      expect(subscription).toBeNull();
    });

    /**
     * A customer created the way customers really are.
     *
     * Through registration, not through the harness fixture — the fixture
     * writes organizations directly and gives them no subscription, so it could
     * not tell "customers still get a trial" from "nobody gets anything".
     */
    const registerCustomer = async (): Promise<string> => {
      const stamp = `${Date.now()}.${Math.floor(Math.random() * 100_000)}`;

      const response = await registerVerifiedOrganization(ctx.app, {
        organizationName: `Entitlement Customer ${stamp}`,
        firstName: 'Entitled',
        lastName: 'Customer',
        email: `entitled.${stamp}@example.test`,
        password: 'Str0ng-Passphrase!2026',
      });

      return response.tokens.accessToken;
    };

    it('leaves a customer entitled by their subscription, and billable', async () => {
      const token = await registerCustomer();

      const response = await ctx
        .http()
        .get('/api/v1/subscriptions/entitlement')
        .set(auth(token))
        .expect(200);

      expect(response.body.data).toMatchObject({
        source: 'CUSTOMER_SUBSCRIPTION',
        billable: true,
        grantsAccess: true,
      });
      expect(response.body.data.subscription).not.toBeNull();
    });

    it('still starts an ordinary trial for a newly registered customer', async () => {
      const token = await registerCustomer();

      const response = await ctx
        .http()
        .get('/api/v1/subscriptions/current')
        .set(auth(token))
        .expect(200);

      // The customer lifecycle, untouched by any of this.
      expect(response.body.data.status).toBe('TRIAL');
      expect(response.body.data.grantsAccess).toBe(true);
      expect(response.body.data.trialEndsAt).not.toBeNull();
    });

    it('gives a newly registered customer OWNER, never the platform role', async () => {
      const token = await registerCustomer();

      const me = await ctx.http().get('/api/v1/auth/me').set(auth(token)).expect(200);

      expect(me.body.data.role).toBe('OWNER');
      expect(me.body.data.permissions).not.toContain(PERMISSIONS.PLATFORM_ORGANIZATION_VIEW);

      // And the console stays shut to them.
      await ctx.http().get('/api/v1/platform/organizations').set(auth(token)).expect(403);
    });
  });
});
