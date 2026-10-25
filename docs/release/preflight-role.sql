-- =============================================================================
-- leadflow_preflight — a READ-ONLY login role for scripts/production-preflight.mjs
-- =============================================================================
--
-- Run ONCE, as the database owner, only after explicit approval:
--   psql -v ON_ERROR_STOP=1 --single-transaction -f docs/release/preflight-role.sql
-- Then set its password interactively (never in this file, never on a command line):
--   psql -c "\password leadflow_preflight"      -- or from psql: \password leadflow_preflight
--
-- WHAT IT CAN DO: connect; read ONLY the columns the preflight reads.
-- WHAT IT CANNOT DO: INSERT, UPDATE, DELETE, TRUNCATE, CREATE, ALTER, DROP,
-- read any other table, or read the other columns of these tables (names,
-- phone numbers, notes, addresses, password hashes, tokens). Every one of its
-- sessions is read-only by default, time-limited, and the role expires.
--
-- It changes NO application object: only the new role and its grants.
-- Undo (after the release):  see the end of this file.
-- =============================================================================

-- Fails — and the whole file rolls back — if the role already exists, rather
-- than silently altering a role someone else created.
CREATE ROLE leadflow_preflight
  LOGIN
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  NOINHERIT                       -- gains nothing from any other role
  CONNECTION LIMIT 2              -- the preflight needs one
  PASSWORD NULL                   -- set separately with \password
  VALID UNTIL '2026-11-30';       -- expires on its own; extend only deliberately

-- Every session this role opens is read-only, cannot hang, and cannot hold
-- locks long enough to get in a migration's way.
ALTER ROLE leadflow_preflight SET default_transaction_read_only = on;
ALTER ROLE leadflow_preflight SET statement_timeout = '60s';
ALTER ROLE leadflow_preflight SET lock_timeout = '5s';
ALTER ROLE leadflow_preflight SET idle_in_transaction_session_timeout = '60s';

-- PUBLIC holds TEMP on every database by default, and any role may create a
-- large object. Both are refused in this role's read-only sessions; they
-- become possible only if a session deliberately switches read-only off, and
-- even then cannot touch any application object or row. They cannot be
-- revoked for one role without revoking them from PUBLIC — i.e. changing
-- every existing user — so they are capped and detected instead:
--   * temp_file_limit caps temporary disk use. It is a superuser-only
--     setting the role cannot override, so it is applied only when this file
--     runs as a superuser (Railway's postgres user is one).
--   * scripts/verify-preflight-role.mjs fails if the role owns any object or
--     large object; the undo below drops anything it ever created.
DO $$
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    ALTER ROLE leadflow_preflight SET temp_file_limit = '16MB';
  ELSE
    RAISE NOTICE 'Not a superuser: temp_file_limit not set for leadflow_preflight (the other limits still apply).';
  END IF;
END $$;

-- Connect to THIS database (named at run time, so the file works on any copy).
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO leadflow_preflight', current_database());
END $$;

-- Look up objects in the application schema. USAGE only: no CREATE.
GRANT USAGE ON SCHEMA public TO leadflow_preflight;

-- Column-level SELECT: exactly what the preflight reads, nothing more.
GRANT SELECT (migration_name, finished_at, rolled_back_at)
  ON public._prisma_migrations TO leadflow_preflight;

GRANT SELECT (id, organization_id, status, deleted_at, assigned_to, next_follow_up_at,
              email, duplicate_acknowledged_at)
  ON public.leads TO leadflow_preflight;          -- email: only lower(email) grouping for check F; never printed

GRANT SELECT (id, organization_id, lead_id, status, assigned_user_id, created_at)
  ON public.follow_ups TO leadflow_preflight;

GRANT SELECT (organization_id, lead_id)
  ON public.lead_activities TO leadflow_preflight;

GRANT SELECT (organization_id, user_id, status)
  ON public.organization_users TO leadflow_preflight;

GRANT SELECT (organization_id, action, entity_id, before, created_at)
  ON public.audit_logs TO leadflow_preflight;     -- before->>'assignedToId' only, for check A

-- Deliberately NOT granted: any other table, any other column, CREATE on the
-- database or any schema, and no ALTER DEFAULT PRIVILEGES — tables created
-- later are not readable by this role. Nothing granted to PUBLIC is changed.

-- =============================================================================
-- UNDO (after the release; run as the database owner, in this database):
--   DROP OWNED BY leadflow_preflight;   -- revokes its grants AND drops anything it created
--   DROP ROLE leadflow_preflight;
-- =============================================================================
