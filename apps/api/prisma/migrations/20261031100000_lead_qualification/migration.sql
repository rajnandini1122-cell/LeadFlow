-- =============================================================================
-- Rough -> Refined lead qualification.
-- =============================================================================
--
-- THE NEED. New leads (website forms, WhatsApp, imports, manual entry) go
-- straight into the sales follow-up queues today, unverified. The business
-- wants them to start ROUGH -- researched and qualified -- and enter the sales
-- workflow only once somebody authorised marks them REFINED.
--
-- A QUALIFICATION, NOT A STAGE. A new enum column beside leads.status; no
-- existing stage changes meaning.
--
-- EXISTING DATA (decided before writing this, per the owner's brief):
--   * Every existing lead becomes REFINED, with refinement_outcome
--     'EXISTING_LEAD' and refined_at/refined_by left NULL (nobody refined them;
--     they predate the workflow). They are already being worked as sales leads,
--     so none is reset to Rough.
--   * No follow-up is touched: none cancelled, moved or rescheduled.
--   * Done by adding the column with DEFAULT 'REFINED' (every existing row
--     reads REFINED immediately), THEN switching the default to 'ROUGH' so only
--     rows inserted from now on start Rough.
--   * organization_settings.lead_qualification_enabled defaults to TRUE: every
--     organization has the workflow on. Setting it to false makes new leads
--     start Refined again, exactly as before -- no deploy needed.
--
-- DEPLOY WINDOW. Railway starts the new API and this migration in parallel. A
-- lead created by the OLD API after this runs gets the new default (ROUGH) and
-- the old API's first follow-up. That follow-up is kept, just hidden from the
-- queues until the lead is refined -- the same state as a lead reverted to
-- Rough, which the new code handles.
--
-- LOCKS. One short ALTER per table under a 5 s lock_timeout. The UPDATE of
-- refinement_outcome touches every lead row once (143 in production at the
-- time of writing).
--
-- ROLLBACK (only together with the previous API):
--   ALTER TABLE "leads" DROP COLUMN "qualification", DROP COLUMN "refined_at",
--     DROP COLUMN "refined_by", DROP COLUMN "refinement_outcome",
--     DROP COLUMN "refinement_note";
--   ALTER TABLE "organization_settings" DROP COLUMN "lead_qualification_enabled";
--   DROP TYPE "lead_qualification";
-- The previous API never reads these, so it runs unchanged with them present:
-- rolling back the API alone does NOT require rolling this back. Leads created
-- Rough in between would then simply be worked as before.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TYPE "lead_qualification" AS ENUM ('ROUGH', 'REFINED');

ALTER TABLE "leads"
    ADD COLUMN "qualification"      "lead_qualification" NOT NULL DEFAULT 'REFINED',
    ADD COLUMN "refined_at"         TIMESTAMPTZ(6),
    ADD COLUMN "refined_by"         UUID,
    ADD COLUMN "refinement_outcome" VARCHAR(40),
    ADD COLUMN "refinement_note"    VARCHAR(1000);

-- Existing leads: Refined, and say why.
UPDATE "leads" SET "refinement_outcome" = 'EXISTING_LEAD' WHERE "qualification" = 'REFINED' AND "refinement_outcome" IS NULL;

-- From now on, new leads start Rough.
ALTER TABLE "leads" ALTER COLUMN "qualification" SET DEFAULT 'ROUGH';

CREATE INDEX "leads_organization_id_qualification_status_idx"
    ON "leads" ("organization_id", "qualification", "status");

ALTER TABLE "organization_settings"
    ADD COLUMN "lead_qualification_enabled" BOOLEAN NOT NULL DEFAULT true;

COMMIT;
