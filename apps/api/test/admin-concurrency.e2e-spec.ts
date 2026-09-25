import {
  createTestContext,
  PASSWORD,
  registerVerifiedOrganization,
  type TestContext,
} from './helpers/test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';

/**
 * Workstream 2 — an organization must never reach zero administrators.
 *
 * Before the fix, two administrators acting at the same instant each observed
 * the other still present, each concluded it was safe to proceed, and both
 * succeeded — leaving an organization nobody could ever administer again, with
 * no in-product way back.
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
describe('Last administrator invariant under concurrency', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
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
  // Workstream 2 — an organization must never reach zero administrators
  // ---------------------------------------------------------------------------

  describe('last administrator invariant', () => {
    interface Admin {
      userId: string;
      token: string;
    }

    /** An organization with exactly two owners, each holding a live token. */
    const orgWithTwoAdmins = async (): Promise<{
      organizationId: string;
      first: Admin;
      second: Admin;
    }> => {
      const founderEmail = `${unique('founder')}@example.test`;

      const registered = await registerVerifiedOrganization(ctx.app, {
        organizationName: `Admins ${unique('org')}`,
        email: founderEmail,
        password: PASSWORD,
        firstName: 'Ada',
        lastName: 'Admin',
      });

      const first: Admin = {
        userId: registered.registration.body.data.user.id as string,
        token: registered.tokens.accessToken,
      };

      const secondEmail = `${unique('coadmin')}@example.test`;
      const invite = await ctx
        .http()
        .post('/api/v1/users/invite')
        .set(auth(first.token))
        .send({ email: secondEmail, fullName: 'Bo Admin', role: 'OWNER' })
        .expect(201);

      await ctx
        .http()
        .post(`/api/v1/invitations/${invite.body.data.inviteToken}/accept`)
        .send({ firstName: 'Bo', lastName: 'Admin', password: PASSWORD })
        .expect(200);

      const login = await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email: secondEmail, password: PASSWORD, platform: 'WEB' })
        .expect(200);

      return {
        organizationId: registered.registration.body.data.user.organization.id as string,
        first,
        second: {
          userId: invite.body.data.userId as string,
          token: login.body.data.tokens.accessToken as string,
        },
      };
    };

    const activeAdminCount = async (organizationId: string): Promise<number> =>
      asSystem((prisma) =>
        prisma.organizationUser.count({
          where: {
            organizationId,
            status: 'ACTIVE',
            role: { key: { in: ['OWNER', 'ADMIN'] } },
          },
        }),
      );

    it('survives two administrators removing each other at the same time', async () => {
      const org = await orgWithTwoAdmins();

      // Each sees the other and concludes it is safe to proceed.
      const [a, b] = await Promise.all([
        ctx.http().delete(`/api/v1/users/${org.second.userId}`).set(auth(org.first.token)),
        ctx.http().delete(`/api/v1/users/${org.first.userId}`).set(auth(org.second.token)),
      ]);

      const remaining = await activeAdminCount(org.organizationId);

      // The invariant. Zero administrators is an organization nobody can ever
      // administer again, with no in-product way back.
      expect(remaining).toBeGreaterThanOrEqual(1);
      // At most one may have succeeded.
      expect([a.status, b.status].filter((status) => status === 204).length).toBeLessThanOrEqual(1);
    });

    it('survives two administrators demoting each other at the same time', async () => {
      const org = await orgWithTwoAdmins();

      const [a, b] = await Promise.all([
        ctx
          .http()
          .patch(`/api/v1/users/${org.second.userId}`)
          .set(auth(org.first.token))
          .send({ role: 'SALES_REP' }),
        ctx
          .http()
          .patch(`/api/v1/users/${org.first.userId}`)
          .set(auth(org.second.token))
          .send({ role: 'SALES_REP' }),
      ]);

      expect(await activeAdminCount(org.organizationId)).toBeGreaterThanOrEqual(1);
      expect([a.status, b.status].filter((status) => status === 200).length).toBeLessThanOrEqual(1);
    });

    it('survives one administrator leaving while the other is removed', async () => {
      const org = await orgWithTwoAdmins();

      const [leave, remove] = await Promise.all([
        ctx.http().post('/api/v1/organizations/leave').set(auth(org.first.token)).send({}),
        ctx.http().delete(`/api/v1/users/${org.second.userId}`).set(auth(org.first.token)),
      ]);

      expect(await activeAdminCount(org.organizationId)).toBeGreaterThanOrEqual(1);
      expect(leave.status).toBeGreaterThan(0);
      expect(remove.status).toBeGreaterThan(0);
    });

    it('survives concurrent suspension of both administrators', async () => {
      const org = await orgWithTwoAdmins();

      await Promise.all([
        ctx
          .http()
          .patch(`/api/v1/users/${org.second.userId}`)
          .set(auth(org.first.token))
          .send({ status: 'SUSPENDED' }),
        ctx
          .http()
          .patch(`/api/v1/users/${org.first.userId}`)
          .set(auth(org.second.token))
          .send({ status: 'SUSPENDED' }),
      ]);

      expect(await activeAdminCount(org.organizationId)).toBeGreaterThanOrEqual(1);
    });

    it('still allows an ordinary role change for a non-administrator', async () => {
      const org = await orgWithTwoAdmins();

      const repEmail = `${unique('rep')}@example.test`;
      const invite = await ctx
        .http()
        .post('/api/v1/users/invite')
        .set(auth(org.first.token))
        .send({ email: repEmail, fullName: 'Rae Rep', role: 'SALES_REP' })
        .expect(201);

      await ctx
        .http()
        .post(`/api/v1/invitations/${invite.body.data.inviteToken}/accept`)
        .send({ firstName: 'Rae', lastName: 'Rep', password: PASSWORD })
        .expect(200);

      // The invariant must not become a blanket lock on membership changes.
      const promoted = await ctx
        .http()
        .patch(`/api/v1/users/${invite.body.data.userId as string}`)
        .set(auth(org.first.token))
        .send({ role: 'MANAGER' })
        .expect(200);

      expect(promoted.body.data.role).toBe('MANAGER');
    });
  });
});
