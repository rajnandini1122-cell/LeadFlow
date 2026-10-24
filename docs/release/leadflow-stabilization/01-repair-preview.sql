-- =============================================================================
-- LeadFlow stabilization — PRODUCTION DATA-REPAIR PREVIEW (READ ONLY)
-- =============================================================================
--
-- WHAT THIS IS. Counts and lists the rows the stabilization release cannot fix
-- by itself, because they were written by the old code before it existed:
--
--   A. Open follow-ups still owed by a lead's PREVIOUS owner, left behind by a
--      reassignment (defect D2). Proven from the audit trail: the follow-up's
--      assignee is the `before.assignedToId` of a later `lead.assigned` entry.
--   B. Open follow-ups owed by someone who is no longer an active member of the
--      organization. Shown separately: the right new owner is a judgement call.
--   C. Assigned, live leads with a next-action date but NO open follow-up, so
--      they appear in no queue (defect D3, and older creation paths).
--   D. Unassigned live leads. Not damaged — listed so a manager can assign them,
--      because no follow-up queue can show a lead with no owner.
--
-- WHAT THIS IS NOT. It changes nothing. Every statement is a SELECT inside a
-- READ ONLY transaction that is rolled back; PostgreSQL itself refuses any write
-- attempted inside it. Run it against production only with read access, and
-- only when authorised.
--
-- SCHEMA. Written against the schema PRODUCTION runs today (main @ d909b89,
-- migrations through 20260930090000). It deliberately does not reference
-- `leads.deactivated_at`, which only exists after 20261013090000. Once that
-- migration is applied, add `AND l.deactivated_at IS NULL` to the C and D
-- predicates so deactivated leads are excluded.
--
-- PRIVACY. Section listings return ids, lead numbers and user ids — no names,
-- phone numbers or emails — so the output can be shared for review.
-- =============================================================================

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY;

-- One consistent snapshot for every query below, so the counts and the lists
-- describe the same moment.

-- -----------------------------------------------------------------------------
-- Summary: affected record counts, per organization
-- -----------------------------------------------------------------------------
WITH open_follow_ups AS (
  SELECT f.*
    FROM follow_ups f
   WHERE f.status IN ('UPCOMING', 'DUE', 'OVERDUE')
     AND f.lead_id IS NOT NULL
),
live_leads AS (
  SELECT l.*
    FROM leads l
   WHERE l.deleted_at IS NULL
     AND l.status NOT IN ('WON', 'LOST')
),
-- A: still owed by the person the lead was taken away from.
stale_owner AS (
  SELECT DISTINCT f.id AS follow_up_id, f.organization_id
    FROM open_follow_ups f
    JOIN live_leads l ON l.id = f.lead_id
    JOIN audit_logs a
      ON a.organization_id = f.organization_id
     AND a.action = 'lead.assigned'
     AND a.entity_id = l.id
     AND (a.before ->> 'assignedToId')::uuid = f.assigned_user_id
     AND a.created_at >= f.created_at          -- reassigned AFTER it was scheduled
   WHERE l.assigned_to IS NOT NULL
     AND f.assigned_user_id <> l.assigned_to
),
-- B: owed by someone who can no longer act on it.
departed_owner AS (
  SELECT f.id AS follow_up_id, f.organization_id
    FROM open_follow_ups f
    LEFT JOIN organization_users ou
      ON ou.organization_id = f.organization_id
     AND ou.user_id = f.assigned_user_id
     AND ou.status = 'ACTIVE'
   WHERE ou.user_id IS NULL
),
-- C: a promised next action with nothing in any queue.
missing_queue_row AS (
  SELECT l.id AS lead_id, l.organization_id
    FROM live_leads l
   WHERE l.assigned_to IS NOT NULL
     AND l.next_follow_up_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM open_follow_ups f WHERE f.lead_id = l.id)
),
-- D: nobody owns it.
unassigned AS (
  SELECT l.id AS lead_id, l.organization_id
    FROM live_leads l
   WHERE l.assigned_to IS NULL
)
SELECT o.slug,
       (SELECT count(*) FROM stale_owner       s WHERE s.organization_id = o.id) AS a_stale_owner_follow_ups,
       (SELECT count(*) FROM departed_owner    d WHERE d.organization_id = o.id) AS b_departed_owner_follow_ups,
       (SELECT count(*) FROM missing_queue_row m WHERE m.organization_id = o.id) AS c_leads_missing_queue_row,
       (SELECT count(*) FROM unassigned        u WHERE u.organization_id = o.id) AS d_unassigned_live_leads
  FROM organizations o
 ORDER BY o.slug;

