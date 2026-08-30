-- Customer / Account: the business relationship, distinct from a single enquiry.
--
-- SAFETY
--   Every statement is ADDITIVE except one deliberate WIDENING, called out
--   below. Nothing is dropped, renamed, rewritten or back-filled. No existing
--   row is modified and no existing row becomes invalid.
--
--   In particular the free-text company_name columns on leads, contacts and
--   conversations are LEFT ALONE. They are what was captured at the time and
--   they are the evidence the mapping screen shows a person; the account is a
--   grouping key placed beside them, not a replacement.
--
--   No accounts are created here. Deciding that two leads naming "ABC Foods"
--   and "ABC Foods Pvt Ltd" are one customer is a judgement, and a migration
--   that guessed it would silently merge two companies' histories with no undo.
--   Accounts are created by a person through the mapping screen.

-- 1. Lifecycle of a relationship. Separate from lead_status on purpose: a lead
--    ends, a relationship does not.
CREATE TYPE "account_status" AS ENUM ('PROSPECT', 'CUSTOMER', 'DORMANT', 'FORMER_CUSTOMER');

-- 2. The account itself.
CREATE TABLE "accounts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "normalized_name" VARCHAR(200) NOT NULL,
    "status" "account_status" NOT NULL DEFAULT 'PROSPECT',
    "industry" VARCHAR(80),
    "website" VARCHAR(255),
    "domain" VARCHAR(160),
    "phone" VARCHAR(20),
    "email" VARCHAR(320),
    "city" VARCHAR(80),
    "state" VARCHAR(80),
    "country" VARCHAR(2),
    "source" VARCHAR(60),
    "notes" VARCHAR(2000),
    "owner_id" UUID,
    "first_contact_at" TIMESTAMPTZ(6),
    "first_won_at" TIMESTAMPTZ(6),
    "last_won_at" TIMESTAMPTZ(6),
    "last_activity_at" TIMESTAMPTZ(6),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "merged_into_id" UUID,
    "merged_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- Deliberately NO unique index on (organization_id, normalized_name).
-- Two genuinely different companies can normalise identically, and a
-- constraint would refuse a legitimate record on the strength of a guess.
-- Duplicates are SUGGESTED with their matching fields and confirmed by a
-- person who holds account.merge.
CREATE INDEX "accounts_organization_id_status_last_activity_at_idx"
    ON "accounts" ("organization_id", "status", "last_activity_at" DESC);
CREATE INDEX "accounts_organization_id_normalized_name_idx"
    ON "accounts" ("organization_id", "normalized_name");
CREATE INDEX "accounts_organization_id_domain_idx"
    ON "accounts" ("organization_id", "domain");
CREATE INDEX "accounts_organization_id_owner_id_idx"
    ON "accounts" ("organization_id", "owner_id");
CREATE INDEX "accounts_organization_id_first_won_at_idx"
    ON "accounts" ("organization_id", "first_won_at");

ALTER TABLE "accounts" ADD CONSTRAINT "accounts_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_merged_into_id_fkey"
    FOREIGN KEY ("merged_into_id") REFERENCES "accounts"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. Contacts belong to an account. Nullable: a private individual has no
--    company, and the backfill refuses to invent one.
ALTER TABLE "contacts" ADD COLUMN "account_id" UUID;

CREATE INDEX "contacts_organization_id_account_id_idx"
    ON "contacts" ("organization_id", "account_id");

-- SET NULL, never CASCADE: removing an account must not delete the people.
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. Opportunities belong to an account.
ALTER TABLE "leads" ADD COLUMN "account_id" UUID;

CREATE INDEX "leads_organization_id_account_id_status_idx"
    ON "leads" ("organization_id", "account_id", "status");
CREATE INDEX "leads_organization_id_account_id_product_id_idx"
    ON "leads" ("organization_id", "account_id", "product_id");

-- SET NULL: removing an account must never delete the opportunities that are
-- the evidence of the relationship.
ALTER TABLE "leads" ADD CONSTRAINT "leads_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- 5. Follow-ups may hang off an account instead of a lead.
--
--    THE ONE NON-ADDITIVE STATEMENT: follow_ups.lead_id drops NOT NULL.
--
--    This is a WIDENING. It accepts strictly more than before, so every
--    existing row stays valid and every existing query keeps returning what it
--    returned. It is needed because "call ABC Foods on Monday about a repeat
--    order" is real work with no open enquiry behind it, and the alternative
--    was forcing a fake lead into the pipeline to record it — which would
--    corrupt conversion rate, pipeline value and every funnel figure.
--
--    Reversing it needs only lead_id to be NOT NULL again, which holds for
--    every row that existed before this migration.
ALTER TABLE "follow_ups" ADD COLUMN "account_id" UUID;
ALTER TABLE "follow_ups" ALTER COLUMN "lead_id" DROP NOT NULL;

-- Exactly one owner, never both and never neither. Without this a follow-up
-- could be attached to nothing and would appear on no screen at all — the one
-- outcome the product promise cannot tolerate.
-- Every pre-existing row has lead_id NOT NULL and account_id NULL, so this
-- holds for all of them at the moment it is added.
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_exactly_one_parent"
    CHECK (("lead_id" IS NOT NULL) <> ("account_id" IS NOT NULL));

CREATE INDEX "follow_ups_organization_id_account_id_status_scheduled_at_idx"
    ON "follow_ups" ("organization_id", "account_id", "status", "scheduled_at");

ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 6. Dormancy threshold is tenant configuration, not a constant. Crossing it
--    never changes a status by itself — it only puts an account on a review
--    list a person acts on.
ALTER TABLE "organization_settings"
    ADD COLUMN "account_dormant_after_days" INTEGER NOT NULL DEFAULT 180;
