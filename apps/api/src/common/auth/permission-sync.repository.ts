import { Injectable } from '@nestjs/common';
import { PERMISSIONS, ROLE_PERMISSION_MATRIX, type RoleKey } from '@leadflow/api-types';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../tenancy/tenant-context.service';

/**
 * Keeps the database's permission catalogue in step with the code's.
 *
 * This exists because of a bug the post-deploy smoke test caught on its first
 * run against a real database: a release that ADDS a permission grants it to
 * nobody. `prisma/seed.ts` populates `permissions` and `role_permissions` once,
 * at seed time. Adding five account.* permissions to ROLE_PERMISSION_MATRIX
 * therefore left every existing organization with a 403 on the Customers
 * screen, while the whole E2E suite stayed green — because tests seed a fresh
 * database from the CURRENT matrix, and production has a database seeded
 * months ago.
 *
 * That divergence is structural. A test suite cannot catch it, so the fix has
 * to be that the database is reconciled on every boot rather than once.
 *
 * SYSTEM roles only. Those are global rows (`organizationId: null`,
 * `isSystem: true`) shared by every tenant, and the matrix in code IS their
 * definition. A role a tenant created for themselves is their configuration and
 * is never touched here.
 */
@Injectable()
export class PermissionSyncRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Reconciles catalogue and system-role grants.
   *
   * Runs cross-tenant by necessity: `permissions` and the system `roles` are
   * global tables with no organization_id, and there is no request context at
   * boot. Reads and writes nothing tenant-owned — the reason is stated to
   * `runAsSystem`, as the architecture requires.
   *
   * Idempotent, so several replicas booting together converge rather than
   * conflict.
   */
  async sync(): Promise<{ permissionsAdded: number; grantsAdded: number; grantsRemoved: number }> {
    return this.tenantContext.runAsSystem(
      'startup: reconcile the global permission catalogue and system role grants',
      async () => {
        const catalogue = Object.values(PERMISSIONS);

        // 1. Every permission the code knows about must exist as a row.
        const before = await this.prisma.client.permission.count();

        await this.prisma.client.permission.createMany({
          data: catalogue.map((key) => ({ key, description: null })),
          skipDuplicates: true,
        });

        const permissionRows = await this.prisma.client.permission.findMany({
          select: { id: true, key: true },
        });
        const idByKey = new Map(permissionRows.map((row) => [row.key, row.id]));

        const permissionsAdded = permissionRows.length - before;

        // 2. System role grants must match the matrix exactly.
        let grantsAdded = 0;
        let grantsRemoved = 0;

        for (const roleKey of Object.keys(ROLE_PERMISSION_MATRIX) as RoleKey[]) {
          const role = await this.prisma.client.role.findFirst({
            where: { key: roleKey, organizationId: null, isSystem: true },
            select: { id: true },
          });

          // A database that has never been seeded has no system roles. Seeding
          // is a separate, deliberate step; this only reconciles what exists.
          if (!role) continue;

          const wanted = new Set(
            ROLE_PERMISSION_MATRIX[roleKey]
              .map((key) => idByKey.get(key))
              .filter((id): id is string => Boolean(id)),
          );

          const current = await this.prisma.client.rolePermission.findMany({
            where: { roleId: role.id },
            select: { permissionId: true },
          });
          const held = new Set(current.map((row) => row.permissionId));

          const missing = [...wanted].filter((id) => !held.has(id));
          if (missing.length > 0) {
            await this.prisma.client.rolePermission.createMany({
              data: missing.map((permissionId) => ({ roleId: role.id, permissionId })),
              skipDuplicates: true,
            });
            grantsAdded += missing.length;
          }

          /*
           * Grants REMOVED from the matrix are revoked.
           *
           * Add-only would be safer to reason about and wrong in the case that
           * matters: taking a permission away from a role is how a privilege is
           * tightened after a security review, and an add-only sync would leave
           * every existing tenant holding it forever.
           *
           * Safe because this touches system roles only — global rows whose
           * definition is the matrix. A tenant's own custom role is never in
           * this loop.
           */
          const extra = [...held].filter((id) => !wanted.has(id));
          if (extra.length > 0) {
            const removed = await this.prisma.client.rolePermission.deleteMany({
              where: { roleId: role.id, permissionId: { in: extra } },
            });
            grantsRemoved += removed.count;
          }
        }

        return { permissionsAdded, grantsAdded, grantsRemoved };
      },
    );
  }
}
