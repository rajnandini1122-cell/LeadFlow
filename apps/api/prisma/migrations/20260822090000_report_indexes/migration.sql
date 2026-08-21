-- Reporting indexes (Phase 6).
--
-- Purely additive: four indexes, no column or constraint changes, nothing
-- rewritten. Safe to apply to a live tenant.
--
-- Each one is justified by a query the reporting endpoints actually run. The
-- daily report's activity counts are deliberately NOT indexed separately —
-- lead_activities already has (organization_id, created_at DESC), which
-- narrows a one-day window to a handful of rows before the activity_type
-- filter applies.

-- "Won in range" and won-value totals filter on won_at. Every existing leads
-- index is keyed on created_at, status, mobile or contact_id, so none of them
-- can serve a won_at range scan.
CREATE INDEX IF NOT EXISTS "leads_organization_id_won_at_idx"
  ON "leads" ("organization_id", "won_at");

-- "Lost in range" and the lost-reason breakdown.
CREATE INDEX IF NOT EXISTS "leads_organization_id_lost_at_idx"
  ON "leads" ("organization_id", "lost_at");

-- Archived-in-range. Ordinary queries filter deleted_at IS NULL, which an
-- index cannot usefully serve; counting the archived rows is what needs this.
CREATE INDEX IF NOT EXISTS "leads_organization_id_deleted_at_idx"
  ON "leads" ("organization_id", "deleted_at");

-- Completed-in-range and the follow-up completion rate. The existing assignee
-- index is keyed on scheduled_at and cannot serve a completed_at range.
CREATE INDEX IF NOT EXISTS "follow_ups_organization_id_completed_at_idx"
  ON "follow_ups" ("organization_id", "completed_at");
