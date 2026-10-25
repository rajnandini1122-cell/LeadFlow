#!/usr/bin/env node
/**
 * Proves the leadflow_preflight role is read-only BEFORE the preflight reads
 * anything. Uses PostgreSQL's own privilege functions (has_*_privilege) — it
 * attempts no write at all.
 *
 *   PREFLIGHT_DATABASE_URL=… node scripts/verify-preflight-role.mjs
 *
 * Checks: role attributes (not superuser, cannot create roles/databases, no
 * replication, no RLS bypass); sessions default to read-only; no CREATE on the
 * database or the schema; no INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER
 * on any table; owns nothing; SELECT on exactly the preflight's columns and no
 * other column of any table. Prints the verdicts only — never the URL.
 * Exit 0 when every check passes, 2 when any fails, 1 on error.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { Client } = createRequire(join(root, 'apps/api/package.json'))('pg');

const url = process.env.PREFLIGHT_DATABASE_URL;
if (!url) {
  console.error('Set PREFLIGHT_DATABASE_URL. It is never printed.');
  process.exit(1);
}

/** The only columns the preflight may read. Must match docs/release/preflight-role.sql. */
const ALLOWED = {
  _prisma_migrations: ['migration_name', 'finished_at', 'rolled_back_at'],
  leads: ['id', 'organization_id', 'status', 'deleted_at', 'assigned_to', 'next_follow_up_at', 'email', 'duplicate_acknowledged_at'],
  follow_ups: ['id', 'organization_id', 'lead_id', 'status', 'assigned_user_id', 'created_at'],
  lead_activities: ['organization_id', 'lead_id'],
  organization_users: ['organization_id', 'user_id', 'status'],
  audit_logs: ['organization_id', 'action', 'entity_id', 'before', 'created_at'],
};

const client = new Client({ connectionString: url, application_name: 'leadflow-preflight-verify' });
let failures = 0;
const report = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

