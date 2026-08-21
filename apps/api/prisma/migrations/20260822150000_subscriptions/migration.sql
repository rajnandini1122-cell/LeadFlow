-- Subscription domain foundation (Phase 8).
--
-- Purely additive: two new tables and two new enums. No existing table is
-- altered, no column dropped, no data rewritten. Safe to apply to a live
-- tenant, and safe to roll back by dropping the two tables.
--
-- `plans` is deliberately GLOBAL — no organization_id. It is a catalogue every
-- tenant is offered, and the public pricing page reads it with no tenant
-- context at all. `subscriptions` IS tenant-owned and is registered in
-- TENANT_SCOPED_MODELS so the Prisma extension narrows every read.

CREATE TYPE "billing_interval" AS ENUM ('MONTHLY', 'YEARLY');

CREATE TYPE "subscription_status" AS ENUM (
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'CANCELLED',
  'EXPIRED'
);

CREATE TABLE "plans" (
  "id"               UUID           NOT NULL DEFAULT uuidv7(),
  "code"             VARCHAR(40)    NOT NULL,
  "name"             VARCHAR(80)    NOT NULL,
  "tagline"          VARCHAR(200),
  "description"      VARCHAR(500),
  "active"           BOOLEAN        NOT NULL DEFAULT true,
  "sort_order"       INTEGER        NOT NULL DEFAULT 0,
  "featured"         BOOLEAN        NOT NULL DEFAULT false,
  "currency"         VARCHAR(3)     NOT NULL,
  "monthly_price"    DECIMAL(12, 2) NOT NULL,
  "yearly_price"     DECIMAL(12, 2),
  "max_users"        INTEGER,
  "max_active_leads" INTEGER,
  "features"         TEXT[]         NOT NULL DEFAULT ARRAY[]::TEXT[],

  CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plans_code_key" ON "plans" ("code");
CREATE INDEX "plans_active_sort_order_idx" ON "plans" ("active", "sort_order");

CREATE TABLE "subscriptions" (
  "id"                       UUID        NOT NULL DEFAULT uuidv7(),
  "organization_id"          UUID        NOT NULL,
  "plan_id"                  UUID        NOT NULL,
  "status"                   "subscription_status" NOT NULL DEFAULT 'TRIAL',
  "billing_interval"         "billing_interval"    NOT NULL DEFAULT 'MONTHLY',
  "current_period_start"     TIMESTAMPTZ(6) NOT NULL,
  "current_period_end"       TIMESTAMPTZ(6) NOT NULL,
  "trial_ends_at"            TIMESTAMPTZ(6),
  "cancelled_at"             TIMESTAMPTZ(6),
  "provider"                 VARCHAR(40),
  "provider_customer_id"     VARCHAR(120),
  "provider_subscription_id" VARCHAR(120),
  "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- One live subscription per organization. A period history belongs to the
-- payment provider, which is the system of record for money.
CREATE UNIQUE INDEX "subscriptions_organization_id_key"
  ON "subscriptions" ("organization_id");

-- Status-first, deliberately NOT organization-first: the future renewal sweep
-- scans ACROSS tenants for periods that have ended.
CREATE INDEX "subscriptions_status_current_period_end_idx"
  ON "subscriptions" ("status", "current_period_end");

ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT, not CASCADE: deleting a plan somebody is paying for must fail
-- loudly rather than silently deleting their subscription.
ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_plan_id_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "plans" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
