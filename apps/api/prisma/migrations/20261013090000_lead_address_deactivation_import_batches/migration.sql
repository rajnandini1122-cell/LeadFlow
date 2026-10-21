-- Three related corrections, in one migration because they share a table and a
-- constraint: a real address on a lead, a deactivation lifecycle distinct from
-- archival, and import batches that make a bad import traceable and correctable.
--
-- SAFETY. Every column added is NULLABLE with no default, so no existing row
-- changes meaning. Both CHECK rewrites WIDEN what is permitted — they accept a
-- strict superset of the rows accepted today — and both unique-index rewrites
-- add one more exclusion clause, which also accepts a superset. Two new tables.
--
-- THIS MIGRATION CANNOT FAIL ON EXISTING DATA. Unlike
-- 20261002090000_lead_email_duplicate_guard, nothing here narrows a constraint,
-- so there is no preflight to run and no data condition that blocks it.
--
-- ONE TRANSACTION, EXPLICITLY. `prisma migrate deploy` does NOT wrap a
-- migration file in a transaction — verified: a failing second statement left
-- the first one applied. This file DROPS and RE-CREATES the two duplicate-lead
-- unique indexes, so an interruption between those statements (a lock timeout,
-- a dropped connection, a restarted runner) would leave production with NO
-- duplicate protection and the migration marked failed. Wrapped, it applies
-- completely or not at all.
--
-- The cost is that every lock is held until COMMIT. Measured on PostgreSQL 17
-- with 200,000 leads (123 MB): 2.2 s with `leads` locked for reads and writes.
-- `lock_timeout` bounds the WAIT for that lock, so a long-running query cannot
-- make this migration queue every other query on `leads` behind it; it fails
-- cleanly instead and can simply be re-run (after `prisma migrate resolve
-- --rolled-back 20261013090000_lead_address_deactivation_import_batches`).
--
-- Not yet applied in production at the time of this change (2026-10-21).

BEGIN;
SET LOCAL lock_timeout = '5s';

-- =============================================================================
-- 1. A REAL ADDRESS ON A LEAD
-- =============================================================================
--
-- THE DEFECT THIS FIXES. `leads` carried exactly one address field, `city`, and
-- nothing else — no street, no state, no postal code, no country. A CSV with
-- "Address Line 1", "State" and "PIN Code" columns therefore had nowhere to put
-- them: the importer could only drop them or concatenate them into a field that
-- means something else. Both are data loss, and the second is worse because it
-- looks like success.
--
-- WHERE THE ADDRESS BELONGS, and why it is here rather than on `contacts`:
--
--   * `leads` already denormalises `city`, `company_name`, `email` and `mobile`
--     alongside the contact. The established rule in this schema is that a lead
--     holds what THIS enquiry said, while the contact holds the person. These
--     columns follow that rule rather than inventing a second one.
--   * An export business genuinely needs two leads for one person to carry two
--     different delivery addresses. An address held only on the contact could
--     not express that; the second enquiry would silently overwrite the first.
--   * `accounts` already has city/state/country for the COMPANY's own address,
--     which is a different fact from where this order ships.
--
-- `city` is deliberately NOT touched or widened. It already exists, it is
-- already mapped, and renaming or re-typing it would be a breaking change to
-- earn nothing.
ALTER TABLE "leads"
    ADD COLUMN "address_line1" VARCHAR(200),
    ADD COLUMN "address_line2" VARCHAR(200),
    ADD COLUMN "state"         VARCHAR(80),
    ADD COLUMN "postal_code"   VARCHAR(20),
    -- ISO 3166-1 alpha-2, like every other country column in this schema.
    -- VARCHAR(2) rather than free text so it can never hold "India" in one row
    -- and "IN" in the next, which is how a country filter stops working.
    ADD COLUMN "country"       VARCHAR(2);

-- `postal_code` is VARCHAR, not an integer, and that is not laziness. Indian
-- PIN codes have six digits and leading zeroes are real; UK and Canadian codes
-- contain letters and spaces. A numeric column would corrupt all three.

-- =============================================================================
-- 2. DEACTIVATION — A THIRD LIFECYCLE, DELIBERATELY NOT A FOURTH MEANING FOR
--    AN EXISTING ONE
-- =============================================================================
--
-- THE DEFECT THIS FIXES. An incorrectly imported lead could not be taken out of
-- the pipeline in a way that said WHY. The only tool was `deleted_at` (archive),
-- which records no reason, no actor beyond `updated_by`, and has no reverse
-- operation at all — so a mistaken archive was permanent.
--
-- THREE SEPARATE MEANINGS, kept separate on purpose:
--
--   status = 'LOST'   A real opportunity that was pursued and not won. It is
--                     business history and it counts in loss analysis. The most
--                     valuable question in the dataset is "why do we lose?",
--                     and filing import mistakes under LOST would poison it.
--
--   deleted_at        Archived. Removed from view, no reason recorded, no
--                     reversal. Left exactly as it is.
--
--   deactivated_at    This record should not exist as live work: a bad import
--                     row, a duplicate somebody created by mistake, a test
--                     lead. REVERSIBLE, REASONED, and ATTRIBUTED.
--
-- Collapsing these would be the easy choice and the wrong one. Each answers a
-- different question, and a single flag answers none of them.
ALTER TABLE "leads"
    ADD COLUMN "deactivated_at"      TIMESTAMPTZ(6),
    -- No foreign key, matching `created_by` and `updated_by` on this table.
    -- Those are deliberately FK-free so a SYSTEM write can leave them null and
    -- so removing a user cannot erase the record of what they did.
    ADD COLUMN "deactivated_by"      UUID,
    ADD COLUMN "deactivation_reason" VARCHAR(255);