try {
  await client.connect();
  const role = (
    await client.query(
      `SELECT current_user AS name, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolinherit,
              rolconnlimit, rolvaliduntil
         FROM pg_roles WHERE rolname = current_user`,
    )
  ).rows[0];
  report(role.name === 'leadflow_preflight', 'connected as leadflow_preflight', role.name === 'leadflow_preflight' ? '' : 'a different role');
  report(!role.rolsuper && !role.rolcreaterole && !role.rolcreatedb && !role.rolreplication && !role.rolbypassrls,
    'no superuser / create-role / create-db / replication / RLS bypass');
  report(!role.rolinherit, 'inherits nothing from other roles');
  report(role.rolvaliduntil !== null, 'expires automatically', role.rolvaliduntil ? `until ${new Date(role.rolvaliduntil).toISOString().slice(0, 10)}` : 'no expiry set');

  const ro = (await client.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only;
  report(ro === 'on', 'every session is read-only by default', ro);

  // EFFECTIVE privileges: has_*_privilege includes everything granted to
  // PUBLIC, so defaults inherited that way are checked too — in EVERY
  // non-system schema, not only public.
  const USER_SCHEMAS = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'`;

  const db = (await client.query(`SELECT has_database_privilege(current_database(), 'CREATE') AS c, has_database_privilege(current_database(), 'TEMP') AS t`)).rows[0];
  report(!db.c, 'cannot CREATE schemas in the database');
  const schemas = (
    await client.query(`SELECT n.nspname, has_schema_privilege(n.oid, 'CREATE') AS c FROM pg_namespace n WHERE ${USER_SCHEMAS}`)
  ).rows;
  const creatable = schemas.filter((s) => s.c).map((s) => s.nspname);
  report(creatable.length === 0, `no CREATE on any of ${schemas.length} schema(s), including via PUBLIC`, creatable.join(', '));
  const usage = (await client.query(`SELECT has_schema_privilege('public', 'USAGE') AS u`)).rows[0];
  report(usage.u, 'schema public: USAGE (lookup only)');

  const memberships = (await client.query(`SELECT count(*)::int AS n FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = current_user)`)).rows[0];
  report(memberships.n === 0, 'member of no other role (cannot SET ROLE to gain anything)');

  // Functions that run with their OWNER's rights would let a caller write
  // indirectly. The application defines none, but production is checked, not assumed.
  const definers = (
    await client.query(
      `SELECT n.nspname || '.' || p.proname AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE ${USER_SCHEMAS} AND p.prosecdef AND has_function_privilege(p.oid, 'EXECUTE')`,
    )
  ).rows.map((r) => r.f);
  report(definers.length === 0, 'can execute no SECURITY DEFINER function', definers.join(', '));

  const largeObjects = (await client.query(`SELECT count(*)::int AS n FROM pg_largeobject_metadata WHERE lomowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)`)).rows[0];
  report(largeObjects.n === 0, 'owns no large object', largeObjects.n ? `${largeObjects.n} — investigate, then DROP OWNED BY leadflow_preflight` : '');

  // Residual, by design: PUBLIC's default TEMP on the database (and any role's
  // ability to create a large object) cannot be removed for one role without
  // changing PUBLIC for every user. Both are refused while the session is
  // read-only, touch no application object, and are capped / detected above.
  const tempLimit = (await client.query(`SELECT setting FROM pg_settings WHERE name = 'temp_file_limit'`)).rows[0]?.setting;
  console.log(`NOTE  temporary objects via PUBLIC's default TEMP: ${db.t ? 'possible only if the session turns read-only off' : 'not granted'}; temp_file_limit ${tempLimit === '-1' ? 'unlimited' : `${tempLimit} kB`}`);

  const tables = (
    await client.query(
      `SELECT CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname || '.' || c.relname END AS relname,
              has_table_privilege(c.oid, 'INSERT') OR has_table_privilege(c.oid, 'UPDATE') OR has_table_privilege(c.oid, 'DELETE')
                OR has_table_privilege(c.oid, 'TRUNCATE') OR has_table_privilege(c.oid, 'REFERENCES') OR has_table_privilege(c.oid, 'TRIGGER') AS writes,
              has_table_privilege(c.oid, 'SELECT') AS whole_table_select,
              pg_get_userbyid(c.relowner) = current_user AS owns
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE ${USER_SCHEMAS} AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')`,
    )
  ).rows;
  const writable = tables.filter((t) => t.writes).map((t) => t.relname);
  report(writable.length === 0, `no INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on any of ${tables.length} tables/views/sequences, including via PUBLIC`, writable.join(', '));
  const whole = tables.filter((t) => t.whole_table_select).map((t) => t.relname);
  report(whole.length === 0, 'no whole-table SELECT anywhere (column grants only)', whole.join(', '));
  const owned = tables.filter((t) => t.owns).map((t) => t.relname);
  report(owned.length === 0, 'owns no object (so cannot ALTER or DROP any)', owned.join(', '));

  // Every readable column, across every table, must be on the allow-list.
  const readable = (
    await client.query(
      `SELECT CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname || '.' || c.relname END AS relname, a.attname
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE ${USER_SCHEMAS} AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND has_column_privilege(c.oid, a.attnum, 'SELECT')`,
    )
  ).rows;
  const extra = readable.filter((r) => !(ALLOWED[r.relname] ?? []).includes(r.attname)).map((r) => `${r.relname}.${r.attname}`);
  report(extra.length === 0, `reads only the preflight's ${Object.values(ALLOWED).flat().length} columns`, extra.slice(0, 8).join(', '));
  const missing = Object.entries(ALLOWED)
    .flatMap(([t, cols]) => cols.map((c) => `${t}.${c}`))
    .filter((tc) => !readable.some((r) => `${r.relname}.${r.attname}` === tc));
  report(missing.length === 0, 'can read every column the preflight needs', missing.join(', '));
} catch (error) {
  console.error(`Could not verify: ${error.message}`);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
console.log(failures === 0 ? '\nROLE VERIFIED READ-ONLY' : `\n${failures} check(s) failed — do NOT run the preflight with this role`);
process.exit(failures === 0 ? 0 : 2);
