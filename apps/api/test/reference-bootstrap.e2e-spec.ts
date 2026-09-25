import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ALL_ROLE_KEYS, PERMISSIONS, ROLE_PERMISSION_MATRIX } from '@leadflow/api-types';
import {
  createTestContext,
  registerVerifiedOrganization,
  type TestContext,
} from './helpers/test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { syncReferenceData } from '../prisma/reference-data';
import { PLAN_CATALOGUE } from '../src/modules/subscriptions/plan-catalogue';

/**
 * The reference data a fresh database needs, and the demo data it must not get.
 *
 * This covers a real defect: a freshly migrated production database had no
 * system roles, so `POST /auth/register` failed on a missing OWNER and a new
 * deployment could not create its first organization. The only thing that
 * created roles was the development seed — which also creates demo
 * organizations sharing one password. Production's only route to a working
 * database ran through demo data.
 *
 * Two properties are therefore load-bearing, and both are asserted here:
 * bootstrap creates everything registration needs, and bootstrap creates no
 * tenant data at all.
 */
describe('Production reference bootstrap', () => {
  let ctx: TestContext;

  const API_DIR = resolve(__dirname, '..');

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  /**
   * Bootstrap, running the same function production runs.
   *
   * Through the application's own client rather than a second connection. None
   * of the four reference tables is tenant-scoped — they have no organization
   * to scope BY — so the extension passes them through and this is byte-for-byte
   * the work `prisma/bootstrap.ts` does. Opening a second client would also
   * fail outright on the single-connection development database.
   */
  const bootstrap = () =>
    // Cast, and the reason it is sound rather than convenient: none of the four
    // reference tables is tenant-scoped, so the extension passes every one of
    // these writes through untouched and this performs exactly the work
    // `prisma/bootstrap.ts` performs with a bare client. The alternative — a
    // second connection — fails outright against the single-connection
    // development database, which is how this was found.
    syncReferenceData(prisma() as unknown as Parameters<typeof syncReferenceData>[0]);

  const prisma = () => ctx.app.get(PrismaService).client;

  /** Reference tables are global — no tenant owns them, so reads run as system. */
  const asSystem = async <T>(run: () => Promise<T>): Promise<T> =>
    ctx.app.get(TenantContextService).runAsSystem('e2e reference data', run);

  const counts = async () =>
    asSystem(async () => ({
      organizations: await prisma().organization.count(),
      users: await prisma().user.count(),
      roles: await prisma().role.count({ where: { organizationId: null, isSystem: true } }),
      permissions: await prisma().permission.count(),
      plans: await prisma().plan.count(),
    }));

  // ---------------------------------------------------------------------------
  // A. What a fresh database gets
  // ---------------------------------------------------------------------------

  describe('reference data', () => {
    it('creates every system role', async () => {
      const roles = await asSystem(() =>
        prisma().role.findMany({
          where: { organizationId: null, isSystem: true },
          select: { key: true },
        }),
      );

      /*
       * ALL_ROLE_KEYS, not ROLE_KEYS.
       *
       * Reference bootstrap creates every role the database enum holds,
       * including PLATFORM_OWNER. ROLE_KEYS is deliberately shorter — it is the
       * TENANT-ASSIGNABLE set that invite DTOs validate against — so asserting
       * against it here would require bootstrap to skip the platform role and
       * leave the CRAVION bootstrap with nothing to attach.
       */
      expect(roles.map((role) => role.key).sort()).toEqual([...ALL_ROLE_KEYS].sort());
    });

    it('creates every permission the code defines', async () => {
      const rows = await asSystem(() => prisma().permission.findMany({ select: { key: true } }));
      const stored = new Set(rows.map((row) => row.key));

      // Every permission in the catalogue, or a role grant below would silently
      // reference nothing and a screen would 403 for everybody.
      for (const key of Object.values(PERMISSIONS)) {
        expect(stored.has(key)).toBe(true);
      }
    });

    it('grants each system role exactly the matrix', async () => {
      for (const roleKey of ALL_ROLE_KEYS) {
        const role = await asSystem(() =>
          prisma().role.findFirst({
            where: { key: roleKey, organizationId: null, isSystem: true },
            select: {
              id: true,
              permissions: { select: { permission: { select: { key: true } } } },
            },
          }),
        );

        const granted = role!.permissions.map((row) => row.permission.key).sort();

        /*
         * EXACTLY, not "at least". A role holding a permission the matrix does
         * not grant is a privilege the code never reasoned about, and it would
         * be invisible — nothing fails, somebody simply can do more than
         * intended.
         */
        expect(granted).toEqual([...ROLE_PERMISSION_MATRIX[roleKey]].sort());
      }
    });

    it('creates the plan catalogue registration depends on', async () => {
      const plans = await asSystem(() => prisma().plan.findMany({ select: { code: true } }));
      const stored = new Set(plans.map((plan) => plan.code));

      // Registration starts a trial. With no plans the trial is silently
      // skipped and every new tenant is subscription-less.
      for (const plan of PLAN_CATALOGUE) {
        expect(stored.has(plan.code)).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // B. What it must never create
  // ---------------------------------------------------------------------------

  describe('creates no tenant data', () => {
    it('adds no organization and no user', async () => {
      const before = await counts();
      await bootstrap();
      const after = await counts();

      /*
       * The security property, stated as a delta so it holds on any database
       * rather than only an empty one. Bootstrap runs against production; if it
       * could create an organization or a user, it would be creating a tenant
       * nobody asked for and a credential nobody chose.
       */
      expect(after.organizations).toBe(before.organizations);
      expect(after.users).toBe(before.users);
    });

    it('creates none of the demo organizations', async () => {
      await bootstrap();

      const demo = await asSystem(() =>
        prisma().organization.findMany({
          where: { slug: { in: ['northwind-supply', 'meridian-foods'] } },
          select: { slug: true },
        }),
      );

      expect(demo).toEqual([]);
    });

    it('creates no memberships, leads or contacts', async () => {
      const before = await asSystem(async () => ({
        memberships: await prisma().organizationUser.count(),
        leads: await prisma().lead.count(),
        contacts: await prisma().contact.count(),
      }));

      await bootstrap();

      const after = await asSystem(async () => ({
        memberships: await prisma().organizationUser.count(),
        leads: await prisma().lead.count(),
        contacts: await prisma().contact.count(),
      }));

      expect(after).toEqual(before);
    });
  });

  // ---------------------------------------------------------------------------
  // C. Idempotency
  // ---------------------------------------------------------------------------

  describe('idempotency', () => {
    it('can run repeatedly without duplicating anything', async () => {
      // Three times, because the failure this guards against — a second run
      // inserting a parallel set of system roles — needs more than one repeat
      // to distinguish from a lucky first pass.
      await bootstrap();
      const first = await counts();

      await bootstrap();
      await bootstrap();
      const third = await counts();

      expect(third).toEqual(first);
    });

    it('keeps exactly one row per system role', async () => {
      await bootstrap();

      for (const key of ALL_ROLE_KEYS) {
        const rows = await asSystem(() =>
          prisma().role.count({ where: { key, organizationId: null, isSystem: true } }),
        );

        // A duplicate OWNER row would be worse than an error: registration
        // picks one with findFirst, so half the tenants would get a role whose
        // grants were reconciled and half one that was not.
        expect(rows).toBe(1);
      }
    });

    it('keeps exactly one row per permission and plan', async () => {
      await bootstrap();

      const permissions = await asSystem(() =>
        prisma().permission.findMany({ select: { key: true } }),
      );
      expect(new Set(permissions.map((p) => p.key)).size).toBe(permissions.length);

      const plans = await asSystem(() => prisma().plan.findMany({ select: { code: true } }));
      expect(new Set(plans.map((p) => p.code)).size).toBe(plans.length);
    });

    it('does not erase or rewrite tenant data', async () => {
      // The lead seeded by the harness must survive a bootstrap unchanged.
      const before = await asSystem(() =>
        prisma().lead.findFirst({ orderBy: { createdAt: 'asc' } }),
      );

      await bootstrap();

      const after = await asSystem(() =>
        prisma().lead.findFirst({ where: { id: before!.id } }),
      );

      expect(after).toEqual(before);
    });
  });

  // ---------------------------------------------------------------------------
  // D. The guards, as separate processes
  // ---------------------------------------------------------------------------

  describe('production guards', () => {
    /**
     * Runs a script with a DELIBERATELY UNUSABLE database URL.
     *
     * That is the assertion, not an accident. If a guard refuses before
     * connecting, the run fails with the guard's message. If the guard were
     * ever removed, the same run would instead fail trying to reach the
     * database — a different message — so "refused before any write" is
     * proven rather than assumed.
     */
    const run = (script: string, env: Record<string, string>) =>
      spawnSync('npx', ['tsx', script], {
        cwd: API_DIR,
        encoding: 'utf8',
        shell: true,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://unusable:unusable@127.0.0.1:1/nonexistent',
          DIRECT_DATABASE_URL: '',
          ...env,
        },
      });

    it('refuses to run the demo seed in production', () => {
      const result = run('prisma/seed.ts', {});

      expect(result.status).not.toBe(0);
      expect(`${result.stderr}${result.stdout}`).toMatch(/Refusing to seed/i);
    });

    it('refuses before writing any demo data', () => {
      const result = run('prisma/seed.ts', {});
      const output = `${result.stderr}${result.stdout}`;

      // Never reached the database: no connection error, and none of the
      // progress the seed prints once it starts working.
      expect(output).not.toMatch(/Seeding LeadFlow/);
      expect(output).not.toMatch(/ECONNREFUSED|getaddrinfo|Seed failed/);
      expect(output).toMatch(/db:bootstrap/);
    });

    it('requires the direct database URL when bootstrapping production', () => {
      const result = run('prisma/bootstrap.ts', {});

      // Fails closed rather than quietly using the pooled URL that is set.
      expect(result.status).not.toBe(0);
      expect(`${result.stderr}${result.stdout}`).toMatch(/DIRECT_DATABASE_URL must be set/);
    });

    it('never prints a connection string', () => {
      const output = [run('prisma/seed.ts', {}), run('prisma/bootstrap.ts', {})]
        .map((result) => `${result.stderr}${result.stdout}`)
        .join('\n');

      /*
       * A connection string carries the database password, and these run in CI
       * transcripts and deploy logs — places it is very hard to remove
       * something from afterwards.
       */
      expect(output).not.toMatch(/postgresql:\/\//);
      expect(output).not.toMatch(/unusable/);
    });
  });

  // ---------------------------------------------------------------------------
  // E. The contract this exists to restore
  // ---------------------------------------------------------------------------

  describe('registration prerequisite', () => {
    it('leaves the OWNER role resolvable', async () => {
      const owner = await asSystem(() =>
        prisma().role.findFirst({
          where: { key: 'OWNER', organizationId: null, isSystem: true },
          select: { id: true },
        }),
      );

      // The exact lookup RegistrationService performs. Without it registration
      // throws a 500 and a fresh deployment cannot create its first tenant.
      expect(owner).not.toBeNull();
    });

    it('registers a real organization end to end', async () => {
      const stamp = `${Date.now()}.${Math.floor(Math.random() * 100_000)}`;

      const created = await registerVerifiedOrganization(ctx.app, {
        organizationName: `Bootstrap Check ${stamp}`,
        firstName: 'Bootstrap',
        lastName: 'Owner',
        email: `owner.${stamp}@example.test`,
        password: 'Str0ng-Passphrase!2026',
      });

      /*
       * The whole point, proven through the supported endpoint rather than by
       * inspecting rows: after migrations and reference bootstrap, a real
       * organization can be created with an owner who chose their own password.
       * This is how CRAVION will be created — not by a script.
       */
      expect(created.registration.status).toBe(201);
      expect(created.registration.body.data.user.organization.name).toBe(
        `Bootstrap Check ${stamp}`,
      );
      expect(created.registration.body.data.user.role).toBe('OWNER');

      /*
       * Permissions are read once the owner is SIGNED IN, not off the
       * registration response — registration issues no session now, so it has
       * no permissions to report. Signing in proves more of the bootstrap
       * anyway: the OWNER role has to exist AND resolve to its permission
       * rows, which is exactly what a half-applied reference bootstrap breaks.
       */
      expect(created.user['permissions'] as string[]).not.toHaveLength(0);
    });

    it('still registers after bootstrap runs again', async () => {
      await bootstrap();

      const stamp = `${Date.now()}.${Math.floor(Math.random() * 100_000)}`;
      const response = await ctx
        .http()
        .post('/api/v1/auth/register')
        .send({
          organizationName: `Rebootstrap Check ${stamp}`,
          firstName: 'Rebootstrap',
          lastName: 'Owner',
          email: `owner2.${stamp}@example.test`,
          password: 'Str0ng-Passphrase!2026',
        });

      // A re-run must not have replaced the OWNER role with a new row that
      // existing memberships no longer point at.
      expect(response.status).toBe(201);
    });
  });
});