-- -----------------------------------------------------------------------------
-- A deactivated lead needs no next action.
--
-- WIDENED, not replaced: the new predicate accepts every row the old one did,
-- plus rows that are deactivated. Without this, deactivating a NEW lead and
-- clearing its follow-up would violate the constraint and the operation would
-- fail with a database error instead of working.
--
-- The constraint itself stays, because it is the guarantee that no ACTIVE lead
-- is ever left with nothing to do — "no lead left behind" is enforced here, not
-- in application code that can be bypassed.
-- -----------------------------------------------------------------------------
ALTER TABLE "leads" DROP CONSTRAINT "leads_active_requires_followup";

ALTER TABLE "leads"
    ADD CONSTRAINT "leads_active_requires_followup"
    CHECK (
        "deleted_at" IS NOT NULL
        OR "deactivated_at" IS NOT NULL
        OR "status" IN ('WON', 'LOST')
        OR "next_follow_up_at" IS NOT NULL
    );

-- -----------------------------------------------------------------------------
-- A reason is not optional, and the database is what makes that true.
--
-- "Deactivated — no reason given" is useless to the next person who finds the
-- row, and a reason enforced only in a DTO is a reason that goes missing the
-- first time anything writes through another path. `btrim` is checked as well
-- as NULL so a single space cannot satisfy it.
-- -----------------------------------------------------------------------------
ALTER TABLE "leads"
    ADD CONSTRAINT "leads_deactivation_requires_reason"
    CHECK (
        "deactivated_at" IS NULL
        OR (
            "deactivation_reason" IS NOT NULL
            AND length(btrim("deactivation_reason")) > 0
        )
    );

-- =============================================================================
-- 3. DEACTIVATION RELEASES THE DUPLICATE KEY
-- =============================================================================
--
-- THE REASON THIS IS NOT OPTIONAL. The whole point of deactivating a wrongly
-- imported lead is to then create the RIGHT one — which carries the same mobile
-- number and the same email address. If a deactivated row kept holding the key,
-- the correction would be refused as a duplicate and the feature would be
-- useless for the case it exists to serve.
--
-- The consequence, which the application must handle and does: REACTIVATION CAN
-- NO LONGER BE ASSUMED TO SUCCEED. Between deactivating and reactivating, some
-- other active lead may have taken the number. So reactivation re-checks both
-- keys first and refuses with a 409 naming the lead that holds it, rather than
-- letting the insert fail with a raw constraint error. See
-- `LeadLifecycleService.reactivate`.
--
-- Both indexes are dropped and recreated rather than edited in place, because
-- PostgreSQL has no ALTER INDEX for a partial predicate.

DROP INDEX "leads_org_mobile_uniq";

CREATE UNIQUE INDEX "leads_org_mobile_uniq"
  ON "leads" ("organization_id", "mobile")
  WHERE "mobile" IS NOT NULL
    AND "deleted_at" IS NULL
    AND "deactivated_at" IS NULL
    AND "status" <> 'LOST'
    AND "duplicate_acknowledged_at" IS NULL;

-- Recreated with the same one-clause addition. Note that on a database where
-- 20261002090000 has not yet run, that migration builds this index and this one
-- immediately rebuilds it — a few seconds of wasted work on first deploy, and
-- the correct trade for keeping migration history append-only. Editing an
-- existing migration file would be the alternative, and a migration that
-- changes after it may already have been applied somewhere is not a migration.
DROP INDEX "leads_org_email_uniq";

CREATE UNIQUE INDEX "leads_org_email_uniq"
  ON "leads" ("organization_id", lower("email"))
  WHERE "email" IS NOT NULL
    AND "deleted_at" IS NULL
    AND "deactivated_at" IS NULL
    AND "status" <> 'LOST'
    AND "duplicate_acknowledged_at" IS NULL;

-- The inactive list: "show me what was deactivated, most recent first".
-- Partial, so it indexes only the rows it serves — in a healthy tenant that is
-- a handful out of every thousand, and a full index would be mostly NULLs.
CREATE INDEX "leads_org_deactivated_idx"
  ON "leads" ("organization_id", "deactivated_at" DESC)
  WHERE "deactivated_at" IS NOT NULL;

