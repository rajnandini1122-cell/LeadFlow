-- =============================================================================
-- Additional phone numbers and email addresses on a lead.
-- =============================================================================
--
-- THE DEFECT THIS FIXES (production, 2026-10-30). A lead held exactly one
-- mobile and one email. A customer with an office landline, a second mobile
-- and a personal address had nowhere to put them, so they were typed into
-- "Product interest" — unsearchable free text that also hides what the
-- customer actually wants.
--
-- ADDITIVE ONLY. Two array columns, each defaulting to an empty array, so
-- every existing lead reads as "no additional contacts". No backfill, no data
-- change, no index (they are never queried on their own). On PostgreSQL 11+
-- adding a column with a constant default is a catalogue-only change: no
-- table rewrite, a brief ACCESS EXCLUSIVE lock bounded by lock_timeout.
--
-- Representation matches what Prisma generates for `String[] @default([])`
-- exactly, so `prisma migrate diff` stays clean for these columns.
--
-- Rollback (only if no row has been written since): 
--   ALTER TABLE "leads" DROP COLUMN "additional_emails", DROP COLUMN "additional_phones";
-- The code before this release never reads these columns, so it runs
-- unchanged with them present — rolling the API back does not require this.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "leads"
    ADD COLUMN "additional_emails" VARCHAR(320)[] DEFAULT ARRAY[]::VARCHAR(320)[],
    ADD COLUMN "additional_phones" VARCHAR(20)[]  DEFAULT ARRAY[]::VARCHAR(20)[];

COMMIT;
