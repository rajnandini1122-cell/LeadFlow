import {
  ALL_ROLE_KEYS,
  PERMISSIONS,
  ROLE_PERMISSION_MATRIX,
  type AnyRoleKey,
} from '@leadflow/api-types';
import type { PrismaClient } from '../src/generated/prisma/client';
import {
  PLAN_CATALOGUE,
  WITHDRAWN_PLAN_CODES,
} from '../src/modules/subscriptions/plan-catalogue';

/**
 * The reference data a LeadFlow database cannot function without.
 *
 * Permissions, the four system roles and their grants, and the plan catalogue.
 * None of it belongs to a tenant: these are global rows that the CODE defines,
 * and the database merely stores a copy of. That is why this is a sync rather
 * than a seed — running it again must converge, never duplicate.
 *
 * THE ONE CANONICAL DEFINITION. Both callers live in this repository and both
 * come here:
 *
 *   prisma/bootstrap.ts  production. Reference data and nothing else.
 *   prisma/seed.ts       development. This, and then demo organizations.
 *
 * Splitting it was not tidiness. A freshly migrated production database had no
 * system roles, so `POST /auth/register` failed on a missing OWNER — and the
 * only thing that created roles was the demo seed, which also creates demo
 * organizations with a default password. Production's only route to a working
 * database ran through demo data. Now it does not, and there is still one
 * definition of what a role is rather than two that can drift.
 *
 * Note what this deliberately does NOT do: it creates no organization, no
 * user, no membership and no business data of any kind. A tenant is created
 * through the application's supported registration flow, by a person, with a
 * password they chose.
 */

/**
 * Every role the database enum holds, including the platform one.
 *
 * Keyed by AnyRoleKey rather than RoleKey on purpose: reference bootstrap must
 * create PLATFORM_OWNER, while the tenant-assignable list stays shorter so no
 * invite form can offer it.
 */
const ROLE_DESCRIPTIONS: Record<AnyRoleKey, string> = {
  OWNER: 'Full company access: dashboard, team, leads, reports, settings, billing',
  ADMIN: 'Manage users, manage leads, configure company settings',
  MANAGER: 'View team, assign leads, monitor follow-ups, view team performance',
  SALES_REP: 'View and update assigned leads, log activity, schedule follow-ups',
  PLATFORM_OWNER:
    'CRAVION platform operator: manage customer organizations, platform configuration and operations',
};

/**
 * The client this file writes through: the plain, UNEXTENDED one.
 *
 * Both production callers own a bare `PrismaClient`, which is the right tool
 * here — none of these four tables is in TENANT_SCOPED_MODELS, because none of
 * them belongs to a tenant. Permissions and plans have no organization column
 * at all, and a system role is defined by having `organizationId: null`. There
 * is nothing for the tenant extension to scope, so there is no reason to carry
 * it.
 */
export type ReferenceDataClient = PrismaClient;

/** What a sync changed, for the caller to report. */
export interface ReferenceSummary {
  permissions: number;
  roles: number;
  plans: number;
  plansWithdrawn: number;
}

/** Where progress goes. Silent by default so tests are not noisy. */
export type ReferenceLogger = (message: string) => void;

/**
 * Brings permissions, system roles and plans into step with the code.
 *
 * Idempotent by construction, and each part says how:
 *   permissions  ON CONFLICT DO NOTHING on the unique key
 *   roles        found first, created only when absent
 *   plans        upserted on their unique code
 *
 * Takes the client rather than owning one, so the caller decides which
 * connection this runs through — which for production is deliberately not a
 * decision this file should be making.
 */
export async function syncReferenceData(
  prisma: ReferenceDataClient,
  log: ReferenceLogger = () => undefined,
): Promise<ReferenceSummary> {
  const permissionIds = await syncPermissions(prisma, log);
  const roles = await syncSystemRoles(prisma, permissionIds, log);
  const plans = await syncPlans(prisma, log);

  return {
    permissions: permissionIds.size,
    roles: roles.size,
    plans: plans.created,
    plansWithdrawn: plans.withdrawn,
  };
}

