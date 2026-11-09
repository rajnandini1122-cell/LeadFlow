-- =============================================================================
-- Subscription billing: 30-day trial, Premium plans, Razorpay payments,
-- entitlement decisions and platform administration.
-- =============================================================================
--
-- EXTENDS the existing plans/subscriptions model; it does not replace it.
-- ADDITIVE ONLY: new nullable columns, new tables, new enum values. Nothing is
-- dropped, renamed or rewritten, and no CRM data is touched.
--
-- EXISTING ORGANIZATIONS. Every existing customer subscription gets
-- entitlement_decision = 'PENDING_REVIEW'. The entitlement rules treat that as
-- "keeps access" whatever its trial dates say, so enabling enforcement later
-- cannot lock out an organization nobody has decided about. Each one also gets
-- an audit row saying so. Trial dates are left exactly as they are.
--
-- THE INTERNAL ORGANIZATION keeps no subscription row; its exemption remains
-- organizations.organization_type = 'INTERNAL' (one row, partial unique index).
--
-- Enum values are appended here but only USED by later transactions (the plan
-- prices that use LIFETIME are seeded by bootstrap), as PostgreSQL requires.
--
-- ROLLBACK: the previous API reads none of these columns or tables. To remove
-- them: drop the six new tables and the new columns; enum values cannot be
-- dropped and are harmless.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TYPE "billing_interval" ADD VALUE IF NOT EXISTS 'LIFETIME';
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'BILLING_REMINDER';
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'BILLING_EXPIRED';
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'BILLING_PAYMENT';

-- --- subscriptions: the entitlement record --------------------------------------
ALTER TABLE "subscriptions"
    ADD COLUMN "trial_starts_at"       TIMESTAMPTZ(6),
    ADD COLUMN "entitlement_decision"  VARCHAR(40),
    ADD COLUMN "decision_reason"       VARCHAR(500),
    ADD COLUMN "decision_at"           TIMESTAMPTZ(6),
    ADD COLUMN "decision_by"           VARCHAR(200),
    ADD COLUMN "lifetime"              BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "complimentary_until"   TIMESTAMPTZ(6),
    ADD COLUMN "exempt"                BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "access_hold"           VARCHAR(20),
    ADD COLUMN "plan_price_id"         UUID;

-- --- organizations: the protected deletion workflow -----------------------------
ALTER TABLE "organizations"
    ADD COLUMN "deletion_requested_at"  TIMESTAMPTZ(6),
    ADD COLUMN "deletion_scheduled_for" TIMESTAMPTZ(6),
    ADD COLUMN "deletion_reason"        VARCHAR(500),
    ADD COLUMN "deletion_requested_by"  VARCHAR(200);

-- --- plan_prices: versioned, server-controlled prices per interval ---------------
CREATE TABLE "plan_prices" (
    "id"                 UUID           NOT NULL DEFAULT uuidv7(),
    "plan_id"            UUID           NOT NULL,
    "interval"           "billing_interval" NOT NULL,
    "version"            INTEGER        NOT NULL,
    "currency"           VARCHAR(3)     NOT NULL,
    "base_amount_paise"  INTEGER        NOT NULL,
    "tax_rate_bp"        INTEGER        NOT NULL DEFAULT 0,
    "tax_inclusive"      BOOLEAN        NOT NULL DEFAULT false,
    "tax_amount_paise"   INTEGER        NOT NULL,
    "total_amount_paise" INTEGER        NOT NULL,
    "renewal"            VARCHAR(20)    NOT NULL,
    "active"             BOOLEAN        NOT NULL DEFAULT true,
    "effective_from"     TIMESTAMPTZ(6) NOT NULL,
    "effective_until"    TIMESTAMPTZ(6),
    "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "plan_prices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "plan_prices_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "plan_prices_amounts_check" CHECK ("base_amount_paise" > 0 AND "tax_amount_paise" >= 0 AND "total_amount_paise" > 0)
);
CREATE UNIQUE INDEX "plan_prices_plan_id_interval_version_key" ON "plan_prices" ("plan_id", "interval", "version");
CREATE INDEX "plan_prices_active_plan_id_idx" ON "plan_prices" ("active", "plan_id");

