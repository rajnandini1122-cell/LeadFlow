import { createTenantScopeHandler, TENANT_SCOPED_MODELS } from './tenant-scope.extension';
import { TenantContextMissingError } from '../tenancy/tenancy.errors';

/**
 * Drives the REAL scoping handler — the same function the Prisma extension
 * installs — with a stubbed `query` so no database is needed.
 *
 * These assertions are the specification of tenant isolation. If one of them
 * fails, tenant data is leaking.
 */

const ORG = '01a01d8b-0000-7000-8000-000000000001';
const OTHER_ORG = '01a01d8b-0000-7000-8000-000000000002';

const inTenant = (organizationId: string | undefined, isSystem = false) =>
  createTenantScopeHandler({
    getOrganizationId: () => organizationId,
    isSystem: () => isSystem,
  });

describe('tenant scope extension', () => {
  describe('fail-closed behaviour', () => {
    it('throws rather than running an unscoped query when there is no context', async () => {
      const handler = inTenant(undefined);
      const query = jest.fn();

      await expect(
        handler({ model: 'Lead', operation: 'findMany', args: {}, query }),
      ).rejects.toBeInstanceOf(TenantContextMissingError);

      // The critical assertion: the query never ran. Returning every tenant's
      // rows would be worse than any error.
      expect(query).not.toHaveBeenCalled();
    });

    it('throws on an unrecognised operation instead of passing it through unscoped', async () => {
      const handler = inTenant(ORG);
      const query = jest.fn();

      await expect(
        handler({ model: 'Lead', operation: 'someFutureOperation', args: {}, query }),
      ).rejects.toBeInstanceOf(TenantContextMissingError);
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('read scoping', () => {
    it.each([
      'findUnique',
      'findUniqueOrThrow',
      'findFirst',
      'findFirstOrThrow',
      'findMany',
      'count',
      'aggregate',
      'groupBy',
    ])('injects organizationId into %s', async (operation) => {
      const handler = inTenant(ORG);
      const query = jest.fn().mockResolvedValue(null);

      await handler({ model: 'Lead', operation, args: { where: { id: 'lead-1' } }, query });

      expect(query).toHaveBeenCalledWith({ where: { id: 'lead-1', organizationId: ORG } });
    });

    it('adds a where clause when the caller supplied none', async () => {
      const handler = inTenant(ORG);
      const query = jest.fn().mockResolvedValue([]);

      await handler({ model: 'Lead', operation: 'findMany', args: {}, query });

      expect(query).toHaveBeenCalledWith({ where: { organizationId: ORG } });
    });

    it('overrides a caller-supplied organizationId rather than trusting it', async () => {
      const handler = inTenant(ORG);
      const query = jest.fn().mockResolvedValue([]);

      // Even if something upstream let a foreign id through, the active
      // context wins because it is applied last.
      await handler({
        model: 'Lead',
        operation: 'findMany',
        args: { where: { organizationId: OTHER_ORG } },
        query,
      });

      expect(query).toHaveBeenCalledWith({ where: { organizationId: ORG } });
    });
  });

  describe('write scoping', () => {
    it.each(['update', 'updateMany', 'delete', 'deleteMany'])(
      'narrows %s to the active tenant',
      async (operation) => {
        const handler = inTenant(ORG);
        const query = jest.fn().mockResolvedValue({ count: 0 });

        await handler({ model: 'Lead', operation, args: { where: { id: 'lead-1' } }, query });

        expect(query).toHaveBeenCalledWith({ where: { id: 'lead-1', organizationId: ORG } });
      },
    );

    it('stamps the tenant onto create data', async () => {
      const handler = inTenant(ORG);
      const query = jest.fn().mockResolvedValue({});

      await handler({
        model: 'Lead',
        operation: 'create',
        args: { data: { leadNumber: 'LD-1' } },
        query,
      });

      expect(query).toHaveBeenCalledWith({
        data: { leadNumber: 'LD-1', organizationId: ORG },
      });
    });

    it('stamps the tenant onto every row of a createMany', async () => {
      const handler = inTenant(ORG);
      const query = jest.fn().mockResolvedValue({ count: 2 });

      await handler({
        model: 'Lead',
        operation: 'createMany',
        args: { data: [{ leadNumber: 'LD-1' }, { leadNumber: 'LD-2' }] },
        query,
      });

      expect(query).toHaveBeenCalledWith({
        data: [
          { leadNumber: 'LD-1', organizationId: ORG },
          { leadNumber: 'LD-2', organizationId: ORG },
        ],
      });
    });

    it('rejects a create that tries to name another tenant', async () => {
      const handler = inTenant(ORG);
      const query = jest.fn().mockResolvedValue({});

      await handler({
        model: 'Lead',
        operation: 'create',
        args: { data: { leadNumber: 'LD-1', organizationId: OTHER_ORG } },
        query,
      });

      const passed = query.mock.calls[0]?.[0] as { data: { organizationId: string } };
      expect(passed.data.organizationId).toBe(ORG);
    });

    it('scopes both halves of an upsert', async () => {
      const handler = inTenant(ORG);
      const query = jest.fn().mockResolvedValue({});

      await handler({
        model: 'Lead',
        operation: 'upsert',
        args: { where: { id: 'lead-1' }, create: { leadNumber: 'LD-1' }, update: {} },
        query,
      });

      expect(query).toHaveBeenCalledWith({
        where: { id: 'lead-1', organizationId: ORG },
        create: { leadNumber: 'LD-1', organizationId: ORG },
        update: {},
      });
    });
  });

  describe('model coverage', () => {
    it('scopes Organization by its own primary key, not by organizationId', async () => {
      const handler = inTenant(ORG);
      const query = jest.fn().mockResolvedValue(null);

      await handler({ model: 'Organization', operation: 'findFirst', args: {}, query });

      // organizations has no organizationId column; the tenant IS the row.
      expect(query).toHaveBeenCalledWith({ where: { id: ORG } });
    });

    it.each(Object.keys(TENANT_SCOPED_MODELS))('scopes %s', async (model) => {
      const handler = inTenant(ORG);
      const query = jest.fn().mockResolvedValue(null);

      await handler({ model, operation: 'findMany', args: {}, query });

      const passed = query.mock.calls[0]?.[0] as { where: Record<string, unknown> };
      expect(passed.where[TENANT_SCOPED_MODELS[model] as string]).toBe(ORG);
    });

    it.each(['User', 'Role', 'Permission', 'RolePermission', 'AuditLog'])(
      'leaves the deliberately global model %s untouched',
      async (model) => {
        const handler = inTenant(ORG);
        const query = jest.fn().mockResolvedValue(null);

        await handler({ model, operation: 'findMany', args: { where: { x: 1 } }, query });

        // These are scoped explicitly by their repositories instead — see the
        // comment block in tenant-scope.extension.ts for why each is excluded.
        expect(query).toHaveBeenCalledWith({ where: { x: 1 } });
      },
    );
  });

  describe('system context', () => {
    it('passes through unscoped when explicitly running as system', async () => {
      const handler = inTenant(undefined, true);
      const query = jest.fn().mockResolvedValue([]);

      await handler({ model: 'Lead', operation: 'findMany', args: {}, query });

      expect(query).toHaveBeenCalledWith({});
    });
  });
});
