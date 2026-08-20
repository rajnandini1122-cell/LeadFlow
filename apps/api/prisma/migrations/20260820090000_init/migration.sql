-- =============================================================================
-- 20260820090000_init — IDEA001 Phase 1 (identity, tenancy, sessions, audit, CRM core)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- uuidv7(): time-ordered UUIDs.
--
-- Random v4 keys scatter inserts across the whole index, causing page splits and
-- cache churn on high-write tables like lead_activities. v7 embeds a millisecond
-- timestamp in the leading 48 bits, so inserts append to the right edge instead.
--
-- Implementation: take a v4 UUID, overlay its first 6 bytes with the current
-- Unix time in milliseconds, then flip the version nibble from 4 (0100) to
-- 7 (0111). set_bit() indexes bits LSB-first within each byte, so the version
-- nibble of byte 6 occupies bit indices 52..55; going from 0100 to 0111 means
-- setting bits 52 and 53. The RFC 4122 variant bits in byte 8 are already
-- correct and are left untouched.
--
-- Postgres 18 ships a native uuidv7(); this definition is skipped when one
-- already exists, so upgrading to PG 18 silently adopts the built-in.
-- -----------------------------------------------------------------------------
DO $outer$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'uuidv7' AND n.nspname = 'public'
  ) THEN
    EXECUTE $fn$
      CREATE FUNCTION public.uuidv7() RETURNS uuid
      LANGUAGE sql VOLATILE PARALLEL SAFE
      AS $body$
        SELECT encode(
          set_bit(
            set_bit(
              overlay(
                uuid_send(gen_random_uuid())
                PLACING substring(
                  int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
                  FROM 3
                )
                FROM 1 FOR 6
              ),
              52, 1
            ),
            53, 1
          ),
          'hex'
        )::uuid;
      $body$;
    $fn$;
  END IF;
