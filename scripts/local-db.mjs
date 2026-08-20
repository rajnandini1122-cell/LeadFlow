/**
 * Local Postgres for development and tests — no Docker required.
 *
 * This machine has no Docker, no WSL2 and no native Postgres, so PGlite
 * (Postgres 17 compiled to WebAssembly) is served over the real Postgres wire
 * protocol on a local TCP port. Prisma connects to it through the ordinary
 * @prisma/adapter-pg driver and cannot tell the difference, so migrations,
 * enums, triggers, partial indexes and CHECK constraints all behave exactly as
 * they will in production.
 *
 * This is a DEVELOPMENT AND TEST convenience only:
 *   * PGlite serves a single connection at a time — fine for `jest --runInBand`,
 *     useless under concurrent load.
 *   * Staging and production use real managed Postgres (Neon), and CI uses
 *     Testcontainers. See docs/runbook.md.
 *
 * Usage:
 *   node scripts/local-db.mjs            # persistent, ./.tmp/pgdata
 *   node scripts/local-db.mjs --memory   # ephemeral, wiped on exit
 *   node scripts/local-db.mjs --port 5433
 */
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

const portIndex = args.indexOf('--port');
const port = portIndex !== -1 ? Number(args[portIndex + 1]) : 5432;
const inMemory = args.includes('--memory');
const dataDir = resolve(here, '..', '.tmp', 'pgdata');

if (!inMemory) mkdirSync(dataDir, { recursive: true });

const db = await PGlite.create(inMemory ? undefined : { dataDir });
await db.waitReady;

const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
await server.start();

const { rows } = await db.query('select version()');
console.log(`[local-db] ${rows[0].version.split(',')[0]}`);
console.log(`[local-db] listening on 127.0.0.1:${port} (${inMemory ? 'in-memory' : dataDir})`);
console.log(`[local-db] DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:${port}/postgres`);

const shutdown = async () => {
  console.log('\n[local-db] shutting down');
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
