-- Push delivery: device registry.
--
-- SAFETY: additive only. One enum, one table, two indexes, two foreign keys.
-- Nothing is dropped, rewritten or back-filled, and no existing row changes.
--
-- NOTE on `sessions.fcm_token`: that column already exists and is DEAD — no
-- code has ever written to it. It is deliberately left in place rather than
-- dropped, because dropping a column is a destructive migration and would break
-- the rolling-deploy property documented in docs/production.md. It is recorded
-- as debt instead.
--
-- It is also why this table exists rather than that column being used: refresh
-- rotation revokes the old session row and creates a replacement, so a push
-- token stored on a session would be destroyed roughly every fifteen minutes.

CREATE TYPE "push_provider" AS ENUM ('FCM');

CREATE TABLE "user_devices" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "platform" "device_platform" NOT NULL DEFAULT 'ANDROID',
    "provider" "push_provider" NOT NULL DEFAULT 'FCM',
    -- A credential. Never returned by an API, never logged, never placed in a
    -- notification payload or a metric label.
    "token" VARCHAR(500) NOT NULL,
    "label" VARCHAR(120),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deactivated_at" TIMESTAMPTZ(6),
    "deactivated_reason" VARCHAR(120),
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_devices_pkey" PRIMARY KEY ("id")
);

-- Re-registering the same token updates the existing row rather than adding a
-- second one. FCM refreshes tokens on reinstall and on some upgrades; without
-- this, every refresh would leave a dead row behind that the fan-out keeps
-- trying and the provider keeps rejecting.
--
-- Scoped to the organization rather than globally unique: the same physical
-- handset can legitimately be registered by two people in two tenants, and a
-- global constraint would let one tenant's registration silently deny another's.
CREATE UNIQUE INDEX "user_devices_organization_id_token_key"
    ON "user_devices" ("organization_id", "token");

-- The fan-out query: this user's active devices.
CREATE INDEX "user_devices_organization_id_user_id_active_idx"
    ON "user_devices" ("organization_id", "user_id", "active");

ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
