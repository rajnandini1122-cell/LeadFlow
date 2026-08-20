-- =============================================================================
-- 20260820140000_membership_lifecycle
--
-- Invitation lifecycle and soft member removal.
--
-- Additive only: new enum value, new nullable columns, new index. No existing
-- row is modified and no data is destroyed, so this is safe to run against a
-- live database.
-- =============================================================================

-- Soft removal. The membership row is retained rather than deleted so that
-- leads.assigned_to and lead_activities.performed_by keep pointing at a real
-- user — hard-deleting a member would erase who did what.
--
-- ADD VALUE cannot run inside a transaction block in older PostgreSQL, and
-- Prisma wraps migrations, so IF NOT EXISTS keeps this replayable.
ALTER TYPE "membership_status" ADD VALUE IF NOT EXISTS 'REMOVED';

-- Invitation state. Nullable because existing memberships pre-date invitations.
ALTER TABLE "organization_users"
  ADD COLUMN IF NOT EXISTS "invite_accepted_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "invite_revoked_at"  TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "removed_at"         TIMESTAMPTZ(6);

-- Lets an expiry sweep find candidates without scanning the whole table.
-- Partial: only rows that actually carry an invitation are ever of interest.
CREATE INDEX IF NOT EXISTS "organization_users_invite_expires_at_idx"
  ON "organization_users" ("invite_expires_at")
  WHERE "invite_expires_at" IS NOT NULL;
