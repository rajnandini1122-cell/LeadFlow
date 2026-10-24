-- =============================================================================
-- LeadFlow stabilization — DATA REPAIR (DRAFT — NOT EXECUTED, NOT APPROVED)
-- =============================================================================
--
-- DO NOT RUN against production without: (1) 01-repair-preview.sql reviewed
-- with its counts, (2) a fresh backup / point-in-time-recovery marker, and
-- (3) explicit written approval. This file ENDS IN ROLLBACK ON PURPOSE: running
-- it as-is changes nothing. Committing requires a person to change the last
-- line to COMMIT after reading the counts it prints.
--
-- SCOPE — only what the preview proves, nothing inferred:
--   A. Open follow-ups still owed by a lead's PREVIOUS owner (audit-proven) are
--      handed to the lead's current owner.
--   C. Assigned live leads with a date and no open follow-up get one, AT THE
--      DATE THE LEAD ALREADY CARRIES. No date is invented.
--
-- DELIBERATELY NOT REPAIRED HERE:
--   B. Follow-ups owed by departed members — who should own them is a manager's
--      decision, made in the app by reassigning the lead (which, after this
--      release, moves the follow-up with it).
--   D. Unassigned leads — assigning them is a business decision, made in the
--      app with the new "Unassigned only" filter.
--
-- REVERSIBLE: every change is recorded in repair_20261021_follow_ups first;
-- 03-repair-undo.DRAFT.sql restores exactly those rows from it.
--
-- Production schema (main @ d909b89). If 20261013090000 has been applied,
-- add `AND l.deactivated_at IS NULL` to the section C predicate.
-- =============================================================================

BEGIN;

-- Bounded lock wait: if the app is holding a lead row, give up rather than
-- queueing behind it and stalling agents.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS repair_20261021_follow_ups (
  follow_up_id         uuid        NOT NULL,
  lead_id              uuid        NOT NULL,
  organization_id      uuid        NOT NULL,
  kind                 text        NOT NULL CHECK (kind IN ('reassigned', 'created')),
  old_assigned_user_id uuid,
  new_assigned_user_id uuid        NOT NULL,
  repaired_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follow_up_id)
);

-- ---------------------------------------------------------------------------
-- A. Hand stale follow-ups to the current owner.
-- ---------------------------------------------------------------------------
WITH stale AS (
  SELECT DISTINCT f.id, f.lead_id, f.organization_id, f.assigned_user_id, l.assigned_to
    FROM follow_ups f
    JOIN leads l ON l.id = f.lead_id
    JOIN audit_logs a
      ON a.organization_id = f.organization_id
     AND a.action = 'lead.assigned'
     AND a.entity_id = l.id
     AND (a.before ->> 'assignedToId')::uuid = f.assigned_user_id
     AND a.created_at >= f.created_at
   WHERE f.status IN ('UPCOMING', 'DUE', 'OVERDUE')
     AND l.deleted_at IS NULL
     AND l.status NOT IN ('WON', 'LOST')
     AND l.assigned_to IS NOT NULL
     AND f.assigned_user_id <> l.assigned_to
),
logged AS (
  INSERT INTO repair_20261021_follow_ups
         (follow_up_id, lead_id, organization_id, kind, old_assigned_user_id, new_assigned_user_id)
  SELECT id, lead_id, organization_id, 'reassigned', assigned_user_id, assigned_to FROM stale
  ON CONFLICT (follow_up_id) DO NOTHING
  RETURNING follow_up_id, new_assigned_user_id
)
UPDATE follow_ups f
   SET assigned_user_id = logged.new_assigned_user_id,
       updated_at = now()
  FROM logged
 WHERE f.id = logged.follow_up_id
   AND f.status IN ('UPCOMING', 'DUE', 'OVERDUE');   -- still open at write time

-- ---------------------------------------------------------------------------
-- C. Give a queue row to assigned, dated leads that have none.
-- ---------------------------------------------------------------------------
WITH missing AS (
  SELECT l.id AS lead_id, l.organization_id, l.assigned_to, l.next_follow_up_at
    FROM leads l
   WHERE l.deleted_at IS NULL
     AND l.status NOT IN ('WON', 'LOST')
     AND l.assigned_to IS NOT NULL
     AND l.next_follow_up_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM follow_ups f
                      WHERE f.lead_id = l.id
                        AND f.status IN ('UPCOMING', 'DUE', 'OVERDUE'))
),
created AS (
  INSERT INTO follow_ups
         (organization_id, lead_id, assigned_user_id, scheduled_at, type, status, title, notes, created_at, updated_at)
  SELECT organization_id, lead_id, assigned_to, next_follow_up_at, 'CALL',
         -- Same rule as the application: a date already passed is DUE now.
         CASE WHEN next_follow_up_at <= now() THEN 'DUE'::follow_up_status ELSE 'UPCOMING'::follow_up_status END,
         'Next action', 'Restored by data repair 2026-10-21 (no queue row existed)', now(), now()
    FROM missing
  RETURNING id, lead_id, organization_id, assigned_user_id
)
INSERT INTO repair_20261021_follow_ups
       (follow_up_id, lead_id, organization_id, kind, old_assigned_user_id, new_assigned_user_id)
SELECT id, lead_id, organization_id, 'created', NULL, assigned_user_id FROM created;

-- ---------------------------------------------------------------------------
-- Report what this transaction did, then verify nothing is left to repair.
-- ---------------------------------------------------------------------------
SELECT kind, count(*) AS rows_changed
  FROM repair_20261021_follow_ups
 WHERE repaired_at = now()          -- now() is fixed for the transaction
 GROUP BY kind;

SELECT count(*) AS leads_still_missing_queue_row
  FROM leads l
 WHERE l.deleted_at IS NULL
   AND l.status NOT IN ('WON', 'LOST')
   AND l.assigned_to IS NOT NULL
   AND l.next_follow_up_at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM follow_ups f
                    WHERE f.lead_id = l.id
                      AND f.status IN ('UPCOMING', 'DUE', 'OVERDUE'));

-- Change to COMMIT only after reading the counts above, with approval.
ROLLBACK;
