-- =============================================================================
-- 20260821100000_follow_ups
--
-- The follow-up engine's data model, plus the actual closed value on leads.
--
-- Additive only: two new enums, one new table, one new nullable column. No
-- existing row is read or modified, so this is safe against live tenant data.
--
-- Note on leads.next_follow_up_at: it STAYS. It is now a denormalised mirror of
-- the earliest open follow-up rather than the source of truth. It is kept
-- because the leads_active_requires_followup CHECK constraint depends on it —
-- that constraint is the guarantee that no active lead is ever left without a
-- next action — and because every list and dashboard query would otherwise need
-- a correlated subquery per row.
-- =============================================================================

DO $$ BEGIN
  CREATE TYPE "follow_up_status" AS ENUM ('UPCOMING', 'DUE', 'OVERDUE', 'COMPLETED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "follow_up_type" AS ENUM ('CALL', 'WHATSAPP', 'EMAIL', 'MEETING', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- What the deal ACTUALLY closed at, kept separate from estimated_value so
-- forecast accuracy stays measurable. Overwriting the estimate would destroy
-- the only evidence of how good the forecast was.
ALTER TABLE "leads"
  ADD COLUMN IF NOT EXISTS "won_value" DECIMAL(14,2);

CREATE TABLE IF NOT EXISTS "follow_ups" (
  "id"                  UUID              NOT NULL DEFAULT uuidv7(),
  "organization_id"     UUID              NOT NULL,
  "lead_id"             UUID              NOT NULL,
  "assigned_user_id"    UUID              NOT NULL,

  "scheduled_at"        TIMESTAMPTZ(6)    NOT NULL,
  "type"                "follow_up_type"  NOT NULL DEFAULT 'CALL',
  "status"              "follow_up_status" NOT NULL DEFAULT 'UPCOMING',
  "title"               VARCHAR(200),
  "notes"               VARCHAR(2000),

  "outcome"             VARCHAR(60),
  "completed_at"        TIMESTAMPTZ(6),
  "completed_by"        UUID,

  "cancelled_at"        TIMESTAMPTZ(6),
  "cancelled_reason"    VARCHAR(255),

  -- A reschedule creates a REPLACEMENT and links to it, so the chain of
  -- attempts stays visible instead of one row silently changing date.
  "rescheduled_to_id"   UUID,

  -- Idempotency markers for the Phase 6 worker: a notification that already
  -- fired must not fire again when a job is retried.
  "reminder_sent_at"    TIMESTAMPTZ(6),
  "overdue_notified_at" TIMESTAMPTZ(6),

  "created_by"          UUID,
  "created_at"          TIMESTAMPTZ(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMPTZ(6)    NOT NULL,

  CONSTRAINT "follow_ups_pkey" PRIMARY KEY ("id")
);

-- The hottest query: one person's own buckets (today / upcoming / overdue).
CREATE INDEX IF NOT EXISTS "follow_ups_org_user_status_scheduled_idx"
  ON "follow_ups" ("organization_id", "assigned_user_id", "status", "scheduled_at");

-- The lead timeline.
CREATE INDEX IF NOT EXISTS "follow_ups_org_lead_scheduled_idx"
  ON "follow_ups" ("organization_id", "lead_id", "scheduled_at" DESC);

-- Deliberately NOT organization-first: the Phase 6 sweep scans ACROSS tenants
-- for work that has come due. Partial, because closed follow-ups are never
-- swept and would otherwise come to dominate the index.
CREATE INDEX IF NOT EXISTS "follow_ups_sweep_idx"
  ON "follow_ups" ("status", "scheduled_at")
  WHERE "status" IN ('UPCOMING', 'DUE');

ALTER TABLE "follow_ups"
  DROP CONSTRAINT IF EXISTS "follow_ups_organization_id_fkey";
ALTER TABLE "follow_ups"
  ADD CONSTRAINT "follow_ups_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "follow_ups"
  DROP CONSTRAINT IF EXISTS "follow_ups_lead_id_fkey";
ALTER TABLE "follow_ups"
  ADD CONSTRAINT "follow_ups_lead_id_fkey"
  FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT, not SET NULL: assigned_user_id is NOT NULL because an unowned
-- follow-up is exactly the "nobody is responsible" state the product exists to
-- prevent. Members are soft-removed rather than deleted, so this never fires in
-- normal operation.
ALTER TABLE "follow_ups"
  DROP CONSTRAINT IF EXISTS "follow_ups_assigned_user_id_fkey";
ALTER TABLE "follow_ups"
  ADD CONSTRAINT "follow_ups_assigned_user_id_fkey"
  FOREIGN KEY ("assigned_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
