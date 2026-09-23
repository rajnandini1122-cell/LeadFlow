import { createTestContext, type TestContext } from './helpers/test-app';
import { PermissionSyncRepository } from '../src/common/auth/permission-sync.repository';
// Permission, Role and RolePermission are deliberately NOT tenant-scoped —
// they are global catalogue tables — so the extended client reaches them
// directly without an escape hatch.
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PERMISSIONS, ROLE_PERMISSION_MATRIX } from '@leadflow/api-types';

/**
 * Permission catalogue reconciliation.
 *
 * This exists because of a bug the post-deploy smoke test caught on its first
 * run: a release that ADDS a permission grants it to nobody. The seed populates
 * `permissions` and `role_permissions` once, so adding five account.*
 * permissions to the matrix left every existing organization with a 403 on the
 * Customers screen — while the entire E2E suite stayed green.
 *
 * The suite could not have caught it. Tests seed a fresh database from the
 * CURRENT matrix; production runs against a database seeded months ago. That
 * divergence is structural, which is why the fix is reconciliation at boot
 * rather than a better test of the seed.
 *
 * These tests therefore simulate the production shape deliberately: they
 * REMOVE grants from an already-seeded database and assert the sync restores
 * them.
 */
describe('Permission sync', () => {
  let ctx: TestContext;
  let sync: PermissionSyncRepository;
  let prisma: PrismaService;

  beforeAll(async () => {
    ctx = await createTestContext();
    sync = ctx.app.get(PermissionSyncRepository);
    prisma = ctx.app.get(PrismaService);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('leaves an already-reconciled database alone', async () => {
    // Idempotence. Several replicas booting together must converge, not fight.
    const first = await sync.sync();
    const second = await sync.sync();

    expect(second.permissionsAdded).toBe(0);
    expect(second.grantsAdded).toBe(0);
    expect(second.grantsRemoved).toBe(0);
    expect(first).toBeDefined();
  });

  it('restores a grant that is missing from a system role', async () => {
    /*
     * The production case, reproduced. An older database has the role and the
     * permission row, but not the link between them — exactly what happens when
     * a release adds a permission to an existing tenant.
     */
    const removed = await (async () => {
      const role = await prisma.client.role.findFirst({
        where: { key: 'OWNER', organizationId: null, isSystem: true },
        select: { id: true },
      });
      const permission = await prisma.client.permission.findFirst({
        where: { key: PERMISSIONS.ACCOUNT_VIEW },
        select: { id: true },
      });

      if (!role || !permission) return null;

      await prisma.client.rolePermission.deleteMany({
        where: { roleId: role.id, permissionId: permission.id },
      });

      return { roleId: role.id, permissionId: permission.id };
    })();

    if (!removed) return;

    const result = await sync.sync();
    expect(result.grantsAdded).toBeGreaterThan(0);

    const restored = await (async () =>
      prisma.client.rolePermission.count({
        where: { roleId: removed.roleId, permissionId: removed.permissionId },
      }))();

    expect(restored).toBe(1);
  });

  it('grants EVERY permission the matrix gives OWNER', async () => {
    // The assertion that would have caught the original bug.
    await sync.sync();

    const held = await (async () => {
      const role = await prisma.client.role.findFirst({
        where: { key: 'OWNER', organizationId: null, isSystem: true },
        select: { id: true },
      });
      if (!role) return [];

      const rows = await prisma.client.rolePermission.findMany({
        where: { roleId: role.id },
        select: { permission: { select: { key: true } } },
      });

      return rows.map((row) => row.permission.key);
    })();

    for (const permission of ROLE_PERMISSION_MATRIX.OWNER) {
      expect(held).toContain(permission);
    }
  });

  it('REVOKES a grant the matrix no longer contains', async () => {
    /*
     * Add-only would be safer to reason about and wrong where it matters:
     * taking a permission away from a role is how a privilege is tightened
     * after a security review, and add-only would leave every existing tenant
     * holding it forever.
     */
    const planted = await (async () => {
      const role = await prisma.client.role.findFirst({
        where: { key: 'SALES_REP', organizationId: null, isSystem: true },
        select: { id: true },
      });
      // A permission a sales rep must never have.
      const permission = await prisma.client.permission.findFirst({
        where: { key: PERMISSIONS.ACCOUNT_MERGE },
        select: { id: true },
      });

      if (!role || !permission) return null;

      await prisma.client.rolePermission.createMany({
        data: [{ roleId: role.id, permissionId: permission.id }],
        skipDuplicates: true,
      });

      return { roleId: role.id, permissionId: permission.id };
    })();

    if (!planted) return;

    const result = await sync.sync();
    expect(result.grantsRemoved).toBeGreaterThan(0);

    const remaining = await (async () =>
      prisma.client.rolePermission.count({
        where: { roleId: planted.roleId, permissionId: planted.permissionId },
      }))();

    expect(remaining).toBe(0);
  });

  it('does NOT touch a role a tenant created for themselves', async () => {
    /*
     * The safety boundary. System roles are global rows whose definition is the
     * matrix; a custom role is a tenant's own configuration and reconciling it
     * would silently rewrite their access control.
     */
    const custom = await (async () => {
      const permission = await prisma.client.permission.findFirst({
        where: { key: PERMISSIONS.ACCOUNT_MERGE },
        select: { id: true },
      });
      if (!permission) return null;

      const role = await prisma.client.role.create({
        data: {
          key: 'SALES_REP',
          name: 'Custom Rep',
          isSystem: false,
          organizationId: ctx.orgA.id,
        },
        select: { id: true },
      });

      await prisma.client.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id },
      });

      return { roleId: role.id, permissionId: permission.id };
    })();

    if (!custom) return;

    await sync.sync();

    const untouched = await (async () =>
      prisma.client.rolePermission.count({
        where: { roleId: custom.roleId, permissionId: custom.permissionId },
      }))();

    // Still exactly as the tenant configured it.
    expect(untouched).toBe(1);
  });
});
