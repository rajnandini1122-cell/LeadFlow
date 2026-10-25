#!/usr/bin/env node
/**
 * Read-only production preflight for PR #11 → #12 → #13, graded.
 *
 *   PREFLIGHT_DATABASE_URL='postgresql://…' node scripts/production-preflight.mjs
 *   … --after=11   after #11 is deployed: its migrations applied, nothing failed
 *   … --after=12   after #12 is deployed: every release migration applied
 *
 * Runs the checks of docs/release/production-preflight.sql and of
 * leadflow-stabilization/01-repair-preview.sql (A–F) and grades each one:
 *   STOP    — do not merge #11 until resolved
 *   REVIEW  — not a blocker; decide what to do about it
 *   OK / INFO
 *
 * SAFETY
 * - The session is opened with default_transaction_read_only=on, and every
 *   query runs inside one READ ONLY, REPEATABLE READ transaction that is rolled
 *   back. PostgreSQL refuses any write — the script proves it before reading.
 * - Prints counts and identifiers of migrations only: no names, emails, phone
 *   numbers, and never the connection string.
 * - Exit code: 0 when nothing is STOP, 2 when something is, 1 on error.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { Client } = createRequire(join(root, 'apps/api/package.json'))('pg');

const url = process.env.PREFLIGHT_DATABASE_URL;
if (!url) {
  console.error('Set PREFLIGHT_DATABASE_URL (ideally a read-only role). It is never printed.');
  process.exit(1);
}

/** Which migration must be the last one applied, before the release and after each step. */
const EXPECTED_LAST = {
  before: '20260930090000_website_enquiry_classification',
  11: '20261013090000_lead_address_deactivation_import_batches',
  12: '20261024091000_lead_attachments',
};
const stage = process.argv.find((a) => a.startsWith('--after='))?.slice('--after='.length) ?? 'before';
if (!(stage in EXPECTED_LAST)) {
  console.error('Use --after=11 or --after=12, or no flag before the release.');
  process.exit(1);
}
const PROD_LAST_MIGRATION = EXPECTED_LAST[stage];
const BEFORE = stage === 'before';
const OPEN = `('UPCOMING','DUE','OVERDUE')`;

