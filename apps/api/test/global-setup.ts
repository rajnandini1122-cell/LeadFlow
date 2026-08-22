import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

/**
 * Boots a throwaway Postgres for the e2e suite.
 *
 * This machine has no Docker, no WSL2 and no native Postgres, so PGlite
 * (Postgres 17 compiled to WebAssembly) is served over the real Postgres wire
 * protocol on a loopback port. Prisma connects through the normal
 * @prisma/adapter-pg driver, so migrations, enums, triggers, partial indexes
 * and CHECK constraints all behave as they will in production.
 *
 * Two PGlite constraints shape the configuration below:
 *   * it serves ONE connection at a time  -> pool max 1, jest maxWorkers 1
 *   * a SQL error drops the connection    -> tests assert on zero-row results
 *                                            and guard rejections, not on
 *                                            constraint violations. Those are
 *                                            covered by schema-invariants
 *                                            checks against raw `pg` instead.
 *
 * CI uses Testcontainers with a real postgres:17 image; see .github/workflows.
 */

let server: PGLiteSocketServer | undefined;
let db: PGlite | undefined;

async function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

export default async function globalSetup(): Promise<void> {
  // CI provides a real postgres:17 service container — the same image staging
  // and production run. PGlite is the fallback for development machines
  // without Docker, not the canonical test backend.
  const useExternalDatabase = process.env['CI_USE_EXTERNAL_DB'] === '1';

  let url: string;

  if (useExternalDatabase) {
    const external = process.env['DATABASE_URL'];
    if (!external) {
      throw new Error('CI_USE_EXTERNAL_DB=1 but DATABASE_URL is not set');
    }
    url = external;
  } else {
    const port = await findFreePort();

    db = await PGlite.create();
    await db.waitReady;

    server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
    await server.start();

    // sslmode=disable is required: PGlite's socket server does not implement
    // the SSL negotiation handshake that Prisma's schema engine attempts by
    // default.
    url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
  }

  process.env['NODE_ENV'] = 'test';
  process.env['DATABASE_URL'] = url;
  process.env['DIRECT_DATABASE_URL'] = url;
  // PGlite serves a single connection; a real Postgres does not need the cap
  // but is unharmed by it, and keeping one value keeps the two paths identical.
  process.env['DATABASE_POOL_MAX'] = '1';
  process.env['REDIS_URL'] ??= 'redis://127.0.0.1:6379'; // replaced by an in-memory double
  process.env['JWT_ACCESS_SECRET'] = 'test-access-secret-at-least-32-characters-long';
  process.env['JWT_REFRESH_SECRET'] = 'test-refresh-secret-at-least-32-characters-diff';
  process.env['JWT_ACCESS_TTL'] = '15m';
  process.env['JWT_REFRESH_TTL'] = '30d';
  process.env['LOG_LEVEL'] = 'fatal';

  /*
   * WhatsApp webhook credentials for the suite.
   *
   * Fixed test values, never real ones — the point of these is that the
   * signature and verification tests can compute the SAME HMAC the server
   * will. A deployment reading these from a committed file would be a
   * different matter; a test fixture is exactly what they are.
   */
  /*
   * The stale-outbound sweep is invoked directly by the tests that cover it.
   *
   * Left on, its timer would race assertions that depend on a message still
   * being PENDING, and would keep a handle open after the suite finishes —
   * which this configuration deliberately does not paper over with forceExit.
   */
  process.env['OUTBOUND_RECOVERY_ENABLED'] = 'false';

  process.env['WHATSAPP_APP_SECRET'] = 'test-whatsapp-app-secret';
  process.env['INSTAGRAM_APP_SECRET'] = 'test-instagram-app-secret';
  process.env['INSTAGRAM_VERIFY_TOKEN'] = 'test-instagram-verify-token';
  process.env['FACEBOOK_APP_SECRET'] = 'test-facebook-app-secret';
  process.env['FACEBOOK_VERIFY_TOKEN'] = 'test-facebook-verify-token';
  process.env['WHATSAPP_VERIFY_TOKEN'] = 'test-whatsapp-verify-token';
  // 32 zero bytes, base64. Sufficient for a round-trip; obviously not a key
  // anything real would use.
  process.env['CREDENTIAL_ENCRYPTION_KEY'] = Buffer.alloc(32).toString('base64');
  process.env['CORS_ORIGINS'] = 'http://localhost:5173';
  // Keep argon2 at its floor: the suite hashes many passwords and production
  // cost parameters would dominate the runtime.
  process.env['ARGON2_MEMORY_COST'] = '8192';
  process.env['ARGON2_TIME_COST'] = '2';

  // Every request in the suite originates from the same loopback address, so
  // production rate limits would trip partway through and make results depend
  // on test ordering. Throttling itself is covered by rate-limit.e2e-spec.ts,
  // which sets its own deliberately low limits.
  process.env['THROTTLE_LIMIT'] = '100000';
  process.env['AUTH_THROTTLE_LIMIT'] = '100000';

  // MUST be async. PGlite runs in THIS process and its socket server accepts
  // connections on this event loop, so a synchronous child-process call would
  // block the very loop the migration needs in order to connect.
  await runMigrations();

  if (server && db) {
    const globals = globalThis as { __PGLITE__?: { server: PGLiteSocketServer; db: PGlite } };
    globals.__PGLITE__ = { server, db };
  }
}

function runMigrations(): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: resolve(__dirname, '..'),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`prisma migrate deploy exited ${code}\n${stderr}`));
    });
  });
}

export async function stop(): Promise<void> {
  await server?.stop();
  await db?.close();
}
