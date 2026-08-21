-- =============================================================================
-- 20260821140000_contacts
--
-- Splits the person out of the lead.
--
-- ADDITIVE AND REVERSIBLE. One new table, one new nullable column, plus a
-- backfill that only INSERTs and only sets the new column. No existing lead
-- column is read destructively, renamed or dropped, so an older application
-- version keeps working against this schema unchanged.
--
-- Lead retains its own firstName/lastName/mobile/email/companyName/city. Those
-- are not redundant: they are the record of what was captured at the time, and
-- the duplicate-detection index leads_org_mobile_uniq depends on leads.mobile.
-- =============================================================================

CREATE TABLE IF NOT EXISTS "contacts" (
  "id"              UUID           NOT NULL DEFAULT uuidv7(),
  "organization_id" UUID           NOT NULL,
  "first_name"      VARCHAR(80),
  "last_name"       VARCHAR(80),
  "mobile"          VARCHAR(20),
  "email"           VARCHAR(320),
  "company_name"    VARCHAR(200),
  "city"            VARCHAR(80),
  "notes"           VARCHAR(2000),
  -- Set when merged INTO another contact. The row is retained so a lingering
  -- reference resolves rather than dangling.
  "merged_into_id"  UUID,
  "merged_at"       TIMESTAMPTZ(6),
  "deleted_at"      TIMESTAMPTZ(6),
  "created_by"      UUID,
  "updated_by"      UUID,
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "contacts_org_mobile_idx" ON "contacts" ("organization_id", "mobile");
CREATE INDEX IF NOT EXISTS "contacts_org_email_idx"  ON "contacts" ("organization_id", "email");
CREATE INDEX IF NOT EXISTS "contacts_org_created_idx" ON "contacts" ("organization_id", "created_at" DESC);

ALTER TABLE "contacts" DROP CONSTRAINT IF EXISTS "contacts_organization_id_fkey";
ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "contacts" DROP CONSTRAINT IF EXISTS "contacts_merged_into_id_fkey";
ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_merged_into_id_fkey"
  FOREIGN KEY ("merged_into_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Nullable on purpose. The backfill below cannot prove it covered every
-- historical row across every tenant, and a NOT NULL that fails partway through
-- a live migration is far worse than a nullable column the application always
-- populates from here on.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "contact_id" UUID;

CREATE INDEX IF NOT EXISTS "leads_org_contact_idx" ON "leads" ("organization_id", "contact_id");

ALTER TABLE "leads" DROP CONSTRAINT IF EXISTS "leads_contact_id_fkey";
ALTER TABLE "leads"
  ADD CONSTRAINT "leads_contact_id_fkey"
  FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- BACKFILL
--
-- One contact per distinct person per organization. "Distinct" is keyed on
-- mobile where present, because that is already the tenant-scoped duplicate key
-- enforced by leads_org_mobile_uniq. Leads with no mobile each get their own
-- contact: guessing that two nameless, numberless enquiries are the same person
-- would silently merge unrelated records, which is exactly what the manual
-- merge workflow exists to avoid.
--
-- Idempotent: only leads with contact_id IS NULL are considered, so re-running
-- creates nothing.
-- -----------------------------------------------------------------------------

-- 1. One contact per (organization, mobile) for leads that have a mobile.
WITH grouped AS (
  SELECT
    "organization_id",
    "mobile",
    -- Prefer the most recently updated lead's details as the canonical record.
    (ARRAY_AGG("first_name"   ORDER BY "updated_at" DESC))[1] AS first_name,
    (ARRAY_AGG("last_name"    ORDER BY "updated_at" DESC))[1] AS last_name,
    (ARRAY_AGG("email"        ORDER BY "updated_at" DESC))[1] AS email,
    (ARRAY_AGG("company_name" ORDER BY "updated_at" DESC))[1] AS company_name,
    (ARRAY_AGG("city"         ORDER BY "updated_at" DESC))[1] AS city,
    MIN("created_at") AS created_at
  FROM "leads"
  WHERE "contact_id" IS NULL AND "mobile" IS NOT NULL
  GROUP BY "organization_id", "mobile"
)
INSERT INTO "contacts" (
  "organization_id", "first_name", "last_name", "mobile", "email",
  "company_name", "city", "created_at", "updated_at"
)
SELECT
  organization_id, first_name, last_name, mobile, email,
  company_name, city, created_at, CURRENT_TIMESTAMP
FROM grouped;

UPDATE "leads" l
SET "contact_id" = c."id"
FROM "contacts" c
WHERE l."contact_id" IS NULL
  AND l."mobile" IS NOT NULL
  AND c."organization_id" = l."organization_id"
  AND c."mobile" = l."mobile";

-- 2. One contact per remaining lead (no mobile to group on).
WITH orphans AS (
  SELECT "id", "organization_id", "first_name", "last_name", "email",
         "company_name", "city", "created_at"
  FROM "leads"
  WHERE "contact_id" IS NULL
),
created AS (
  INSERT INTO "contacts" (
    "organization_id", "first_name", "last_name", "email",
    "company_name", "city", "created_at", "updated_at"
  )
  SELECT organization_id, first_name, last_name, email,
         company_name, city, created_at, CURRENT_TIMESTAMP
  FROM orphans
  RETURNING "id", "organization_id", "created_at", "first_name", "company_name"
)
UPDATE "leads" l
SET "contact_id" = c."id"
FROM created c
WHERE l."contact_id" IS NULL
  AND c."organization_id" = l."organization_id"
  AND c."created_at" = l."created_at"
  AND c."first_name" IS NOT DISTINCT FROM l."first_name"
  AND c."company_name" IS NOT DISTINCT FROM l."company_name";
