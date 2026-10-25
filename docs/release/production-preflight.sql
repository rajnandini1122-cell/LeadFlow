-- =============================================================================
-- LeadFlow — PRODUCTION PREFLIGHT (READ ONLY) for PR #11 → #12 → #13
-- =============================================================================
--
-- Run BEFORE merging #11. Complements leadflow-stabilization/01-repair-preview.sql
-- (sections A–D: stale ownership, follow-ups owed by former members, leads in no
-- queue, unassigned leads; F: duplicate emails). Run both.
--
-- SAFETY. Every statement is a SELECT inside a READ ONLY transaction that is
-- rolled back; PostgreSQL refuses any write attempted inside it. Written for the
-- schema production runs today (migrations through 20260930090000) and valid on
-- the newer schema too. Output carries ids and counts only — no names, phones or
-- emails — so it can be shared for review.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/release/production-preflight.sql
--
-- Each check states its EXPECTED result. Anything else is a finding to resolve
-- before migrating, not a reason to edit this file.
-- =============================================================================

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY;

-- P1. Encoding. EXPECTED: UTF8 (migration 20261002 contains a non-ASCII character).
SELECT 'P1 encoding' AS check, pg_encoding_to_char(encoding) AS value
  FROM pg_database WHERE datname = current_database();

-- P2. Migration history. EXPECTED: last applied 20260930090000_website_enquiry_classification;
--     zero failed or rolled-back rows; none of 20261002…/20261013…/20261023…/20261024… yet.
SELECT 'P2 last applied' AS check, migration_name, finished_at
  FROM _prisma_migrations
 WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
 ORDER BY migration_name DESC LIMIT 3;
SELECT 'P2 failed or rolled back' AS check, count(*) AS rows
  FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL;
SELECT 'P2 release migrations already present' AS check, migration_name
  FROM _prisma_migrations
 WHERE migration_name >= '20261002' ORDER BY migration_name;

-- P3. Objects the release creates must not exist yet. EXPECTED: all false / 0.
SELECT 'P3 lead_attachments exists'       AS check, to_regclass('public.lead_attachments') IS NOT NULL AS value
UNION ALL
SELECT 'P3 leads.last_outcome exists',      EXISTS (SELECT 1 FROM information_schema.columns
                                             WHERE table_name = 'leads' AND column_name = 'last_outcome')
UNION ALL
SELECT 'P3 activity_type DOCUMENT_* exist', EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                                             WHERE t.typname = 'activity_type' AND e.enumlabel LIKE 'DOCUMENT_%');

-- P4. Live leads owned by someone who is not an ACTIVE member of that organization.
--     EXPECTED: 0. Such leads are in nobody's working queue.
SELECT 'P4 leads owned by non-active members' AS check, l.organization_id, count(*) AS leads
  FROM leads l
  LEFT JOIN organization_users ou
         ON ou.organization_id = l.organization_id AND ou.user_id = l.assigned_to
 WHERE l.deleted_at IS NULL
   AND l.assigned_to IS NOT NULL
   AND l.status NOT IN ('WON', 'LOST')
   AND (ou.user_id IS NULL OR ou.status <> 'ACTIVE')
 GROUP BY l.organization_id;

-- P5. Open follow-ups on a lead that is closed or deleted. EXPECTED: 0.
--     They inflate overdue counts for work that can never be done.
SELECT 'P5 open follow-ups on closed/deleted leads' AS check, f.organization_id, count(*) AS follow_ups
  FROM follow_ups f
  JOIN leads l ON l.id = f.lead_id
 WHERE f.status IN ('UPCOMING', 'DUE', 'OVERDUE')
   AND (l.deleted_at IS NOT NULL OR l.status IN ('WON', 'LOST'))
 GROUP BY f.organization_id;

-- P6. Organization isolation at the data level: child rows whose organization
--     differs from their lead's. EXPECTED: 0 in every row.
SELECT 'P6 follow_ups org ≠ lead org' AS check, count(*) AS rows
  FROM follow_ups f JOIN leads l ON l.id = f.lead_id
 WHERE f.organization_id <> l.organization_id
UNION ALL
SELECT 'P6 lead_activities org ≠ lead org', count(*)
  FROM lead_activities a JOIN leads l ON l.id = a.lead_id
 WHERE a.organization_id <> l.organization_id
UNION ALL
SELECT 'P6 lead owner not a member of the lead org', count(*)
  FROM leads l
 WHERE l.assigned_to IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM organization_users ou
                    WHERE ou.organization_id = l.organization_id AND ou.user_id = l.assigned_to);

-- P7. Sizes, for the migration lock-time estimate. Informational.
SELECT 'P7 rows' AS check, 'leads' AS table_name, count(*) FROM leads
UNION ALL SELECT 'P7 rows', 'follow_ups', count(*) FROM follow_ups
UNION ALL SELECT 'P7 rows', 'lead_activities', count(*) FROM lead_activities;

ROLLBACK;
