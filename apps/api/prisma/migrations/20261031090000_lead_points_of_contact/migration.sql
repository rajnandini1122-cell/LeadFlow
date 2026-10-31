-- =============================================================================
-- Several points of contact (POCs) per lead.
-- =============================================================================
--
-- THE NEED. A company enquiry often involves several people -- the purchase
-- manager who asks for a quote, the accounts person who pays, the owner who
-- signs off. A lead held exactly one person, so the others ended up in notes.
--
-- THE SHAPE. A join table between leads and the EXISTING contacts table, not a
-- second table of people. One phone number is one person across the
-- organization (contacts.mobile), so the buyer on two enquiries is one row
-- with two links.
--
-- ADDITIVE ONLY:
--   * contacts: three nullable columns (designation, department, whatsapp).
--   * follow_ups: one nullable column (contact_id), SET NULL on delete.
--   * lead_contacts: a new table.
-- Nothing is dropped or rewritten. leads.contact_id and the lead's own name /
-- mobile / email stay exactly as they are -- they are still the duplicate-
-- detection key and are what the running (old) API reads.
--
-- BACKFILL. Every lead that already has a contact gets that contact as its
-- primary POC, and the lead's designation is copied onto its contact where the
-- contact has none. Both are idempotent (ON CONFLICT DO NOTHING / IS NULL), so
-- a re-run changes nothing. A lead created by the OLD API after this migration
-- (the API and migration runner deploy in parallel) has no link yet; the new
-- API creates it on first read, so nothing is lost in that window.
--
-- LOCKS. Each ALTER is catalogue-only (nullable column, no default) under a
-- 5 s lock_timeout. The backfill reads leads and inserts into a table nobody
-- else uses yet.
--
-- ROLLBACK (only if the new API is rolled back too, and no POC has been added):
--   DROP TABLE "lead_contacts";
--   ALTER TABLE "follow_ups" DROP COLUMN "contact_id";
--   ALTER TABLE "contacts" DROP COLUMN "designation", DROP COLUMN "department", DROP COLUMN "whatsapp";
-- The previous API never reads any of these, so it runs unchanged with them
-- present: rolling back the API does NOT require rolling back this migration.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "contacts"
    ADD COLUMN "designation" VARCHAR(100),
    ADD COLUMN "department"  VARCHAR(60),
    ADD COLUMN "whatsapp"    VARCHAR(20);

ALTER TABLE "follow_ups" ADD COLUMN "contact_id" UUID;
ALTER TABLE "follow_ups"
    ADD CONSTRAINT "follow_ups_contact_id_fkey"
    FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "lead_contacts" (
    "id"              UUID           NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID           NOT NULL,
    "lead_id"         UUID           NOT NULL,
    "contact_id"      UUID           NOT NULL,
    "is_primary"      BOOLEAN        NOT NULL DEFAULT false,
    "notes"           VARCHAR(500),
    "inactive_at"     TIMESTAMPTZ(6),
    "inactive_by"     UUID,
    "created_by"      UUID,
    "updated_by"      UUID,
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_contacts_pkey" PRIMARY KEY ("id"),
    -- An inactive person cannot be the one to call.
    CONSTRAINT "lead_contacts_primary_is_active_check" CHECK (NOT ("is_primary" AND "inactive_at" IS NOT NULL))
);

CREATE UNIQUE INDEX "lead_contacts_lead_id_contact_id_key" ON "lead_contacts" ("lead_id", "contact_id");
CREATE INDEX "lead_contacts_organization_id_lead_id_idx" ON "lead_contacts" ("organization_id", "lead_id");
CREATE INDEX "lead_contacts_organization_id_contact_id_idx" ON "lead_contacts" ("organization_id", "contact_id");

-- One primary per lead. Two concurrent "set primary" requests cannot both win:
-- the second commit violates this index and the API answers with a retry.
CREATE UNIQUE INDEX "lead_contacts_one_primary" ON "lead_contacts" ("lead_id") WHERE "is_primary";

ALTER TABLE "lead_contacts"
    ADD CONSTRAINT "lead_contacts_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lead_contacts"
    ADD CONSTRAINT "lead_contacts_lead_id_fkey"
    FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lead_contacts"
    ADD CONSTRAINT "lead_contacts_contact_id_fkey"
    FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: the lead's existing contact becomes its primary POC.
INSERT INTO "lead_contacts" ("organization_id", "lead_id", "contact_id", "is_primary", "created_at", "updated_at")
SELECT l."organization_id", l."id", l."contact_id", true, l."created_at", CURRENT_TIMESTAMP
FROM "leads" l
WHERE l."contact_id" IS NOT NULL
ON CONFLICT DO NOTHING;

-- The designation captured on the lead belongs to the person; copy the most
-- recent one onto contacts that have none.
UPDATE "contacts" c
SET "designation" = d."designation"
FROM (
    SELECT DISTINCT ON ("contact_id") "contact_id", "designation"
    FROM "leads"
    WHERE "contact_id" IS NOT NULL AND "designation" IS NOT NULL AND btrim("designation") <> ''
    ORDER BY "contact_id", "updated_at" DESC
) d
WHERE c."id" = d."contact_id" AND c."designation" IS NULL;

COMMIT;
