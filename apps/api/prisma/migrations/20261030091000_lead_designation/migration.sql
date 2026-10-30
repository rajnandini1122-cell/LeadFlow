-- =============================================================================
-- The contact person's designation (job title) on a lead.
-- =============================================================================
--
-- Asked for on 2026-10-30: with first and last name, record what the person
-- does — "Purchase Manager", "Proprietor" — which decides how a salesperson
-- pitches and whether this is the person who signs.
--
-- ADDITIVE ONLY: one nullable column, no default, no backfill. Catalogue-only
-- change on PostgreSQL; brief lock bounded by lock_timeout.
--
-- Rollback (only if nothing has been written since):
--   ALTER TABLE "leads" DROP COLUMN "designation";
-- The code before this release never reads it.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "leads" ADD COLUMN "designation" VARCHAR(100);

COMMIT;
