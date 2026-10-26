-- =============================================================================
-- LeadFlow stabilization — UNDO the data repair (DRAFT — NOT EXECUTED)
-- =============================================================================
--
-- Reverses exactly the rows recorded in repair_20261021_follow_ups by
-- 02-repair-apply.DRAFT.sql, and nothing else.
--
--   reassigned  → the follow-up goes back to its previous assignee, but only if
--                 nobody has changed its assignee since the repair.
--   created     → the follow-up is CANCELLED with a reason, never deleted, and
--                 only if it is still open and untouched. Cancelling keeps the
--                 history; the lead's next_follow_up_at mirror was never changed
--                 by the repair, so the CHECK constraint is unaffected.
--
-- Like the apply script it ENDS IN ROLLBACK; a person changes it to COMMIT.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

UPDATE follow_ups f
   SET assigned_user_id = r.old_assigned_user_id,
       updated_at = now()
  FROM repair_20261021_follow_ups r
 WHERE r.kind = 'reassigned'
   AND f.id = r.follow_up_id
   AND f.assigned_user_id = r.new_assigned_user_id;   -- untouched since the repair

UPDATE follow_ups f
   SET status = 'CANCELLED',
       cancelled_at = now(),
       cancelled_reason = 'Data repair undone',
       updated_at = now()
  FROM repair_20261021_follow_ups r
 WHERE r.kind = 'created'
   AND f.id = r.follow_up_id
   AND f.status IN ('UPCOMING', 'DUE', 'OVERDUE')
   AND f.completed_at IS NULL;

-- What was NOT undone because it changed after the repair — review by hand.
SELECT r.kind, r.follow_up_id, f.status, f.assigned_user_id
  FROM repair_20261021_follow_ups r
  JOIN follow_ups f ON f.id = r.follow_up_id
 WHERE (r.kind = 'reassigned' AND f.assigned_user_id <> r.old_assigned_user_id)
    OR (r.kind = 'created' AND f.status NOT IN ('CANCELLED'));

ROLLBACK;