END
$outer$;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "organization_status" AS ENUM ('TRIAL', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('ACTIVE', 'INVITED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "membership_status" AS ENUM ('ACTIVE', 'INVITED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "role_key" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'SALES_REP');

-- CreateEnum
CREATE TYPE "device_platform" AS ENUM ('WEB', 'ANDROID', 'IOS');

-- CreateEnum
CREATE TYPE "lead_status" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'FOLLOW_UP', 'QUOTATION_SENT', 'NEGOTIATION', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "lead_priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "activity_type" AS ENUM ('LEAD_CREATED', 'LEAD_UPDATED', 'LEAD_ASSIGNED', 'LEAD_REASSIGNED', 'CALL_COMPLETED', 'CALL_NOT_ANSWERED', 'CALL_BACK_LATER', 'WHATSAPP_OPENED', 'WHATSAPP_SENT', 'WHATSAPP_DELIVERED', 'WHATSAPP_READ', 'WHATSAPP_RECEIVED', 'NOTE_ADDED', 'STATUS_CHANGED', 'FOLLOW_UP_CREATED', 'FOLLOW_UP_COMPLETED', 'FOLLOW_UP_RESCHEDULED', 'LEAD_WON', 'LEAD_LOST');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
    "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "status" "organization_status" NOT NULL DEFAULT 'TRIAL',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_settings" (
    "organization_id" UUID NOT NULL,
    "followup_reminder_minutes" INTEGER NOT NULL DEFAULT 30,
    "followup_overdue_minutes" INTEGER NOT NULL DEFAULT 120,
    "escalate_to_manager" BOOLEAN NOT NULL DEFAULT false,
    "working_hours_start" VARCHAR(5) NOT NULL DEFAULT '09:30',
    "working_hours_end" VARCHAR(5) NOT NULL DEFAULT '18:30',
    "whatsapp_provider" VARCHAR(40),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organization_settings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "email" VARCHAR(320) NOT NULL,
    "password_hash" VARCHAR(255),
    "full_name" VARCHAR(150) NOT NULL,
    "mobile" VARCHAR(20),
    "avatar_url" VARCHAR(500),
    "status" "user_status" NOT NULL DEFAULT 'INVITED',
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_users" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "status" "membership_status" NOT NULL DEFAULT 'INVITED',
    "invite_token_hash" VARCHAR(64),
    "invite_expires_at" TIMESTAMPTZ(6),
    "invited_by" UUID,
    "joined_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organization_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID,
    "key" "role_key" NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(255),
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "key" VARCHAR(80) NOT NULL,
    "description" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "refresh_token_hash" VARCHAR(64) NOT NULL,
    "family_id" UUID NOT NULL,
    "device_id" VARCHAR(128),
    "device_name" VARCHAR(128),
    "platform" "device_platform" NOT NULL DEFAULT 'WEB',
    "fcm_token" VARCHAR(500),
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(400),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" VARCHAR(80),
    "replaced_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID,
    "actor_user_id" UUID,
    "action" VARCHAR(80) NOT NULL,
    "entity_type" VARCHAR(60),
    "entity_id" UUID,
    "before" JSONB,
    "after" JSONB,
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(400),
    "request_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "lead_number" VARCHAR(20) NOT NULL,
    "first_name" VARCHAR(80),
    "last_name" VARCHAR(80),
    "mobile" VARCHAR(20),
    "email" VARCHAR(320),
    "company_name" VARCHAR(200),
    "city" VARCHAR(80),
    "source" VARCHAR(60),
    "product_interest" VARCHAR(200),
    "estimated_value" DECIMAL(14,2),
    "status" "lead_status" NOT NULL DEFAULT 'NEW',
    "priority" "lead_priority" NOT NULL DEFAULT 'MEDIUM',
    "assigned_to" UUID,
    "assigned_by" UUID,
    "next_follow_up_at" TIMESTAMPTZ(6),
    "last_activity_at" TIMESTAMPTZ(6),
    "lost_reason" VARCHAR(255),
    "won_at" TIMESTAMPTZ(6),
    "lost_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_activities" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "activity_type" "activity_type" NOT NULL,
    "description" VARCHAR(1000),
    "metadata" JSONB,
    "performed_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "organizations_status_idx" ON "organizations"("status");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE UNIQUE INDEX "organization_users_invite_token_hash_key" ON "organization_users"("invite_token_hash");

-- CreateIndex
CREATE INDEX "organization_users_user_id_idx" ON "organization_users"("user_id");

-- CreateIndex
CREATE INDEX "organization_users_organization_id_status_idx" ON "organization_users"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "organization_users_organization_id_user_id_key" ON "organization_users"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_organization_id_key_key" ON "roles"("organization_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_revoked_at_idx" ON "sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "sessions_family_id_idx" ON "sessions"("family_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_created_at_idx" ON "audit_logs"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_created_at_idx" ON "audit_logs"("actor_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at" DESC);

-- CreateIndex
CREATE INDEX "leads_organization_id_status_idx" ON "leads"("organization_id", "status");

-- CreateIndex
CREATE INDEX "leads_organization_id_assigned_to_status_idx" ON "leads"("organization_id", "assigned_to", "status");

-- CreateIndex
CREATE INDEX "leads_organization_id_next_follow_up_at_idx" ON "leads"("organization_id", "next_follow_up_at");

-- CreateIndex
CREATE INDEX "leads_organization_id_mobile_idx" ON "leads"("organization_id", "mobile");

-- CreateIndex
CREATE INDEX "leads_organization_id_created_at_idx" ON "leads"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "leads_organization_id_lead_number_key" ON "leads"("organization_id", "lead_number");

-- CreateIndex
CREATE INDEX "lead_activities_organization_id_lead_id_created_at_idx" ON "lead_activities"("organization_id", "lead_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "lead_activities_organization_id_created_at_idx" ON "lead_activities"("organization_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_users" ADD CONSTRAINT "organization_users_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_users" ADD CONSTRAINT "organization_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_users" ADD CONSTRAINT "organization_users_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_users" ADD CONSTRAINT "organization_users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_performed_by_fkey" FOREIGN KEY ("performed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- =============================================================================
-- BUSINESS INVARIANTS
--
-- These objects cannot be expressed in schema.prisma. They are asserted by
-- test/schema-invariants.e2e-spec.ts, so if a future generated migration ever
-- drops one, CI fails rather than the guarantee silently disappearing.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- "NO LEAD LEFT BEHIND" (spec §1, §10).
--
-- Every lead that is not in a terminal status MUST carry a next action. As a
-- CHECK constraint this holds for every writer — API, background worker, CSV
-- import, a future integration, or a human with psql — not just the code paths
-- we remembered to guard.
-- -----------------------------------------------------------------------------
ALTER TABLE "leads"
  ADD CONSTRAINT "leads_active_requires_followup"
  CHECK (
    "deleted_at" IS NOT NULL
    OR "status" IN ('WON', 'LOST')
    OR "next_follow_up_at" IS NOT NULL
  );

-- -----------------------------------------------------------------------------
-- Duplicate lead detection (spec §23).
--
-- Mobile number is the primary duplicate key within an organization. Partial,
-- because a genuinely LOST lead may legitimately come back as a new enquiry
-- later, and soft-deleted rows must not block re-creation.
--
-- The API checks for an existing lead first and returns DUPLICATE_LEAD with the
-- existing id so the client can offer "Open existing lead"; this index is the
-- backstop for the race between two concurrent creates.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX "leads_org_mobile_uniq"
  ON "leads" ("organization_id", "mobile")
  WHERE "mobile" IS NOT NULL
    AND "deleted_at" IS NULL
    AND "status" <> 'LOST';

-- -----------------------------------------------------------------------------
-- Follow-up sweep index (Phase 6 worker).
--
-- The worker scans ACROSS tenants for due/overdue follow-ups, so this one is
-- deliberately not organization_id-first. Partial, because terminal leads are
-- never swept and would otherwise dominate the index as the table grows.
-- -----------------------------------------------------------------------------
CREATE INDEX "leads_followup_sweep_idx"
  ON "leads" ("next_follow_up_at")
  WHERE "next_follow_up_at" IS NOT NULL
    AND "deleted_at" IS NULL
    AND "status" NOT IN ('WON', 'LOST');

-- -----------------------------------------------------------------------------
-- Append-only timeline (spec §9: "do not destroy historical business activity").
--
-- Enforced in the database so that a bug, a bad migration, or a careless
-- console session cannot rewrite sales history.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "lead_activities_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'lead_activities is append-only (attempted %)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "lead_activities_no_update"
  BEFORE UPDATE ON "lead_activities"
  FOR EACH ROW EXECUTE FUNCTION "lead_activities_append_only"();
