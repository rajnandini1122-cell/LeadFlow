import { ValidationPipe, VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import * as argon2 from 'argon2';
import request from 'supertest';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PERMISSIONS,
  ROLE_KEYS,
  ROLE_PERMISSION_MATRIX,
  type RoleKey,
} from '@leadflow/api-types';
import { AppModule } from '../../src/app.module';
import { RedisService } from '../../src/common/redis/redis.service';
import { PrismaClient } from '../../src/generated/prisma/client';
import { InMemoryRedis, asRedisService } from './in-memory-redis';

export interface SeededUser {
  id: string;
  email: string;
  role: RoleKey;
  accessToken: string;
  refreshToken: string;
}

export interface SeededOrg {
  id: string;
  name: string;
  slug: string;
  owner: SeededUser;
  rep: SeededUser;
  leadId: string;
}

export interface TestContext {
  app: INestApplication;
  redis: InMemoryRedis;
  orgA: SeededOrg;
  orgB: SeededOrg;
  http: () => request.Agent;
  close: () => Promise<void>;
}

const PASSWORD = 'CorrectHorse!2026';

/**
 * Raw client used only for seeding.
 *
 * Deliberately UNEXTENDED: seeding writes across two organizations, which is
 * precisely what the tenant-scoping extension exists to prevent. Tests must set
 * up cross-tenant fixtures through this, and then exercise the application
 * through HTTP where the scoping is live.
 */
function seedClient(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env['DATABASE_URL'] as string,
      max: 1,
    }),
  });
}

/**
 * Waits for PGlite's single connection slot to become free.
 *
 * Jest gives each spec file its own module registry, so each one builds its own
 * application and its own pool. PGlite accepts one connection at a time and the
 * previous file's pool is not always fully torn down the instant `app.close()`
 * resolves, so the next file can find the slot still occupied.
 *
 * Retrying is the honest fix: against a real Postgres the first attempt always
 * succeeds and this costs nothing.
 */
async function connectWithRetry(prisma: PrismaClient, attempts = 25): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await prisma.permission.count();
      return;
    } catch (error) {
      const message = (error as Error).message;
      const contention =
        message.includes('closed the connection') ||
        message.includes('ECONNRESET') ||
        message.includes("Can't reach database");

      if (!contention || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

async function seedRolesAndPermissions(prisma: PrismaClient): Promise<Map<RoleKey, string>> {
  await prisma.permission.createMany({
    data: Object.values(PERMISSIONS).map((key) => ({ key })),
    skipDuplicates: true,
  });

  const permissions = await prisma.permission.findMany({ select: { id: true, key: true } });
  const permissionIds = new Map(permissions.map((p) => [p.key, p.id]));
  const roleIds = new Map<RoleKey, string>();

  for (const key of ROLE_KEYS) {
    const existing = await prisma.role.findFirst({
      where: { key, organizationId: null, isSystem: true },
    });
    const role =
      existing ??
      (await prisma.role.create({
        data: { key, name: key, isSystem: true, organizationId: null },
      }));

    await prisma.rolePermission.createMany({
      data: ROLE_PERMISSION_MATRIX[key]
        .map((permissionKey) => permissionIds.get(permissionKey))
        .filter((id): id is string => Boolean(id))
        .map((permissionId) => ({ roleId: role.id, permissionId })),
      skipDuplicates: true,
    });

    roleIds.set(key, role.id);
  }

  return roleIds;
}

async function seedOrganization(
  prisma: PrismaClient,
  roleIds: Map<RoleKey, string>,
  spec: { name: string; slug: string; ownerEmail: string; repEmail: string },
): Promise<Omit<SeededOrg, 'owner' | 'rep'> & { ownerId: string; repId: string }> {
  const passwordHash = await argon2.hash(PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 8192,
    timeCost: 2,
    parallelism: 1,
  });

  const organization = await prisma.organization.create({
    data: { name: spec.name, slug: spec.slug, status: 'ACTIVE' },
  });
  await prisma.organizationSettings.create({ data: { organizationId: organization.id } });

  const makeMember = async (email: string, role: RoleKey): Promise<string> => {
    const user = await prisma.user.create({
      data: { email, fullName: `${spec.name} ${role}`, passwordHash, status: 'ACTIVE' },
    });
    await prisma.organizationUser.create({
      data: {
        organizationId: organization.id,
        userId: user.id,
        roleId: roleIds.get(role) as string,
        status: 'ACTIVE',
        joinedAt: new Date(),
      },
    });
    return user.id;
  };

  const ownerId = await makeMember(spec.ownerEmail, 'OWNER');
  const repId = await makeMember(spec.repEmail, 'SALES_REP');

  const lead = await prisma.lead.create({
    data: {
      organizationId: organization.id,
      // leads.lead_number is VARCHAR(20); it is unique per organization, so a
      // fixed value is fine and keeps the fixture readable.
      leadNumber: 'LD-000001',
      firstName: spec.name,
      lastName: 'Prospect',
      mobile: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
      companyName: `${spec.name} Pvt Ltd`,
      status: 'NEW',
      // Required by the leads_active_requires_followup CHECK constraint.
      nextFollowUpAt: new Date(Date.now() + 86_400_000),
      assignedToId: repId,
    },
  });

  await prisma.leadActivity.create({
    data: {
      organizationId: organization.id,
      leadId: lead.id,
      activityType: 'LEAD_CREATED',
      description: `Lead created for ${spec.name}`,
      performedById: ownerId,
    },
  });

  return {
    id: organization.id,
    name: spec.name,
    slug: spec.slug,
    leadId: lead.id,
    ownerId,
    repId,
  };
}

async function signIn(
  app: INestApplication,
  email: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const response = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD, platform: 'ANDROID' });

  // Surface the server's own error payload — a bare "expected 200, got 500"
  // from supertest hides the one piece of information that identifies the bug.
  if (response.status !== 200) {
    throw new Error(
      `Login failed for ${email}: ${response.status} ${JSON.stringify(response.body)}`,
    );
  }

  const body = response.body as {
    data: { tokens: { accessToken: string; refreshToken: string } };
  };

  return {
    accessToken: body.data.tokens.accessToken,
    refreshToken: body.data.tokens.refreshToken,
  };
}

