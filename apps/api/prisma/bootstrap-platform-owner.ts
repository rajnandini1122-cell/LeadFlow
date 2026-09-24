import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PLATFORM_ROLE_KEY } from '@leadflow/api-types';
import { PrismaClient } from '../src/generated/prisma/client';
import { bootstrapPlatformOwner, validateInputs } from './platform-owner';

/**
 * Creates CRAVION's platform organization and its first PLATFORM_OWNER.
 *
 *     npm run db:bootstrap-platform-owner -w apps/api
 *
 * Required environment:
 *
 *     PLATFORM_OWNER_EMAIL
 *     PLATFORM_OWNER_FIRST_NAME
 *     PLATFORM_OWNER_LAST_NAME
 *     PLATFORM_OWNER_PASSWORD   (at least 12 characters)
 *
 * A COMMAND, not an endpoint, and that is the security decision. A route that
 * mints the most privileged account in the system is a route somebody can reach;
 * this needs shell access to the deployment and the database URL, which is the
 * same bar as running the migrations.
 *
 * The password comes through the environment rather than an argument so it stays
 * out of shell history and process listings. It is never echoed, never logged,
 * and never included in an error message.
 *
 * Runs AFTER `db:bootstrap`, which owns the PLATFORM_OWNER role this attaches.
 *
 * WHERE IT RUNS. The same approved one-off, build or CI context as the
 * migrations: it needs `tsx`, a devDependency absent from the production runtime
 * image.
 *
 * This file is the WRAPPER. Everything that decides what happens to the
 * database lives in `platform-owner.ts`, so it can be tested in-process against
 * a real database rather than only through a spawned process.
 */
async function main(): Promise<void> {
  const inputs = validateInputs({
    email: process.env['PLATFORM_OWNER_EMAIL'],
    firstName: process.env['PLATFORM_OWNER_FIRST_NAME'],
    lastName: process.env['PLATFORM_OWNER_LAST_NAME'],
    password: process.env['PLATFORM_OWNER_PASSWORD'],
  });

  const { connectionString, source } = resolveConnection();
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 1 }) });

  try {
    console.log(`Bootstrapping the CRAVION platform owner (via ${source})…\n`);

    const result = await bootstrapPlatformOwner(prisma, inputs, {
      // The same parameters PasswordService uses, from the same variables, so a
      // hash written here verifies against a login later.
      memoryCost: Number(process.env['ARGON2_MEMORY_COST'] ?? 19456),
      timeCost: Number(process.env['ARGON2_TIME_COST'] ?? 2),
      parallelism: Number(process.env['ARGON2_PARALLELISM'] ?? 1),
    });

    if (result.passwordUntouched) {
      console.log(`  user ${result.user.email} already exists — password left untouched`);
    }

    console.log('\nPlatform owner ready.');
    console.log(`  organization  ${result.organization.name}`);
    console.log(`                ${result.organization.id} (${result.organization.action})`);
    console.log(`  user          ${result.user.email} (${result.user.action})`);
    console.log(`  role          ${PLATFORM_ROLE_KEY} (${result.membership.action})`);
    /*
     * The entitlement IS the organization type, and it is already set.
     *
     * There is no row to create: INTERNAL organizations have no subscription by
     * design, and EntitlementsService returns a platform-internal entitlement
     * for them. Said out loud because "create internal entitlement state" sounds
     * like it should write something, and a reader who goes looking for that
     * write should find this note rather than conclude it was forgotten.
     */
    console.log('  entitlement   PLATFORM_INTERNAL — no plan, no billing, no expiry');
    console.log('\nSign in through the normal login page. No password was printed.');
  } finally {
    await prisma.$disconnect();
  }
}

/** Production requires the direct endpoint, for the same reason db:bootstrap does. */
function resolveConnection(): { connectionString: string; source: string } {
  const isProduction = process.env['NODE_ENV'] === 'production';
  const direct = process.env['DIRECT_DATABASE_URL'];
  const pooled = process.env['DATABASE_URL'];

  if (isProduction) {
    if (!direct) {
      throw new Error(
        'DIRECT_DATABASE_URL must be set when NODE_ENV=production, so the ' +
          'connection is a deliberate choice rather than whichever value happened ' +
          'to be set. See docs/production.md.',
      );
    }

    return { connectionString: direct, source: 'DIRECT_DATABASE_URL' };
  }

  const connectionString = direct ?? pooled;
  if (!connectionString) {
    throw new Error('DIRECT_DATABASE_URL or DATABASE_URL must be set.');
  }

  return { connectionString, source: direct ? 'DIRECT_DATABASE_URL' : 'DATABASE_URL' };
}

main().catch((error: unknown) => {
  /*
   * Message only, never the error object.
   *
   * A Prisma failure attaches the connection string it tried, which carries the
   * database password — and this command's environment also holds the owner
   * password. Neither belongs in a CI transcript.
   */
  console.error(`\n${error instanceof Error ? error.message : 'Bootstrap failed.'}`);
  process.exit(1);
});
