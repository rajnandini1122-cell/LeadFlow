#!/usr/bin/env node
/**
 * Proves a backup restores: compares the SOURCE database with a database
 * restored from its dump — exact row counts for every table, and the
 * migration history.
 *
 *   SOURCE_DATABASE_URL=… RESTORED_DATABASE_URL=… node scripts/verify-restore.mjs
 *
 * The source is only READ (read-only session and transaction), so it is safe
 * to point at production. Counts are taken from one snapshot on each side;
 * rows written to the source after the dump was taken show up as differences,
 * which is why the dump and this check should run back to back. Prints table
 * names and counts only; never the connection strings.
 * Exit code: 0 when everything matches, 2 when anything differs, 1 on error.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { Client } = createRequire(join(root, 'apps/api/package.json'))('pg');

const sourceUrl = process.env.SOURCE_DATABASE_URL;
const restoredUrl = process.env.RESTORED_DATABASE_URL;
if (!sourceUrl || !restoredUrl) {
  console.error('Set SOURCE_DATABASE_URL and RESTORED_DATABASE_URL. Neither is printed.');
  process.exit(1);
}

async function snapshot(url) {
  const client = new Client({ connectionString: url, options: '-c default_transaction_read_only=on' });
  await client.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const tables = (
      await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)
    ).rows.map((r) => r.tablename);
    const counts = new Map();
    for (const t of tables) {
      const { rows } = await client.query(`SELECT count(*)::bigint AS n FROM "${t.replace(/"/g, '""')}"`);
      counts.set(t, String(rows[0].n));
    }
    const migrations = (
      await client.query(`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`)
    ).rows.map((r) => r.migration_name);
    await client.query('ROLLBACK');
    return { counts, migrations };
  } finally {
    await client.end();
  }
}

try {
  const [source, restored] = await Promise.all([snapshot(sourceUrl), snapshot(restoredUrl)]);
  let differences = 0;
  const names = [...new Set([...source.counts.keys(), ...restored.counts.keys()])].sort();
  let total = 0n;
  for (const name of names) {
    const a = source.counts.get(name) ?? 'missing';
    const b = restored.counts.get(name) ?? 'missing';
    if (a !== b) {
      differences++;
      console.log(`DIFF  ${name}: source ${a}, restored ${b}`);
    } else {
      total += BigInt(a);
    }
  }
  const sameMigrations = source.migrations.join('|') === restored.migrations.join('|');
  if (!sameMigrations) differences++;
  console.log(`${names.length} tables compared, ${total} rows matched exactly`);
  console.log(`migration history: ${sameMigrations ? 'identical' : 'DIFFERENT'} (${source.migrations.length} applied, last ${source.migrations.at(-1)})`);
  console.log(differences === 0 ? 'RESTORE VERIFIED' : `${differences} difference(s) — the backup is NOT verified`);
  process.exit(differences === 0 ? 0 : 2);
} catch (error) {
  console.error(`Could not verify: ${error.message}`);
  process.exit(1);
}
