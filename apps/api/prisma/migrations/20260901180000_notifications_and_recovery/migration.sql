-- Notifications, organization recovery safety, and the escalation marker.
--
-- SAFETY: additive only. One enum, one table, two nullable columns, three
-- indexes. Nothing is dropped, rewritten or back-filled, and no existing row
-- changes or becomes invalid.

-- 1. What a notification is about. Deliberately CLOSED: every value maps to a
--    hard-coded workflow in the follow-up worker. An open-ended type would
--    invite a generic workflow engine to be built by accident, one value at a
--    time, and that is explicitly out of scope.
CREATE TYPE "notification_type" AS ENUM (
    'FOLLOW_UP_DUE',
    'FOLLOW_UP_OVERDUE',
    'FOLLOW_UP_ESCALATED',
    'REPEAT_BUSINESS_CANDIDATE'
);

-- 2. The notification itself.
--
--    A table rather than a transient push, because a notification is EVIDENCE
--    that the system did its job. "No lead left behind" is only a real property
--    if there is a record that somebody was told; a push that failed to deliver
--    leaves nothing behind, and afterwards nobody can tell whether the reminder
--    happened or the rep ignored it.
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "notification_type" NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body" VARCHAR(1000),
    "entity_type" VARCHAR(40),
    "entity_id" UUID,
    "dedupe_key" VARCHAR(200) NOT NULL,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- THE idempotency mechanism, and the reason a retried job is safe.
--
-- A deterministic key ("followup:<id>:DUE") with a unique index behind it. A
-- worker that runs twice attempts the same insert twice; the second violates
-- this constraint, which is caught and ignored. That is a far stronger
-- guarantee than check-then-insert, which loses the race between the two.
--
-- Scoped to the organization rather than globally unique: two tenants may
-- legitimately generate the same key shape for their own records.
CREATE UNIQUE INDEX "notifications_organization_id_dedupe_key_key"
    ON "notifications" ("organization_id", "dedupe_key");

-- The bell: this user's unread notifications, newest first.
CREATE INDEX "notifications_organization_id_user_id_read_at_created_at_idx"
    ON "notifications" ("organization_id", "user_id", "read_at", "created_at" DESC);

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Organization recovery safety.
--
--    Every tenant table cascades from organizations, so a hard DELETE destroys
--    an entire customer in one statement with no undo. There is deliberately no
--    API that deletes an organization; this column exists so that the day one is
--    needed, the safe implementation is the obvious one — and so a manual
--    database operation has a reversible alternative sitting beside it.
ALTER TABLE "organizations" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);

-- 4. The third follow-up idempotency marker.
--
--    reminder_sent_at and overdue_notified_at already existed. Without this one
--    a retried escalation would notify the manager again on every sweep.
ALTER TABLE "follow_ups" ADD COLUMN "escalated_at" TIMESTAMPTZ(6);
