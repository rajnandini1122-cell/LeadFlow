import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { syncReferenceData } from './reference-data';

/**
 * Prepares a freshly migrated database so the application can be used.
 *
 * PRODUCTION-SAFE, and that is the entire reason this exists separately from
 * `seed.ts`. It writes permissions, the four system roles with their grants,
 * and the plan catalogue — the global rows the code defines. It creates no
 * organization, no user, no membership and no business data.
 *
 * Run it once after `prisma migrate deploy`, before the API serves traffic:
 *
 *     npm run db:migrate:deploy -w apps/api
 *     npm run db:bootstrap      -w apps/api
 *
 * WHERE IT RUNS. Not in the production API or worker container. Those are
 * built with `npm ci --omit=dev` and contain neither `tsx` nor the Prisma CLI
 * by design — a runtime image should not carry the tooling that can rewrite
 * the schema. Run it from the same approved one-off, build or CI context that
 * runs the migrations, which has devDependencies available.
 *
 * WHY IT IS NEEDED. A freshly migrated database has no system roles: no
 * migration inserts them, and the boot-time permission sync deliberately
 * reconciles only roles that already exist. `POST /auth/register` looks up the
 * OWNER role and fails without it, so a new deployment could not create its
 * first organization at all. The only thing that created roles was the
 * development seed — which also creates demo organizations with a default
 * password, and so must never run in production. This is the missing step.
 *
 * WHAT COMES NEXT. The first real organization is created through the
 * application's supported registration flow, by a person, with a password they
 * chose. Deliberately not here: a bootstrap that invented an owner account
 * would be inventing a credential, and a credential that a script chose is one
 * that lives in a script.
 */
async function main(): Promise<void> {
  const { connectionString, source } = resolveConnection();

  // `max: 1` because this runs once, alone, and a pool would be pure overhead.
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 1 }) });

  try {
    console.log(`Bootstrapping LeadFlow reference data (via ${source})…\n`);

    const summary = await syncReferenceData(prisma, (message) => console.log(message));

    /*
     * Say plainly that no tenant data was touched.
     *
     * Counted rather than asserted from the code above, because the reassuring
     * thing for whoever runs this against a live database is the number, not
     * the promise. On a fresh database both are zero; on an existing one they
     * are whatever they already were, and this run did not change them.
     */
    const [organizations, users] = await Promise.all([
      prisma.organization.count(),
      prisma.user.count(),
    ]);

    console.log('\nReference data is in step with this build.');
    console.log(
      `  permissions ${summary.permissions} · roles ${summary.roles} · plans ${summary.plans}` +
        (summary.plansWithdrawn > 0 ? ` (${summary.plansWithdrawn} withdrawn)` : ''),
    );
    console.log(`  organizations ${organizations} · users ${users} — untouched by bootstrap`);

    if (organizations === 0) {
      console.log('\nNext: create the first organization through the registration flow.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Which connection to bootstrap through, decided explicitly.
 *
 * In PRODUCTION the direct (unpooled) URL is required. This step is ordinary
 * DML and would in fact survive a transaction-mode pooler, unlike the
 * migrations it follows — but it runs in the same one-off context, immediately
 * after them, and "whichever URL happened to be set" is not something an
 * operator should have to work out from a log. Requiring it makes the
 * connection a stated decision rather than an accident of configuration.
 *
 * Elsewhere the pooled URL is an acceptable fallback, so a developer with one
 * DATABASE_URL and a test run with one connection both work unchanged.
 *
 * Fails closed either way, and never prints a URL — a connection string
 * carries the database password.
 */
function resolveConnection(): { connectionString: string; source: string } {
  const isProduction = process.env['NODE_ENV'] === 'production';
  const direct = process.env['DIRECT_DATABASE_URL'];
  const pooled = process.env['DATABASE_URL'];

  if (isProduction) {
    if (!direct) {
      throw new Error(
        'DIRECT_DATABASE_URL must be set when NODE_ENV=production. Bootstrap runs ' +
          'through the same direct, unpooled endpoint as the migrations it follows, ' +
          'so the connection is a deliberate choice rather than whichever value ' +
          'happened to be set. See docs/production.md.',
      );
    }

    return { connectionString: direct, source: 'DIRECT_DATABASE_URL' };
  }

  const connectionString = direct ?? pooled;
  if (!connectionString) {
    throw new Error('DIRECT_DATABASE_URL or DATABASE_URL must be set to bootstrap.');
  }

  return {
    connectionString,
    source: direct ? 'DIRECT_DATABASE_URL' : 'DATABASE_URL',
  };
}

main().catch((error: unknown) => {
  /*
   * Message only, never the error object.
   *
   * A Prisma connection failure attaches the connection string it tried, which
   * carries the database password. Printing `error` would put that in whatever
   * log or CI transcript this ran in — somewhere it is very hard to remove
   * from afterwards.
   */
  console.error(`Bootstrap failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