/**
 * Builds the full application plus two fully populated, unrelated
 * organizations — the fixture the mandatory isolation suite (spec §29) needs.
 */
export async function createTestContext(): Promise<TestContext> {
  const stamp = Date.now();
  const emails = {
    aOwner: `owner.a.${stamp}@example.test`,
    aRep: `rep.a.${stamp}@example.test`,
    bOwner: `owner.b.${stamp}@example.test`,
    bRep: `rep.b.${stamp}@example.test`,
  };

  // ---------------------------------------------------------------------------
  // PHASE 1 — seed, then RELEASE the connection.
  //
  // PGlite serves exactly one connection at a time. The seed client and the
  // application's own pool cannot both hold it, so seeding must fully complete
  // and disconnect before the app initialises (PrismaService.onModuleInit calls
  // $connect). Against a real Postgres this ordering is unnecessary but
  // harmless.
  // ---------------------------------------------------------------------------
  const prisma = seedClient();
  let a: Awaited<ReturnType<typeof seedOrganization>>;
  let b: Awaited<ReturnType<typeof seedOrganization>>;

  try {
    await connectWithRetry(prisma);
    const roleIds = await seedRolesAndPermissions(prisma);

    a = await seedOrganization(prisma, roleIds, {
      name: 'Cravion',
      slug: `org-a-${stamp}`,
      ownerEmail: emails.aOwner,
      repEmail: emails.aRep,
    });
    b = await seedOrganization(prisma, roleIds, {
      name: 'ABC Foods',
      slug: `org-b-${stamp}`,
      ownerEmail: emails.bOwner,
      repEmail: emails.bRep,
    });
  } finally {
    await prisma.$disconnect();
  }

  // ---------------------------------------------------------------------------
  // PHASE 2 — boot the application and authenticate through real HTTP.
  // ---------------------------------------------------------------------------
  const redis = new InMemoryRedis();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(RedisService)
    .useValue(asRedisService(redis))
    .compile();

  // Silent by default so the suite output stays readable. Run with
  // TEST_LOGS=1 to see server-side stacks when diagnosing a 500.
  const app = moduleRef.createNestApplication({
    logger: process.env['TEST_LOGS'] ? ['error', 'warn'] : false,
  });
  app.use(cookieParser());
  app.setGlobalPrefix('api', { exclude: ['health', 'readiness'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
  );

  await app.init();

  try {
    const build = async (
      org: typeof a,
      ownerEmail: string,
      repEmail: string,
    ): Promise<SeededOrg> => ({
      id: org.id,
      name: org.name,
      slug: org.slug,
      leadId: org.leadId,
      owner: {
        id: org.ownerId,
        email: ownerEmail,
        role: 'OWNER',
        ...(await signIn(app, ownerEmail)),
      },
      rep: {
        id: org.repId,
        email: repEmail,
        role: 'SALES_REP',
        ...(await signIn(app, repEmail)),
      },
    });

    const orgA = await build(a, emails.aOwner, emails.aRep);
    const orgB = await build(b, emails.bOwner, emails.bRep);

    return {
      app,
      redis,
      orgA,
      orgB,
      http: () => request(app.getHttpServer()),
      close: async () => {
        await app.close();
      },
    };
  } catch (error) {
    await app.close();
    throw error;
  }
}

export { PASSWORD };
