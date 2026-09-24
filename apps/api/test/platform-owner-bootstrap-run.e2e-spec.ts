import { PLATFORM_ROLE_KEY } from '@leadflow/api-types';
import { createTestContext, type TestContext } from './helpers/test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import {
  PLATFORM_ORGANIZATION_NAME,
  PLATFORM_ORGANIZATION_SLUG,
  PlatformBootstrapError,
  bootstrapPlatformOwner,
  validateInputs,
} from '../prisma/platform-owner';

/**
 * The bootstrap logic, run against a real database.
 *
 * IN-PROCESS rather than by spawning the command. The first version of this
 * suite spawned it and hung: the development database serves one connection at a
 * time, and a child process asking for it while the suite holds it waits
 * forever. Splitting the logic out of the CLI is what made this testable
 * everywhere — the CLI's own input handling is covered by the spawn suite next
 * door.
 *
 * Most of these are REFUSALS, because this command runs against production with
 * shell access and its dangerous outcomes are not crashes — they are silent
 * successes.
 */
describe('Platform owner bootstrap logic', () => {
  let ctx: TestContext;

  const prisma = () => ctx.app.get(PrismaService).client;

  /**
   * Organizations and users are tenant-scoped, and this writes across tenants
   * the way the command does — so a system scope with a stated reason, which is
   * the project's sanctioned mechanism for exactly this.
   */
  const asSystem = async <T>(run: () => Promise<T>): Promise<T> =>
    ctx.app.get(TenantContextService).runAsSystem('e2e platform bootstrap', run);

  const ARGON = { memoryCost: 8192, timeCost: 2, parallelism: 1 };
  const PASSWORD = 'Str0ng-Platform-Passphrase!2026';

  const inputsFor = (email: string) => ({
    email,
    firstName: 'Platform',
    lastName: 'Owner',
    password: PASSWORD,
  });

  /** Runs the real logic through the app's client, cast the way reference data is. */
  const run = (email: string) =>
    asSystem(() =>
      bootstrapPlatformOwner(
        prisma() as unknown as Parameters<typeof bootstrapPlatformOwner>[0],
        inputsFor(email),
        ARGON,
      ),
    );

  const firstEmail = `platform.run.${Date.now()}@cravion.test`;

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
    // A FRESH bootstrap is what this suite asserts, so the slot must be empty:
    // reusing another suite's organization would report `existing` where these
    // tests expect `created`.
    await clearPlatformOrganizations();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ---------------------------------------------------------------------------
  // Input validation
  // ---------------------------------------------------------------------------

  describe('input validation', () => {
    it('refuses every missing input at once', () => {
      try {
        validateInputs({});
        throw new Error('should have refused');
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toMatch(/PLATFORM_OWNER_EMAIL/);
        expect(message).toMatch(/PLATFORM_OWNER_FIRST_NAME/);
        expect(message).toMatch(/PLATFORM_OWNER_LAST_NAME/);
        expect(message).toMatch(/PLATFORM_OWNER_PASSWORD/);
      }
    });

    it('refuses a malformed email', () => {
      expect(() => validateInputs({ ...inputsFor('not-an-email') })).toThrow(
        /must be a valid email address/i,
      );
    });

    it('refuses a short password without echoing it', () => {
      const weak = 'short123';

      try {
        validateInputs({ ...inputsFor('owner@cravion.test'), password: weak });
        throw new Error('should have refused');
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toMatch(/at least 12 characters/i);
        // The requirement is named; the value never is.
        expect(message).not.toContain(weak);
      }
    });

    it('normalises the email and trims the name', () => {
      const cleaned = validateInputs({
        email: '  Owner@CRAVION.TEST ',
        firstName: '  Platform ',
        lastName: ' Owner  ',
        password: PASSWORD,
      });

      expect(cleaned.email).toBe('owner@cravion.test');
      expect(cleaned.firstName).toBe('Platform');
      expect(cleaned.lastName).toBe('Owner');
    });
  });

  // ---------------------------------------------------------------------------
  // The happy path
  // ---------------------------------------------------------------------------

  describe('a fresh bootstrap', () => {
    it('creates the CRAVION internal organization and the master user', async () => {
      const result = await run(firstEmail);

      expect(result.organization.action).toBe('created');
      expect(result.organization.name).toBe(PLATFORM_ORGANIZATION_NAME);
      expect(result.user.action).toBe('created');
      expect(result.membership.action).toBe('created');
      expect(result.passwordUntouched).toBe(false);

      const organization = await asSystem(() =>
        prisma().organization.findFirst({
          where: { organizationType: 'INTERNAL' },
          select: { slug: true, status: true, country: true },
        }),
      );

      expect(organization).toMatchObject({
        slug: PLATFORM_ORGANIZATION_SLUG,
        // ACTIVE, not TRIAL: a trial is a customer lifecycle state with an end
        // date, and this organization has neither.
        status: 'ACTIVE',
        country: 'IN',
      });
    });

    it('attaches the PLATFORM_OWNER system role', async () => {
      const membership = await asSystem(() =>
        prisma().organizationUser.findFirst({
          where: { user: { email: firstEmail } },
          select: {
            status: true,
            role: { select: { key: true, isSystem: true, organizationId: true } },
            organization: { select: { organizationType: true } },
          },
        }),
      );

      expect(membership).toMatchObject({
        status: 'ACTIVE',
        role: { key: PLATFORM_ROLE_KEY, isSystem: true, organizationId: null },
        organization: { organizationType: 'INTERNAL' },
      });
    });

    it('creates organization settings, as registration does', async () => {
      const settings = await asSystem(() =>
        prisma().organizationSettings.findFirst({
          where: { organization: { organizationType: 'INTERNAL' } },
          select: { organizationId: true },
        }),
      );

      expect(settings).not.toBeNull();
    });

    it('creates NO subscription — the entitlement is the organization type', async () => {
      const subscription = await asSystem(() =>
        prisma().subscription.findFirst({
          where: { organization: { organizationType: 'INTERNAL' } },
        }),
      );

      /*
       * Nothing, and nothing is correct. A fabricated ACTIVE row with a
       * zero-price plan would assert a payment that never happened and appear
       * in every revenue query as a customer.
       */
      expect(subscription).toBeNull();
    });

    it('creates no demo organization and no demo user', async () => {
      const demo = await asSystem(() =>
        prisma().organization.findMany({
          where: { slug: { in: ['northwind-supply', 'meridian-foods'] } },
          select: { slug: true },
        }),
      );

      expect(demo).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Idempotency
  // ---------------------------------------------------------------------------

  describe('idempotency', () => {
    it('changes nothing on a second and third run', async () => {
      const snapshot = async () =>
        asSystem(async () => ({
          internalOrganizations: await prisma().organization.count({
            where: { organizationType: 'INTERNAL' },
          }),
          users: await prisma().user.count({ where: { email: firstEmail } }),
          memberships: await prisma().organizationUser.count({
            where: { user: { email: firstEmail } },
          }),
          passwordHash: (
            await prisma().user.findFirst({
              where: { email: firstEmail },
              select: { passwordHash: true },
            })
          )?.passwordHash,
        }));

      const before = await snapshot();

      const second = await run(firstEmail);
      const third = await run(firstEmail);

      expect(second.organization.action).toBe('existing');
      expect(second.user.action).toBe('existing');
      expect(third.membership.action).toBe('existing');

      const after = await snapshot();

      expect(after).toEqual(before);
      expect(after.internalOrganizations).toBe(1);
    });

    it('never rewrites an existing password', async () => {
      const before = await asSystem(() =>
        prisma().user.findFirst({
          where: { email: firstEmail },
          select: { passwordHash: true },
        }),
      );

      const result = await run(firstEmail);

      const after = await asSystem(() =>
        prisma().user.findFirst({
          where: { email: firstEmail },
          select: { passwordHash: true },
        }),
      );

      /*
       * THE assertion of this file.
       *
       * A re-run that reset the password would be a password-reset tool wearing
       * a bootstrap's name: usable by anybody with shell access to take over the
       * master account, and indistinguishable from an ordinary idempotent run in
       * any log.
       */
      expect(after!.passwordHash).toBe(before!.passwordHash);
      expect(result.passwordUntouched).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Refusals — the outcomes that must never happen quietly
  // ---------------------------------------------------------------------------

  describe('refusals', () => {
    it('refuses to adopt a DIFFERENT user as the platform owner silently', async () => {
      /*
       * A second email against the already-bootstrapped organization.
       *
       * This is allowed and is the supported way to add a second CRAVION
       * operator — but it must be visible in the result rather than looking like
       * a no-op, so the action says `created` for the user and the membership.
       */
      const second = `platform.second.${Date.now()}@cravion.test`;
      const result = await run(second);

      expect(result.organization.action).toBe('existing');
      expect(result.user.action).toBe('created');
      expect(result.membership.action).toBe('created');
    });

    it('refuses a suspended existing user rather than reactivating them', async () => {
      const email = `platform.suspended.${Date.now()}@cravion.test`;

      await asSystem(() =>
        prisma().user.create({
          data: {
            email,
            fullName: 'Suspended Person',
            passwordHash: 'not-a-real-hash',
            status: 'SUSPENDED',
          },
        }),
      );

      // Reactivating an account is a deliberate act, not a side effect of a
      // bootstrap somebody re-ran.
      await expect(run(email)).rejects.toThrow(PlatformBootstrapError);
      await expect(run(email)).rejects.toThrow(/exists but is SUSPENDED/i);
    });

    it('refuses to convert an existing customer organization', async () => {
      /*
       * The single most dangerous silent success available to this command:
       * turning a paying customer's organization into the platform operator
       * would hand that tenant's owner administrative access to every other
       * customer.
       *
       * Proven by deleting the internal organization and leaving a customer
       * holding the slug, which is the state that would tempt a suffix.
       */
      const internal = await asSystem(() =>
        prisma().organization.findFirst({
          where: { organizationType: 'INTERNAL' },
          select: { id: true },
        }),
      );

      await asSystem(async () => {
        // Detach the memberships first: the fixture only needs the slug free.
        await prisma().organizationUser.deleteMany({
          where: { organizationId: internal!.id },
        });
        await prisma().organizationSettings.deleteMany({
          where: { organizationId: internal!.id },
        });
        await prisma().organization.delete({ where: { id: internal!.id } });

        await prisma().organization.create({
          data: {
            name: 'Unrelated Customer Holding The Slug',
            slug: PLATFORM_ORGANIZATION_SLUG,
            organizationType: 'CUSTOMER',
            status: 'ACTIVE',
          },
        });
      });

      await expect(run(`platform.collision.${Date.now()}@cravion.test`)).rejects.toThrow(
        /already exists and is not the platform organization/i,
      );

      // And the customer is untouched — still a customer.
      const customer = await asSystem(() =>
        prisma().organization.findFirst({
          where: { slug: PLATFORM_ORGANIZATION_SLUG },
          select: { organizationType: true },
        }),
      );
      expect(customer!.organizationType).toBe('CUSTOMER');
    });
  });
});
