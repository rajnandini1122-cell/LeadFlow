import 'dotenv/config';
import * as argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import {
  PERMISSIONS,
  ROLE_KEYS,
  ROLE_PERMISSION_MATRIX,
  type RoleKey,
} from '@idea001/api-types';

/**
 * Idempotent seed.
 *
 * Uses the UNEXTENDED PrismaClient deliberately: seeding writes across several
 * organizations, which the tenant-scoping extension exists to prevent. This is
 * the migration-time equivalent of runAsSystem().
 *
 * Safe to run repeatedly — every write is an upsert.
 */

const connectionString =
  process.env['DIRECT_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '';

if (!connectionString) {
  console.error('DATABASE_URL (or DIRECT_DATABASE_URL) must be set to seed.');
  process.exit(1);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const ROLE_DESCRIPTIONS: Record<RoleKey, string> = {
  OWNER: 'Full company access: dashboard, team, leads, reports, settings, billing',
  ADMIN: 'Manage users, manage leads, configure company settings',
  MANAGER: 'View team, assign leads, monitor follow-ups, view team performance',
  SALES_REP: 'View and update assigned leads, log activity, schedule follow-ups',
};

async function seedPermissions(): Promise<Map<string, string>> {
  const keys = Object.values(PERMISSIONS);

  await prisma.permission.createMany({
    data: keys.map((key) => ({ key, description: describePermission(key) })),
    skipDuplicates: true,
  });

  const rows = await prisma.permission.findMany({ select: { id: true, key: true } });
  console.log(`  permissions: ${rows.length}`);
  return new Map(rows.map((row) => [row.key, row.id]));
}

async function seedSystemRoles(permissionIds: Map<string, string>): Promise<void> {
  for (const key of ROLE_KEYS) {
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

    const permissions = ROLE_PERMISSION_MATRIX[key];
    await prisma.rolePermission.createMany({
      data: permissions
        .map((permissionKey) => permissionIds.get(permissionKey))
        .filter((id): id is string => Boolean(id))
        .map((permissionId) => ({ roleId: role.id, permissionId })),
      skipDuplicates: true,
    });

    console.log(`  role ${key}: ${permissions.length} permissions`);
  }
}

async function seedDemoOrganization(input: {
  name: string;
  slug: string;
  ownerEmail: string;
  ownerName: string;
  password: string;
}): Promise<void> {
  const organization = await prisma.organization.upsert({
    where: { slug: input.slug },
    create: { name: input.name, slug: input.slug, status: 'ACTIVE' },
    update: {},
  });

  await prisma.organizationSettings.upsert({
    where: { organizationId: organization.id },
    create: { organizationId: organization.id },
    update: {},
  });

  const passwordHash = await argon2.hash(input.password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  const user = await prisma.user.upsert({
    where: { email: input.ownerEmail },
    create: {
      email: input.ownerEmail,
      fullName: input.ownerName,
      passwordHash,
      status: 'ACTIVE',
    },
    update: { passwordHash, status: 'ACTIVE' },
  });

  const ownerRole = await prisma.role.findFirst({
    where: { key: 'OWNER', organizationId: null, isSystem: true },
  });
  if (!ownerRole) throw new Error('OWNER role missing — seed roles first');

  await prisma.organizationUser.upsert({
    where: {
      organizationId_userId: { organizationId: organization.id, userId: user.id },
    },
    create: {
      organizationId: organization.id,
      userId: user.id,
      roleId: ownerRole.id,
      status: 'ACTIVE',
      joinedAt: new Date(),
    },
    update: { status: 'ACTIVE' },
  });

  console.log(`  organization ${input.name} (${input.slug}) — owner ${input.ownerEmail}`);
}

async function main(): Promise<void> {
  console.log('Seeding IDEA001…');

  const permissionIds = await seedPermissions();
  await seedSystemRoles(permissionIds);

  // Two organizations, so cross-tenant isolation can be exercised by hand in
  // development the same way the e2e suite does automatically.
  const password = process.env['SEED_PASSWORD'] ?? 'ChangeMe!2026';

  await seedDemoOrganization({
    name: 'Cravion',
    slug: 'cravion',
    ownerEmail: 'owner@cravion.test',
    ownerName: 'Cravion Owner',
    password,
  });

  await seedDemoOrganization({
    name: 'ABC Foods',
    slug: 'abc-foods',
    ownerEmail: 'owner@abcfoods.test',
    ownerName: 'ABC Foods Owner',
    password,
  });

  console.log(`\nDone. Sign in with any owner email above and password: ${password}`);
  if (!process.env['SEED_PASSWORD']) {
    console.log('(Set SEED_PASSWORD to override. Never use this default outside development.)');
  }
}

function describePermission(key: string): string {
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

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