-- --- billing_payments: one row per Razorpay order LeadFlow creates ----------------
CREATE TABLE "billing_payments" (
    "id"                  UUID           NOT NULL DEFAULT uuidv7(),
    "organization_id"     UUID           NOT NULL,
    "plan_price_id"       UUID           NOT NULL,
    "interval"            "billing_interval" NOT NULL,
    "status"              VARCHAR(30)    NOT NULL,
    "currency"            VARCHAR(3)     NOT NULL,
    "base_amount_paise"   INTEGER        NOT NULL,
    "tax_amount_paise"    INTEGER        NOT NULL,
    "total_amount_paise"  INTEGER        NOT NULL,
    "refunded_paise"      INTEGER        NOT NULL DEFAULT 0,
    "receipt"             VARCHAR(40)    NOT NULL,
    "provider"            VARCHAR(20)    NOT NULL DEFAULT 'razorpay',
    "provider_order_id"   VARCHAR(60)    NOT NULL,
    "provider_payment_id" VARCHAR(60),
    "failure_reason"      VARCHAR(300),
    "created_by_user_id"  UUID,
    "period_start"        TIMESTAMPTZ(6),
    "period_end"          TIMESTAMPTZ(6),
    "paid_at"             TIMESTAMPTZ(6),
    "last_checked_at"     TIMESTAMPTZ(6),
    "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "billing_payments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "billing_payments_plan_price_id_fkey" FOREIGN KEY ("plan_price_id") REFERENCES "plan_prices"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "billing_payments_provider_order_id_key" ON "billing_payments" ("provider_order_id");
CREATE UNIQUE INDEX "billing_payments_provider_payment_id_key" ON "billing_payments" ("provider_payment_id");
CREATE UNIQUE INDEX "billing_payments_receipt_key" ON "billing_payments" ("receipt");
CREATE INDEX "billing_payments_organization_id_created_at_idx" ON "billing_payments" ("organization_id", "created_at");
CREATE INDEX "billing_payments_status_created_at_idx" ON "billing_payments" ("status", "created_at");

-- --- billing_events: every verified provider event, once ------------------------
CREATE TABLE "billing_events" (
    "id"            UUID           NOT NULL DEFAULT uuidv7(),
    "provider"      VARCHAR(20)    NOT NULL,
    "event_id"      VARCHAR(80)    NOT NULL,
    "event_type"    VARCHAR(60)    NOT NULL,
    "payment_id"    UUID,
    "outcome"       VARCHAR(60)    NOT NULL,
    "received_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "billing_events_provider_event_id_key" ON "billing_events" ("provider", "event_id");

-- --- subscription_changes: the immutable entitlement audit trail ----------------
CREATE TABLE "subscription_changes" (
    "id"              UUID           NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID           NOT NULL,
    "action"          VARCHAR(60)    NOT NULL,
    "actor_type"      VARCHAR(20)    NOT NULL,
    "actor_ref"       VARCHAR(200)   NOT NULL,
    "reason"          VARCHAR(500)   NOT NULL,
    "before"          JSONB          NOT NULL,
    "after"           JSONB          NOT NULL,
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "subscription_changes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "subscription_changes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "subscription_changes_organization_id_created_at_idx" ON "subscription_changes" ("organization_id", "created_at");

-- Append-only, enforced by the database: an audit trail the application could
-- edit is not an audit trail.
CREATE FUNCTION "subscription_changes_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'subscription_changes is append-only';
END;
$$;
CREATE TRIGGER "subscription_changes_no_update" BEFORE UPDATE OR DELETE ON "subscription_changes"
  FOR EACH ROW EXECUTE FUNCTION "subscription_changes_immutable"();

-- --- trial_claims: one free trial per person -------------------------------------
-- A salted hash of the registering owner's normalized email. A second
-- organization registered by the same person starts without a free trial
-- (a platform administrator can grant one). No email is stored.
CREATE TABLE "trial_claims" (
    "fingerprint"     CHAR(64)       NOT NULL,
    "organization_id" UUID           NOT NULL,
    "claimed_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trial_claims_pkey" PRIMARY KEY ("fingerprint")
);

-- --- existing organizations: access preserved pending an explicit decision -------
UPDATE "subscriptions"
SET "entitlement_decision" = 'PENDING_REVIEW',
    "decision_reason"      = 'Existing organization at billing launch: access is preserved until a platform administrator records an entitlement decision.',
    "decision_at"          = CURRENT_TIMESTAMP,
    "decision_by"          = 'system:migration-20261107090000',
    "trial_starts_at"      = COALESCE("trial_starts_at", "current_period_start")
WHERE "entitlement_decision" IS NULL;

INSERT INTO "subscription_changes" ("organization_id", "action", "actor_type", "actor_ref", "reason", "before", "after")
SELECT s."organization_id",
       'migration.pending_review',
       'system',
       'migration-20261107090000',
       'Billing launch: existing organization keeps access until an explicit entitlement decision is recorded.',
       jsonb_build_object('status', s."status", 'trialEndsAt', s."trial_ends_at", 'entitlementDecision', NULL),
       jsonb_build_object('status', s."status", 'trialEndsAt', s."trial_ends_at", 'entitlementDecision', 'PENDING_REVIEW')
FROM "subscriptions" s
WHERE s."decision_by" = 'system:migration-20261107090000';

COMMIT;
