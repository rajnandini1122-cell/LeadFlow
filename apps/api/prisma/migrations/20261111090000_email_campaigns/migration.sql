-- =============================================================================
-- Email campaigns: mailbox settings, marketing eligibility, suppression,
-- templates, attachments, campaigns, the per-recipient delivery queue, the SMTP
-- attempt log and processed inbound mail.
-- =============================================================================
--
-- ADDITIVE ONLY. Eleven new tables, ten new enums, three new activity_type
-- values and one new notification_type value. No existing row or column changes. NOTHING is marketing-eligible
-- after this migration: marketing_consents starts empty, and absence means
-- "not eligible".
--
-- ROLLBACK: the previous API ignores these tables and never writes the new
-- activity types.
-- =============================================================================

-- CreateEnum
CREATE TYPE "email_security" AS ENUM ('SSL_TLS', 'STARTTLS');

-- CreateEnum
CREATE TYPE "marketing_consent_status" AS ENUM ('GRANTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "marketing_consent_basis" AS ENUM ('CONSENT', 'EXISTING_CUSTOMER', 'LEGITIMATE_INTEREST_REVIEWED');

-- CreateEnum
CREATE TYPE "email_suppression_reason" AS ENUM ('UNSUBSCRIBED', 'BOUNCED', 'COMPLAINT', 'MANUAL');

-- CreateEnum
CREATE TYPE "email_campaign_purpose" AS ENUM ('PROMOTIONAL', 'TRANSACTIONAL');

-- CreateEnum
CREATE TYPE "email_campaign_category" AS ENUM ('PROMOTIONAL_OFFER', 'PRODUCT_ANNOUNCEMENT', 'PRODUCT_CATALOGUE', 'SALES_FOLLOW_UP', 'CUSTOMER_UPDATE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "email_campaign_status" AS ENUM ('DRAFT', 'SCHEDULED', 'SENDING', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "email_recipient_status" AS ENUM ('QUEUED', 'SENDING', 'ACCEPTED', 'FAILED', 'UNCERTAIN', 'CANCELLED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "email_inbound_kind" AS ENUM ('REPLY', 'BOUNCE', 'OTHER');

-- AlterEnum


ALTER TYPE "activity_type" ADD VALUE 'EMAIL_SENT';
ALTER TYPE "activity_type" ADD VALUE 'EMAIL_FAILED';
ALTER TYPE "activity_type" ADD VALUE 'EMAIL_REPLY_RECEIVED';
ALTER TYPE "notification_type" ADD VALUE 'EMAIL_REPLY_RECEIVED';

BEGIN;
SET LOCAL lock_timeout = '5s';


-- CreateTable
CREATE TABLE "email_mailboxes" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "email_address" VARCHAR(320) NOT NULL,
    "description" VARCHAR(200),
    "username" VARCHAR(320) NOT NULL,
    "encrypted_password" TEXT NOT NULL,
    "password_updated_at" TIMESTAMPTZ(6) NOT NULL,
    "smtp_host" VARCHAR(253) NOT NULL,
    "smtp_port" INTEGER NOT NULL,
    "smtp_security" "email_security" NOT NULL,
    "imap_host" VARCHAR(253) NOT NULL,
    "imap_port" INTEGER NOT NULL,
    "imap_security" "email_security" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "hourly_limit" INTEGER NOT NULL DEFAULT 50,
    "daily_limit" INTEGER NOT NULL DEFAULT 300,
    "last_smtp_check_at" TIMESTAMPTZ(6),
    "last_smtp_ok_at" TIMESTAMPTZ(6),
    "last_smtp_error" VARCHAR(300),
    "last_imap_check_at" TIMESTAMPTZ(6),
    "last_imap_ok_at" TIMESTAMPTZ(6),
    "last_imap_error" VARCHAR(300),
    "imap_uid_validity" BIGINT,
    "imap_last_uid" BIGINT,
    "last_sync_at" TIMESTAMPTZ(6),
    "last_sync_error" VARCHAR(300),
    "last_sync_count" INTEGER,
    "dispatch_locked_by" VARCHAR(80),
    "dispatch_locked_until" TIMESTAMPTZ(6),
    "sync_locked_until" TIMESTAMPTZ(6),
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "email_mailboxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_consents" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "status" "marketing_consent_status" NOT NULL,
    "basis" "marketing_consent_basis" NOT NULL,
    "source" VARCHAR(60) NOT NULL,
    "note" VARCHAR(500),
    "recorded_by" UUID,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawn_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "marketing_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_suppressions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "reason" "email_suppression_reason" NOT NULL,
    "source" VARCHAR(60) NOT NULL,
    "campaign_id" UUID,
    "note" VARCHAR(500),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_templates" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "category" "email_campaign_category" NOT NULL,
    "subject" VARCHAR(200) NOT NULL,
    "html" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "archived_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "email_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_assets" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "product_id" UUID,
    "file_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(120) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "data" BYTEA NOT NULL,
    "uploaded_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "email_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_campaigns" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "category" "email_campaign_category" NOT NULL,
    "purpose" "email_campaign_purpose" NOT NULL,
    "status" "email_campaign_status" NOT NULL DEFAULT 'DRAFT',
    "template_id" UUID,
    "subject" VARCHAR(200) NOT NULL,
    "html" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "asset_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "filter" JSONB NOT NULL DEFAULT '{}',
    "scheduled_at" TIMESTAMPTZ(6),
    "submit_key" VARCHAR(80),
    "confirmed_at" TIMESTAMPTZ(6),
    "confirmed_by" UUID,
    "started_at" TIMESTAMPTZ(6),
    "paused_at" TIMESTAMPTZ(6),
    "pause_reason" VARCHAR(300),
    "completed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "selected_count" INTEGER NOT NULL DEFAULT 0,
    "eligible_count" INTEGER NOT NULL DEFAULT 0,
    "excluded" JSONB NOT NULL DEFAULT '{}',
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "email_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_campaign_recipients" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "lead_id" UUID,
    "contact_id" UUID,
    "email" VARCHAR(320) NOT NULL,
    "display_name" VARCHAR(200),
    "merge_data" JSONB NOT NULL DEFAULT '{}',
    "status" "email_recipient_status" NOT NULL DEFAULT 'QUEUED',
    "skip_reason" VARCHAR(40),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_by" VARCHAR(80),
    "locked_until" TIMESTAMPTZ(6),
    "message_id" VARCHAR(255) NOT NULL,
    "unsubscribe_token_hash" CHAR(64) NOT NULL,
    "last_smtp_code" INTEGER,
    "last_response" VARCHAR(500),
    "accepted_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "replied_at" TIMESTAMPTZ(6),
    "unsubscribed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "email_campaign_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_delivery_attempts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "worker" VARCHAR(80) NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "outcome" VARCHAR(20),
    "smtp_code" INTEGER,
    "response" VARCHAR(500),

    CONSTRAINT "email_delivery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_inbound_messages" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "uid_validity" BIGINT NOT NULL,
    "uid" BIGINT NOT NULL,
    "message_id" VARCHAR(998),
    "in_reply_to" VARCHAR(998),
    "from_address" VARCHAR(320),
    "subject" VARCHAR(500),
    "snippet" VARCHAR(1000),
    "received_at" TIMESTAMPTZ(6),
    "kind" "email_inbound_kind" NOT NULL,
    "recipient_id" UUID,
    "lead_id" UUID,
    "activity_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_inbound_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_mailboxes_organization_id_key" ON "email_mailboxes"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_mailboxes_id_organization_id_key" ON "email_mailboxes"("id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_consents_organization_id_email_key" ON "marketing_consents"("organization_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "email_suppressions_organization_id_email_key" ON "email_suppressions"("organization_id", "email");

-- CreateIndex
CREATE INDEX "email_templates_organization_id_archived_at_idx" ON "email_templates"("organization_id", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_templates_id_organization_id_key" ON "email_templates"("id", "organization_id");

-- CreateIndex
CREATE INDEX "email_assets_organization_id_created_at_idx" ON "email_assets"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "email_assets_id_organization_id_key" ON "email_assets"("id", "organization_id");

-- CreateIndex
CREATE INDEX "email_campaigns_organization_id_created_at_idx" ON "email_campaigns"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "email_campaigns_status_scheduled_at_idx" ON "email_campaigns"("status", "scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_campaigns_id_organization_id_key" ON "email_campaigns"("id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_campaigns_organization_id_submit_key_key" ON "email_campaigns"("organization_id", "submit_key");

-- CreateIndex
CREATE UNIQUE INDEX "email_campaign_recipients_message_id_key" ON "email_campaign_recipients"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_campaign_recipients_unsubscribe_token_hash_key" ON "email_campaign_recipients"("unsubscribe_token_hash");

-- CreateIndex
CREATE INDEX "email_campaign_recipients_status_next_attempt_at_idx" ON "email_campaign_recipients"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "email_campaign_recipients_organization_id_campaign_id_statu_idx" ON "email_campaign_recipients"("organization_id", "campaign_id", "status");

-- CreateIndex
CREATE INDEX "email_campaign_recipients_organization_id_email_idx" ON "email_campaign_recipients"("organization_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "email_campaign_recipients_campaign_id_email_key" ON "email_campaign_recipients"("campaign_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "email_campaign_recipients_id_organization_id_key" ON "email_campaign_recipients"("id", "organization_id");

-- CreateIndex
CREATE INDEX "email_delivery_attempts_organization_id_started_at_idx" ON "email_delivery_attempts"("organization_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_delivery_attempts_recipient_id_attempt_key" ON "email_delivery_attempts"("recipient_id", "attempt");

-- CreateIndex
CREATE INDEX "email_inbound_messages_organization_id_message_id_idx" ON "email_inbound_messages"("organization_id", "message_id");

-- CreateIndex
CREATE INDEX "email_inbound_messages_organization_id_recipient_id_idx" ON "email_inbound_messages"("organization_id", "recipient_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_inbound_messages_mailbox_id_uid_validity_uid_key" ON "email_inbound_messages"("mailbox_id", "uid_validity", "uid");

-- AddForeignKey
ALTER TABLE "email_mailboxes" ADD CONSTRAINT "email_mailboxes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_consents" ADD CONSTRAINT "marketing_consents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_assets" ADD CONSTRAINT "email_assets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_assets" ADD CONSTRAINT "email_assets_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_campaigns" ADD CONSTRAINT "email_campaigns_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_campaign_recipients" ADD CONSTRAINT "email_campaign_recipients_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_campaign_recipients" ADD CONSTRAINT "email_campaign_recipients_campaign_id_organization_id_fkey" FOREIGN KEY ("campaign_id", "organization_id") REFERENCES "email_campaigns"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_campaign_recipients" ADD CONSTRAINT "email_campaign_recipients_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_campaign_recipients" ADD CONSTRAINT "email_campaign_recipients_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_delivery_attempts" ADD CONSTRAINT "email_delivery_attempts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_delivery_attempts" ADD CONSTRAINT "email_delivery_attempts_recipient_id_organization_id_fkey" FOREIGN KEY ("recipient_id", "organization_id") REFERENCES "email_campaign_recipients"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_inbound_messages" ADD CONSTRAINT "email_inbound_messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_inbound_messages" ADD CONSTRAINT "email_inbound_messages_mailbox_id_organization_id_fkey" FOREIGN KEY ("mailbox_id", "organization_id") REFERENCES "email_mailboxes"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_inbound_messages" ADD CONSTRAINT "email_inbound_messages_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "email_campaign_recipients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_inbound_messages" ADD CONSTRAINT "email_inbound_messages_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- --- campaign sending providers (SMTP or the Resend HTTPS API) and provider events
-- CreateEnum
CREATE TYPE "email_sending_provider" AS ENUM ('SMTP', 'RESEND');

-- AlterTable
ALTER TABLE "email_mailboxes" ADD COLUMN     "api_key_hint" VARCHAR(16),
ADD COLUMN     "domain_verified_at" TIMESTAMPTZ(6),
ADD COLUMN     "encrypted_api_key" TEXT,
ADD COLUMN     "encrypted_webhook_secret" TEXT,
ADD COLUMN     "from_address" VARCHAR(320),
ADD COLUMN     "last_webhook_at" TIMESTAMPTZ(6),
ADD COLUMN     "provider_check_at" TIMESTAMPTZ(6),
ADD COLUMN     "provider_error" VARCHAR(300),
ADD COLUMN     "provider_ok_at" TIMESTAMPTZ(6),
ADD COLUMN     "sending_provider" "email_sending_provider" NOT NULL DEFAULT 'SMTP';

-- AlterTable
ALTER TABLE "email_campaign_recipients" ADD COLUMN     "complained_at" TIMESTAMPTZ(6),
ADD COLUMN     "delivered_at" TIMESTAMPTZ(6),
ADD COLUMN     "provider_message_id" VARCHAR(100);

-- AlterTable
ALTER TABLE "email_delivery_attempts" ADD COLUMN     "provider" "email_sending_provider" NOT NULL DEFAULT 'SMTP';

-- CreateTable
CREATE TABLE "email_provider_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "provider" "email_sending_provider" NOT NULL,
    "event_id" VARCHAR(100) NOT NULL,
    "type" VARCHAR(40) NOT NULL,
    "provider_message_id" VARCHAR(100),
    "recipient_id" UUID,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_provider_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_provider_events_organization_id_received_at_idx" ON "email_provider_events"("organization_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_provider_events_mailbox_id_event_id_key" ON "email_provider_events"("mailbox_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_campaign_recipients_provider_message_id_key" ON "email_campaign_recipients"("provider_message_id");

-- AddForeignKey
ALTER TABLE "email_provider_events" ADD CONSTRAINT "email_provider_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_provider_events" ADD CONSTRAINT "email_provider_events_mailbox_id_organization_id_fkey" FOREIGN KEY ("mailbox_id", "organization_id") REFERENCES "email_mailboxes"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- --- Resend Broadcasts: delivery channel, broadcast state machine, contact ledger
-- AlterTable
ALTER TABLE "email_mailboxes" ADD COLUMN     "api_key_access" VARCHAR(10),
ADD COLUMN     "encrypted_webhook_secret_previous" TEXT,
ADD COLUMN     "webhook_secret_rotated_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "email_campaigns" ADD COLUMN     "broadcast_error" VARCHAR(500),
ADD COLUMN     "broadcast_send_requested_at" TIMESTAMPTZ(6),
ADD COLUMN     "broadcast_retry_since" TIMESTAMPTZ(6),
ADD COLUMN     "broadcast_state" VARCHAR(30),
ADD COLUMN     "broadcast_state_at" TIMESTAMPTZ(6),
ADD COLUMN     "delivery_channel" VARCHAR(20),
ADD COLUMN     "provider_broadcast_id" VARCHAR(100),
ADD COLUMN     "provider_segment_id" VARCHAR(100);

-- CreateTable
CREATE TABLE "email_provider_contacts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "provider_contact_id" VARCHAR(100),
    "unsubscribed" BOOLEAN NOT NULL DEFAULT false,
    "unsubscribed_at" TIMESTAMPTZ(6),
    "unsubscribe_pending" BOOLEAN NOT NULL DEFAULT false,
    "unsubscribe_pushed_at" TIMESTAMPTZ(6),
    "last_synced_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "email_provider_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_provider_contacts_organization_id_unsubscribe_pending_idx" ON "email_provider_contacts"("organization_id", "unsubscribe_pending");

-- CreateIndex
CREATE UNIQUE INDEX "email_provider_contacts_organization_id_email_key" ON "email_provider_contacts"("organization_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "email_campaigns_provider_broadcast_id_key" ON "email_campaigns"("provider_broadcast_id");

-- AddForeignKey
ALTER TABLE "email_provider_contacts" ADD CONSTRAINT "email_provider_contacts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_provider_contacts" ADD CONSTRAINT "email_provider_contacts_mailbox_id_organization_id_fkey" FOREIGN KEY ("mailbox_id", "organization_id") REFERENCES "email_mailboxes"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- --- invariants the application relies on, enforced where they cannot be skipped
ALTER TABLE "email_mailboxes"
    ADD CONSTRAINT "email_mailboxes_smtp_port_check" CHECK ("smtp_port" IN (465, 587)),
    ADD CONSTRAINT "email_mailboxes_imap_port_check" CHECK ("imap_port" IN (993, 143)),
    ADD CONSTRAINT "email_mailboxes_limits_check" CHECK ("hourly_limit" BETWEEN 1 AND 1000 AND "daily_limit" BETWEEN 1 AND 10000 AND "hourly_limit" <= "daily_limit");
ALTER TABLE "email_campaign_recipients"
    ADD CONSTRAINT "email_campaign_recipients_email_lower_check" CHECK ("email" = lower("email")),
    ADD CONSTRAINT "email_campaign_recipients_attempts_check" CHECK ("attempts" >= 0);
ALTER TABLE "marketing_consents"
    ADD CONSTRAINT "marketing_consents_email_lower_check" CHECK ("email" = lower("email"));
ALTER TABLE "email_suppressions"
    ADD CONSTRAINT "email_suppressions_email_lower_check" CHECK ("email" = lower("email"));
ALTER TABLE "email_assets"
    ADD CONSTRAINT "email_assets_size_check" CHECK ("size_bytes" > 0 AND "size_bytes" <= 5242880);

-- --- the attempt log: written once, finished once, never removed
CREATE FUNCTION "email_delivery_attempts_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'email_delivery_attempts is append-only';
  END IF;
  IF OLD."finished_at" IS NOT NULL THEN
    RAISE EXCEPTION 'a finished delivery attempt cannot change';
  END IF;
  IF NEW."recipient_id" <> OLD."recipient_id" OR NEW."attempt" <> OLD."attempt" OR NEW."started_at" <> OLD."started_at" THEN
    RAISE EXCEPTION 'only the outcome of a delivery attempt can be recorded';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "email_delivery_attempts_guard" BEFORE UPDATE OR DELETE ON "email_delivery_attempts"
  FOR EACH ROW EXECUTE FUNCTION "email_delivery_attempts_guard"();


ALTER TABLE "email_campaigns"
    ADD CONSTRAINT "email_campaigns_delivery_channel_check"
        CHECK ("delivery_channel" IS NULL OR "delivery_channel" IN ('SMTP', 'RESEND_EMAIL', 'RESEND_BROADCAST')),
    ADD CONSTRAINT "email_campaigns_broadcast_state_check"
        CHECK ("broadcast_state" IS NULL OR "broadcast_state" IN (
            'PENDING', 'CONTACTS_SYNCED', 'SEGMENT_READY', 'DRAFT_CREATED',
            'SEND_REQUESTED', 'HANDED_OFF', 'CANCELLED_AT_PROVIDER', 'BLOCKED', 'NEEDS_REVIEW'));
ALTER TABLE "email_mailboxes"
    ADD CONSTRAINT "email_mailboxes_api_key_access_check"
        CHECK ("api_key_access" IS NULL OR "api_key_access" IN ('full', 'sending'));
ALTER TABLE "email_provider_contacts"
    ADD CONSTRAINT "email_provider_contacts_email_lower_check" CHECK ("email" = lower("email"));

-- --- an unsubscribe recorded in the provider ledger is permanent
CREATE FUNCTION "email_provider_contacts_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'email_provider_contacts keeps unsubscribe history; rows are never deleted';
  END IF;
  IF OLD."unsubscribed_at" IS NOT NULL AND (NEW."unsubscribed_at" IS NULL OR NEW."unsubscribed" = false) THEN
    RAISE EXCEPTION 'an unsubscribed contact cannot be resubscribed by LeadFlow';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "email_provider_contacts_guard" BEFORE UPDATE OR DELETE ON "email_provider_contacts"
  FOR EACH ROW EXECUTE FUNCTION "email_provider_contacts_guard"();

COMMIT;