async function syncPermissions(
  prisma: ReferenceDataClient,
  log: ReferenceLogger,
): Promise<Map<string, string>> {
  await prisma.permission.createMany({
    data: Object.values(PERMISSIONS).map((key) => ({ key, description: describe(key) })),
    skipDuplicates: true,
  });

  const rows = await prisma.permission.findMany({ select: { id: true, key: true } });
  log(`  permissions: ${rows.length}`);

  return new Map(rows.map((row) => [row.key, row.id]));
}

async function syncSystemRoles(
  prisma: ReferenceDataClient,
  permissionIds: Map<string, string>,
  log: ReferenceLogger,
): Promise<Map<AnyRoleKey, string>> {
  const roleIds = new Map<AnyRoleKey, string>();

  // ALL roles, not the tenant-assignable subset: PLATFORM_OWNER is a system
  // role that must exist for the platform bootstrap to attach later.
  for (const key of ALL_ROLE_KEYS) {
    // System roles are shared by every tenant: organizationId is NULL.
    const existing = await prisma.role.findFirst({
      where: { key, organizationId: null, isSystem: true },
    });

    const role =
      existing ??
      (await prisma.role.create({
        data: {
          key,
          name: toTitleCase(key),
          description: ROLE_DESCRIPTIONS[key],
          isSystem: true,
          organizationId: null,
        },
      }));

    await prisma.rolePermission.createMany({
      data: ROLE_PERMISSION_MATRIX[key]
        .map((permissionKey) => permissionIds.get(permissionKey))
        .filter((id): id is string => Boolean(id))
        .map((permissionId) => ({ roleId: role.id, permissionId })),
      skipDuplicates: true,
    });

    roleIds.set(key, role.id);
    log(`  role ${key}: ${ROLE_PERMISSION_MATRIX[key].length} permissions`);
  }

  return roleIds;
}

async function syncPlans(
  prisma: ReferenceDataClient,
  log: ReferenceLogger,
): Promise<{ ids: Map<string, string>; created: number; withdrawn: number }> {
  const ids = new Map<string, string>();

  for (const plan of PLAN_CATALOGUE) {
    const fields = {
      name: plan.name,
      tagline: plan.tagline,
      description: plan.description,
      sortOrder: plan.sortOrder,
      featured: plan.featured,
      currency: plan.currency,
      monthlyPrice: plan.monthlyPrice,
      yearlyPrice: plan.yearlyPrice,
      maxUsers: plan.maxUsers,
      maxActiveLeads: plan.maxActiveLeads,
      features: plan.features,
      active: true,
    };

    const row = await prisma.plan.upsert({
      where: { code: plan.code },
      create: { code: plan.code, ...fields },
      update: fields,
      select: { id: true, code: true },
    });

    ids.set(row.code, row.id);
  }

  /*
   * Retire codes that are no longer offered.
   *
   * Deactivating leaves any organization still on one working while removing
   * it from the pricing page; deleting would orphan their subscription.
   */
  const retired = await prisma.plan.updateMany({
    where: { code: { in: WITHDRAWN_PLAN_CODES } },
    data: { active: false },
  });

  log(
    `  ${ids.size} plans in the catalogue` +
      (retired.count > 0 ? `, ${retired.count} withdrawn` : ''),
  );

  return { ids, created: ids.size, withdrawn: retired.count };
}

/** Plans, by code, for a caller that needs to attach a subscription. */
export async function planIdsByCode(prisma: ReferenceDataClient): Promise<Map<string, string>> {
  const rows = await prisma.plan.findMany({ select: { id: true, code: true } });
  return new Map(rows.map((row) => [row.code, row.id]));
}

/** System role ids, by key, for a caller that needs to grant one. */
export async function systemRoleIdsByKey(
  prisma: ReferenceDataClient,
): Promise<Map<AnyRoleKey, string>> {
  const rows = await prisma.role.findMany({
    where: { organizationId: null, isSystem: true },
    select: { id: true, key: true },
  });

  return new Map(rows.map((row) => [row.key as AnyRoleKey, row.id]));
}

function describe(key: string): string {
  const [resource, ...rest] = key.split('.');
  return `${rest.join(' ')} ${resource}`.trim();
}

function toTitleCase(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
