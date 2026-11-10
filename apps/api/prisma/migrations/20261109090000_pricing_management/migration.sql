-- =============================================================================
-- Pricing management: a lifecycle for plan_prices, and its audit trail.
-- =============================================================================
--
-- ADDITIVE ONLY. Prices are unchanged: every existing plan_prices row becomes
-- a PUBLISHED version (it already is the live price), published at its
-- creation time by the catalogue. No payment, order or subscription is touched.
--
-- LIFECYCLE. A price change is a NEW version (plan_prices rows are never
-- edited after publication):
--   DRAFT      created by a platform super_admin; never used by checkout
--   PUBLISHED  live from effective_from (immediately, or at a scheduled time)
--   DISCARDED  a draft that was abandoned
-- Checkout uses, per interval, the PUBLISHED and active version with the
-- latest effective_from that is not in the future. A payment references the
-- exact version it was charged at, so no completed payment, existing
-- entitlement or already-created Razorpay order changes when prices change.
--
-- ROLLBACK: the previous API ignores these columns and the new table.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "plan_prices"
    ADD COLUMN "status"        VARCHAR(20)  NOT NULL DEFAULT 'PUBLISHED',
    ADD COLUMN "published_at"  TIMESTAMPTZ(6),
    ADD COLUMN "published_by"  VARCHAR(200),
    ADD COLUMN "created_by"    VARCHAR(200),
    ADD COLUMN "change_reason" VARCHAR(500);

UPDATE "plan_prices"
SET "published_at" = "created_at",
    "published_by" = 'system:catalogue',
    "created_by"   = 'system:catalogue'
WHERE "published_at" IS NULL;

CREATE INDEX "plan_prices_status_interval_effective_from_idx" ON "plan_prices" ("status", "interval", "effective_from");

CREATE TABLE "pricing_changes" (
    "id"            UUID           NOT NULL DEFAULT uuidv7(),
    "plan_id"       UUID           NOT NULL,
    "plan_price_id" UUID,
    "interval"      "billing_interval" NOT NULL,
    "action"        VARCHAR(40)    NOT NULL,
    "actor_ref"     VARCHAR(200)   NOT NULL,
    "reason"        VARCHAR(500)   NOT NULL,
    "before"        JSONB          NOT NULL,
    "after"         JSONB          NOT NULL,
    "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pricing_changes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pricing_changes_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "pricing_changes_created_at_idx" ON "pricing_changes" ("created_at");

CREATE FUNCTION "pricing_changes_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pricing_changes is append-only';
END;
$$;
CREATE TRIGGER "pricing_changes_no_update" BEFORE UPDATE OR DELETE ON "pricing_changes"
  FOR EACH ROW EXECUTE FUNCTION "pricing_changes_immutable"();

COMMIT;
