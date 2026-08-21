import { Prisma } from '../../generated/prisma/client';
import { TenantContextMissingError } from '../tenancy/tenancy.errors';

/**
 * Layer 2 of tenant isolation (see docs/tenancy.md).
 *
 * Every query against a tenant-owned model gets `organizationId` injected from
 * the active context — into the WHERE clause for reads and targeted writes, and
 * into the data for creates. Forgetting to scope a query is therefore not
 * possible through the normal Prisma API.
 *
 * Two properties matter more than the mechanics:
 *
 *   1. It FAILS CLOSED. No context means a throw, never an unscoped query.
 *   2. It cannot see raw SQL. `$queryRaw` and friends bypass this entirely,
 *      which is why they are banned by ESLint (see eslint.config.mjs).
 */

/**
 * Models owned by a tenant, mapped to the column that carries the tenant id.
 *
 * `Organization` is scoped by its own primary key: there is no organizationId
 * column on the organizations table, but reading another tenant's organization
 * row is exactly as much of a leak.
 *
 * Deliberately ABSENT, each for a specific reason:
 *   User            — global identity by design; one person, many organizations.
 *                     Scoped explicitly via OrganizationUser in UsersRepository.
 *   Role/Permission — system rows have organizationId = NULL and are shared.
 *   RolePermission  — join table over the above.
 *   AuditLog        — organizationId is nullable; a failed login against an
 *                     unknown email has no resolvable tenant. Written through
 *                     AuditService, which sets the tenant explicitly.
 *
 * Anything added here is covered automatically by the cross-tenant test suite.
 * Anything NOT here must be scoped by hand and must have its own test.
 */
export const TENANT_SCOPED_MODELS: Record<string, string> = {
  Organization: 'id',
  OrganizationSettings: 'organizationId',
  OrganizationUser: 'organizationId',
  Session: 'organizationId',
  Lead: 'organizationId',
  LeadActivity: 'organizationId',
  FollowUp: 'organizationId',
};

/** Operations whose `where` must be narrowed to the tenant. */
const WHERE_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
]);

/** Operations whose `data` must carry the tenant. */
const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);

export interface TenantScopeSource {
  /** Undefined when running as system, or when there is genuinely no tenant. */
  getOrganizationId(): string | undefined;
  isSystem(): boolean;
}

type AnyArgs = Record<string, unknown>;

function scopeWhere(args: AnyArgs, field: string, organizationId: string): void {
  const existing = args['where'] as Record<string, unknown> | undefined;

  // Prisma's extendedWhereUnique (GA since v5) allows non-unique filters
  // alongside a unique one, so findUnique/update/delete can be narrowed in
  // place without being rewritten into findFirst/updateMany.
  args['where'] = { ...(existing ?? {}), [field]: organizationId };
}

function scopeCreateData(args: AnyArgs, field: string, organizationId: string): void {
  const data = args['data'];

  if (Array.isArray(data)) {
    args['data'] = data.map((row: unknown) => ({
      ...(row as Record<string, unknown>),
      [field]: organizationId,
    }));
    return;
  }

  args['data'] = { ...((data as Record<string, unknown>) ?? {}), [field]: organizationId };
}

export interface ScopeInvocation {
  model?: string | undefined;
  operation: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
}

/**
 * The scoping decision itself, extracted from the Prisma wiring.
 *
 * Exported so the unit tests drive the REAL implementation rather than a
 * re-implementation of it — a test that mirrors the logic it is checking would
 * keep passing while the two silently diverged.
 */
export function createTenantScopeHandler(source: TenantScopeSource) {
  return async function applyTenantScope({
    model,
    operation,
    args,
    query,
  }: ScopeInvocation): Promise<unknown> {
    const field = model ? TENANT_SCOPED_MODELS[model] : undefined;

    // Not a tenant-owned model — nothing to scope.
    if (!field) return query(args);

    // Explicitly running cross-tenant, with a recorded reason.
    if (source.isSystem()) return query(args);

    const organizationId = source.getOrganizationId();
    if (!organizationId) {
      throw new TenantContextMissingError(
        `Refusing to run ${model}.${operation} with no tenant context. ` +
          `Use runWithTenant() for background work, or runAsSystem(reason) ` +
          `for deliberate cross-tenant access.`,
      );
    }

    const nextArgs = { ...((args as AnyArgs) ?? {}) };

    if (WHERE_OPERATIONS.has(operation)) {
      scopeWhere(nextArgs, field, organizationId);
    } else if (CREATE_OPERATIONS.has(operation)) {
      scopeCreateData(nextArgs, field, organizationId);
    } else if (operation === 'upsert') {
      scopeWhere(nextArgs, field, organizationId);
      const create = nextArgs['create'] as Record<string, unknown> | undefined;
      nextArgs['create'] = { ...(create ?? {}), [field]: organizationId };
    } else {
      // An operation we do not recognise could be a new Prisma feature that
      // reads tenant data. Refuse rather than guess.
      throw new TenantContextMissingError(
        `Unhandled Prisma operation "${operation}" on tenant model "${model}". ` +
          `Add it to tenant-scope.extension.ts before using it.`,
      );
    }

    return query(nextArgs);
  };
}

export function createTenantScopeExtension(source: TenantScopeSource) {
  const applyTenantScope = createTenantScopeHandler(source);

  return Prisma.defineExtension({
    name: 'leadflow-tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          return applyTenantScope({
            model,
            operation,
            args,
            query: (scoped) => query(scoped as typeof args),
          });
        },
      },
    },
  });
}