-- =============================================================================
-- 4. IMPORT BATCHES
-- =============================================================================
--
-- THE DEFECT THIS FIXES. An import produced a count and nothing else. Once the
-- response was closed there was no way to ask "which leads came from that bad
-- file?" — so correcting a mis-mapped import meant finding its rows by eye.
--
-- A row is written when an import RUNS. Preview writes nothing, which is the
-- contract preview exists to keep.
CREATE TABLE "lead_import_batches" (
    "id"              UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,

    -- As the uploader's browser reported it. Truncated, not trusted: it is
    -- displayed back to the same tenant and never used as a path.
    "file_name"       VARCHAR(255),

    -- WHICH COLUMN WENT WHERE, kept because it is the answer to "how did the
    -- address end up in the wrong field". Headers and field names only — no
    -- cell values, so this holds no customer data and needs no redaction path.
    "mapping"         JSONB NOT NULL,

    "total_rows"      INTEGER NOT NULL,
    "created_count"   INTEGER NOT NULL DEFAULT 0,
    "skipped_count"   INTEGER NOT NULL DEFAULT 0,
    "failed_count"    INTEGER NOT NULL DEFAULT 0,

    -- Who ran it. Nullable with no FK for the same reason as `deactivated_by`.
    "imported_by"     UUID,

    "started_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "completed_at"    TIMESTAMPTZ(6),

    CONSTRAINT "lead_import_batches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "lead_import_batches_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
    -- Carries the tenant into the composite key below, which is what lets
    -- `leads` reference a batch without being able to reference another
    -- tenant's batch.
    CONSTRAINT "lead_import_batches_id_organization_id_key" UNIQUE ("id", "organization_id")
);

CREATE INDEX "lead_import_batches_organization_id_started_at_idx"
    ON "lead_import_batches" ("organization_id", "started_at" DESC);

-- -----------------------------------------------------------------------------
-- Every imported lead keeps its batch reference.
--
-- COMPOSITE foreign key, matching every other tenant-carrying relation in this
-- schema: with a plain `batch_id` FK, a bug could attach one tenant's lead to
-- another tenant's batch and the database would permit it. Including
-- organization_id in the key makes that unrepresentable.
--
-- ON DELETE RESTRICT, and the choice was corrected after a test established
-- what the database actually does.
--
-- CASCADE is out of the question: deleting a batch record must never delete
-- customer leads, which is the destructive bulk operation this design refuses
-- to build.
--
-- SET NULL was written first and was WRONG — not merely suboptimal. On a
-- MULTI-COLUMN foreign key PostgreSQL sets EVERY referencing column to null,
-- including `organization_id`, which is NOT NULL. So the delete was refused by
-- a not-null violation while the comment claimed the link would be cleared:
-- the right outcome for the wrong reason, described incorrectly. PostgreSQL 15+
-- can scope it with `SET NULL (import_batch_id)`, but Prisma cannot express
-- that, so the schema would have gone on believing something else.
--
-- RESTRICT says plainly what happens, in SQL and in schema.prisma alike: a
-- batch cannot be deleted while any lead still points at it. That is also the
-- better behaviour — nulling the link would quietly make a badly mapped import
-- untraceable, which is the one thing this table exists to prevent. A batch
-- that created nothing is still freely deletable.
--
-- Asserted in test/schema-invariants.e2e-spec.ts, under "import batch
-- provenance".
-- -----------------------------------------------------------------------------
ALTER TABLE "leads" ADD COLUMN "import_batch_id" UUID;

ALTER TABLE "leads"
    ADD CONSTRAINT "leads_import_batch_id_organization_id_fkey"
    FOREIGN KEY ("import_batch_id", "organization_id")
    REFERENCES "lead_import_batches"("id", "organization_id")
    ON DELETE RESTRICT;

-- "Every lead from that batch", which is the correction workflow's only query.
-- Partial: a manually created lead has no batch, and in most tenants that is
-- almost every row.
CREATE INDEX "leads_import_batch_idx"
    ON "leads" ("organization_id", "import_batch_id")
    WHERE "import_batch_id" IS NOT NULL;

-- =============================================================================
-- 5. REUSABLE COLUMN MAPPINGS
-- =============================================================================
--
-- A tenant importing the same export every month should not re-map twelve
-- columns twelve times, and re-mapping by hand each time is where the wrong
-- mapping gets picked.
--
-- Holds header names and field names. No cell values, so no customer data.
CREATE TABLE "lead_import_mapping_templates" (
    "id"              UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "name"            VARCHAR(80) NOT NULL,
    "mapping"         JSONB NOT NULL,
    "created_by"      UUID,
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "lead_import_mapping_templates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "lead_import_mapping_templates_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
    -- One name per tenant, so "Tally export" means one thing inside an
    -- organization. Per tenant, never global.
    CONSTRAINT "lead_import_mapping_templates_org_name_key"
        UNIQUE ("organization_id", "name")
);

COMMIT;