-- -----------------------------------------------------------------------------
-- A. Listing: follow-up, its current assignee, and who the lead belongs to now
-- -----------------------------------------------------------------------------
SELECT DISTINCT ON (f.id)
       o.slug,
       l.lead_number,
       f.id                AS follow_up_id,
       f.scheduled_at,
       f.status            AS follow_up_status,
       f.assigned_user_id  AS owed_by_previous_owner,
       l.assigned_to       AS current_lead_owner,
       a.created_at        AS reassigned_at
  FROM follow_ups f
  JOIN leads l          ON l.id = f.lead_id
  JOIN organizations o  ON o.id = f.organization_id
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
 ORDER BY f.id, a.created_at DESC;

-- -----------------------------------------------------------------------------
-- B. Listing: follow-ups owed by someone no longer active in the organization
-- -----------------------------------------------------------------------------
SELECT o.slug,
       l.lead_number,
       f.id               AS follow_up_id,
       f.scheduled_at,
       f.assigned_user_id AS owed_by,
       l.assigned_to      AS current_lead_owner
  FROM follow_ups f
  JOIN leads l         ON l.id = f.lead_id
  JOIN organizations o ON o.id = f.organization_id
  LEFT JOIN organization_users ou
    ON ou.organization_id = f.organization_id
   AND ou.user_id = f.assigned_user_id
   AND ou.status = 'ACTIVE'
 WHERE f.status IN ('UPCOMING', 'DUE', 'OVERDUE')
   AND ou.user_id IS NULL
 ORDER BY o.slug, f.scheduled_at;

-- -----------------------------------------------------------------------------
-- C. Listing: assigned live leads with a date and no queue row
-- -----------------------------------------------------------------------------
SELECT o.slug,
       l.lead_number,
       l.id                AS lead_id,
       l.status,
       l.assigned_to,
       l.next_follow_up_at,
       (l.next_follow_up_at < now()) AS already_overdue
  FROM leads l
  JOIN organizations o ON o.id = l.organization_id
 WHERE l.deleted_at IS NULL
   AND l.status NOT IN ('WON', 'LOST')
   AND l.assigned_to IS NOT NULL
   AND l.next_follow_up_at IS NOT NULL
   AND NOT EXISTS (
         SELECT 1 FROM follow_ups f
          WHERE f.lead_id = l.id
            AND f.status IN ('UPCOMING', 'DUE', 'OVERDUE'))
 ORDER BY o.slug, l.next_follow_up_at;

-- -----------------------------------------------------------------------------
-- E. Sanity: open leads violating the "no lead left behind" rule.
-- The CHECK constraint should make this zero. Anything here means the
-- constraint is missing in production — stop and investigate before releasing.
-- -----------------------------------------------------------------------------
SELECT count(*) AS live_leads_without_next_action
  FROM leads l
 WHERE l.deleted_at IS NULL
   AND l.status NOT IN ('WON', 'LOST')
   AND l.next_follow_up_at IS NULL;

-- -----------------------------------------------------------------------------
-- F. MIGRATION PREFLIGHT for 20261002090000_lead_email_duplicate_guard.
-- That migration builds a UNIQUE index on (organization_id, lower(email)) over
-- live, unacknowledged leads. If any group below exists, the index build fails
-- and the migration aborts (nothing applied). Every group must be resolved in
-- the app first — acknowledge one as a deliberate duplicate, close it, or
-- correct the address — before that migration may run.
-- Ids and counts only; the address itself is not printed.
-- -----------------------------------------------------------------------------
SELECT o.slug,
       count(*)                                  AS leads_sharing_one_email,
       array_agg(l.lead_number ORDER BY l.created_at) AS lead_numbers
  FROM leads l
  JOIN organizations o ON o.id = l.organization_id
 WHERE l.email IS NOT NULL
   AND l.deleted_at IS NULL
   AND l.status <> 'LOST'
   AND l.duplicate_acknowledged_at IS NULL
 GROUP BY o.slug, l.organization_id, lower(l.email)
HAVING count(*) > 1
 ORDER BY o.slug;

ROLLBACK;