/** [id, description, sql, grade(rows) → [verdict, detail]] */
const CHECKS = [
  ['P0', 'Session is read-only', `SHOW default_transaction_read_only`,
    (r) => (r[0].default_transaction_read_only === 'on' ? ['OK', 'on'] : ['STOP', 'not read-only'])],
  ['P0c', 'Connected role holds no write or DDL privilege (not an admin connection)',
    `SELECT (SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS powerful,
            has_schema_privilege('public', 'CREATE') AS can_create,
            (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
                AND (has_table_privilege(c.oid, 'INSERT') OR has_table_privilege(c.oid, 'UPDATE')
                  OR has_table_privilege(c.oid, 'DELETE') OR has_table_privilege(c.oid, 'TRUNCATE'))) AS writable,
            (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = current_user) AS owned`,
    (r) => (!r[0].powerful && !r[0].can_create && r[0].writable === 0 && r[0].owned === 0
      ? ['OK', 'read-only role']
      : ['STOP', 'this connection can write or alter objects — use the leadflow_preflight role'])],
  ['P0b', 'PostgreSQL server version (pg_dump must be this major or newer)', `SHOW server_version`,
    (r) => ['INFO', r[0].server_version]],
  ['P1', 'Database encoding is UTF8',
    `SELECT pg_encoding_to_char(encoding) AS enc FROM pg_database WHERE datname = current_database()`,
    (r) => (r[0].enc === 'UTF8' ? ['OK', 'UTF8'] : ['STOP', `${r[0].enc} — migration 20261002 needs UTF8`])],
  ['P2a', `Last applied migration is ${PROD_LAST_MIGRATION}`,
    `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name DESC LIMIT 1`,
    (r) => (r[0]?.migration_name === PROD_LAST_MIGRATION ? ['OK', r[0].migration_name] : ['STOP', `last is ${r[0]?.migration_name ?? 'none'}`])],
  ['P2b', 'No failed or rolled-back migrations',
    `SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL`,
    (r) => (r[0].n === 0 ? ['OK', '0'] : ['STOP', `${r[0].n} rows — resolve before deploying`])],
  ['P2c', 'Release migrations (20261002+) already applied',
    `SELECT count(*)::int AS n FROM _prisma_migrations WHERE migration_name >= '20261002'`,
    (r) => (!BEFORE ? ['INFO', `${r[0].n} release migrations applied`]
      : r[0].n === 0 ? ['OK', '0'] : ['STOP', `${r[0].n} already present — someone applied part of the release`])],
  ['P3', 'Release objects present (table, columns, enum values)',
    `SELECT (to_regclass('public.lead_attachments') IS NOT NULL)::int
          -- pg_attribute, not information_schema: the latter hides columns the
          -- role holds no privilege on, which would make this check pass falsely
          -- for a least-privilege preflight role.
          + (EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.leads') AND attname = 'last_outcome' AND NOT attisdropped))::int
          + (EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='activity_type' AND e.enumlabel LIKE 'DOCUMENT_%'))::int AS n`,
    (r) => (!BEFORE ? ['INFO', `${r[0].n} of 3 present (all 3 expected after #12)`]
      : r[0].n === 0 ? ['OK', 'none'] : ['STOP', `${r[0].n} present`])],
  ['F', 'No duplicate live lead emails (20261002 unique index would abort)',
    `SELECT count(*)::int AS groups, coalesce(sum(c),0)::int AS leads FROM (
       SELECT count(*) AS c FROM leads l
        WHERE l.email IS NOT NULL AND l.deleted_at IS NULL AND l.status <> 'LOST' AND l.duplicate_acknowledged_at IS NULL
        GROUP BY l.organization_id, lower(l.email) HAVING count(*) > 1) g`,
    (r) => (r[0].groups === 0 ? ['OK', '0 groups'] : ['STOP', `${r[0].groups} groups / ${r[0].leads} leads — resolve in the app first (01-repair-preview.sql §F lists them)`])],
  ['E', 'Every open lead has a next action (CHECK constraint present)',
    `SELECT count(*)::int AS n FROM leads WHERE deleted_at IS NULL AND status NOT IN ('WON','LOST') AND next_follow_up_at IS NULL`,
    (r) => (r[0].n === 0 ? ['OK', '0'] : ['STOP', `${r[0].n} — constraint missing, investigate`])],
  ['P6', 'Organization isolation: no child row in a different org from its lead',
    `SELECT (SELECT count(*) FROM follow_ups f JOIN leads l ON l.id=f.lead_id WHERE f.organization_id<>l.organization_id)
          + (SELECT count(*) FROM lead_activities a JOIN leads l ON l.id=a.lead_id WHERE a.organization_id<>l.organization_id)
          + (SELECT count(*) FROM leads l WHERE l.assigned_to IS NOT NULL AND NOT EXISTS
               (SELECT 1 FROM organization_users ou WHERE ou.organization_id=l.organization_id AND ou.user_id=l.assigned_to)) AS n`,
    (r) => (Number(r[0].n) === 0 ? ['OK', '0'] : ['STOP', `${r[0].n} rows — isolation breach, investigate first`])],
  ['A', 'Open follow-ups still owed by a previous lead owner',
    `SELECT count(DISTINCT f.id)::int AS n FROM follow_ups f JOIN leads l ON l.id=f.lead_id
       JOIN audit_logs a ON a.organization_id=f.organization_id AND a.action='lead.assigned' AND a.entity_id=l.id
        AND (a.before->>'assignedToId')::uuid=f.assigned_user_id AND a.created_at>=f.created_at
      WHERE f.status IN ${OPEN} AND l.deleted_at IS NULL AND l.status NOT IN ('WON','LOST')
        AND l.assigned_to IS NOT NULL AND f.assigned_user_id<>l.assigned_to`,
    (r) => (r[0].n === 0 ? ['OK', '0'] : ['REVIEW', `${r[0].n} — repair decision (repair scripts stay ROLLBACK)`])],
  ['B', 'Open follow-ups owed by someone no longer active',
    `SELECT count(*)::int AS n FROM follow_ups f LEFT JOIN organization_users ou
        ON ou.organization_id=f.organization_id AND ou.user_id=f.assigned_user_id AND ou.status='ACTIVE'
      WHERE f.status IN ${OPEN} AND ou.user_id IS NULL`,
    (r) => (r[0].n === 0 ? ['OK', '0'] : ['REVIEW', `${r[0].n} — reassign in the app`])],
  ['C', 'Assigned live leads with a next action but no queue row',
    `SELECT count(*)::int AS n FROM leads l WHERE l.deleted_at IS NULL AND l.status NOT IN ('WON','LOST')
        AND l.assigned_to IS NOT NULL AND l.next_follow_up_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM follow_ups f WHERE f.lead_id=l.id AND f.status IN ${OPEN})`,
    (r) => (r[0].n === 0 ? ['OK', '0'] : ['REVIEW', `${r[0].n} — invisible in queues until repaired`])],
  ['D', 'Unassigned live leads',
    `SELECT count(*)::int AS n FROM leads WHERE deleted_at IS NULL AND status NOT IN ('WON','LOST') AND assigned_to IS NULL`,
    (r) => ['INFO', `${r[0].n} — a manager can assign them`]],
  ['P4', 'Live leads owned by a non-active member',
    `SELECT count(*)::int AS n FROM leads l LEFT JOIN organization_users ou ON ou.organization_id=l.organization_id AND ou.user_id=l.assigned_to
      WHERE l.deleted_at IS NULL AND l.assigned_to IS NOT NULL AND l.status NOT IN ('WON','LOST') AND (ou.user_id IS NULL OR ou.status<>'ACTIVE')`,
    (r) => (r[0].n === 0 ? ['OK', '0'] : ['REVIEW', `${r[0].n} — reassign in the app`])],
  ['P5', 'Open follow-ups on closed or deleted leads',
    `SELECT count(*)::int AS n FROM follow_ups f JOIN leads l ON l.id=f.lead_id
      WHERE f.status IN ${OPEN} AND (l.deleted_at IS NOT NULL OR l.status IN ('WON','LOST'))`,
    (r) => (r[0].n === 0 ? ['OK', '0'] : ['REVIEW', `${r[0].n} — inflate overdue counts`])],
  ['P7', 'Table sizes (lock-time estimate)',
    `SELECT (SELECT count(*) FROM leads)::int AS leads, (SELECT count(*) FROM follow_ups)::int AS follow_ups,
            (SELECT count(*) FROM lead_activities)::int AS activities, pg_size_pretty(pg_database_size(current_database())) AS db_size`,
    (r) => ['INFO', `leads ${r[0].leads}, follow-ups ${r[0].follow_ups}, activities ${r[0].activities}, database ${r[0].db_size}`]],
];

const client = new Client({ connectionString: url, options: '-c default_transaction_read_only=on', application_name: 'leadflow-preflight' });
let stops = 0;
try {
  await client.connect();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
  // Prove the guarantee before reading anything.
  await client.query('SAVEPOINT probe');
  try {
    await client.query('CREATE TEMP TABLE preflight_write_probe (x int)');
    console.error('ABORT: the session accepted a write. Nothing else was run.');
    process.exit(1);
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT probe');
  }

  console.log(`LeadFlow production preflight (${BEFORE ? 'before the release' : `after #${stage}`}) — ${new Date().toISOString()}\n`);
  for (const [id, label, sql, grade] of CHECKS) {
    let verdict;
    let detail;
    try {
      const { rows } = await client.query(sql);
      [verdict, detail] = grade(rows);
    } catch (error) {
      [verdict, detail] = ['STOP', `query failed: ${error.message}`];
      await client.query('ROLLBACK').catch(() => {});
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    }
    if (verdict === 'STOP') stops++;
    console.log(`${verdict.padEnd(6)} ${id.padEnd(4)} ${label}\n         ${detail}`);
    // A connection that is not provably read-only reads no business data.
    if (verdict === 'STOP' && (id === 'P0' || id === 'P0c')) {
      console.log('\nStopped before reading any data.');
      break;
    }
  }
  await client.query('ROLLBACK');
  console.log(`\n${stops === 0 ? 'No STOP findings.' : `${stops} STOP finding(s): ${BEFORE ? "do not merge #11" : "do not proceed to the next step"} until resolved.`}`);
} catch (error) {
  console.error(`Preflight could not run: ${error.message}`);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
process.exit(stops === 0 ? 0 : 2);
