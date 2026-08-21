-- CreateEnum
CREATE TYPE "channel_type" AS ENUM ('WHATSAPP', 'FACEBOOK', 'INSTAGRAM');

-- CreateEnum
CREATE TYPE "channel_integration_status" AS ENUM ('CONNECTED', 'DISCONNECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "conversation_status" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "message_direction" AS ENUM ('INCOMING', 'OUTGOING');

-- CreateEnum
CREATE TYPE "message_sender_type" AS ENUM ('CONTACT', 'AGENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "message_type" AS ENUM ('TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'LOCATION', 'STICKER', 'TEMPLATE', 'OTHER');

-- AlterTable

-- AlterTable
ALTER TABLE "organization_settings" ADD COLUMN     "omnichannel_auto_create_leads" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "omnichannel_enabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "channel_integrations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "channel" "channel_type" NOT NULL,
    "status" "channel_integration_status" NOT NULL DEFAULT 'DISCONNECTED',
    "provider_account_id" VARCHAR(120) NOT NULL,
    "display_name" VARCHAR(200),
    "credentials_ref" VARCHAR(200),
    "metadata" JSONB,
    "connected_by" UUID,
    "connected_at" TIMESTAMPTZ(6),
    "disconnected_at" TIMESTAMPTZ(6),
    "last_error_at" TIMESTAMPTZ(6),
    "last_error_message" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "channel_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "channel" "channel_type" NOT NULL,
    "integration_id" UUID NOT NULL,
    "external_conversation_id" VARCHAR(200) NOT NULL,
    "contact_id" UUID,
    "lead_id" UUID,
    "owner_id" UUID,
    "company_name" VARCHAR(200),
    "status" "conversation_status" NOT NULL DEFAULT 'OPEN',
    "last_message_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "channel" "channel_type" NOT NULL,
    "external_message_id" VARCHAR(200) NOT NULL,
    "direction" "message_direction" NOT NULL,
    "sender_type" "message_sender_type" NOT NULL,
    "message_type" "message_type" NOT NULL DEFAULT 'TEXT',
    "content" TEXT,
    "attachments" JSONB,
    "metadata" JSONB,
    "sent_at" TIMESTAMPTZ(6),
    "received_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_channel_identities" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "channel" "channel_type" NOT NULL,
    "external_user_id" VARCHAR(200) NOT NULL,
    "username" VARCHAR(200),
    "phone_number" VARCHAR(20),
    "profile_name" VARCHAR(200),
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "contact_channel_identities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "channel_integrations_organization_id_channel_idx" ON "channel_integrations"("organization_id", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "channel_integrations_channel_provider_account_id_key" ON "channel_integrations"("channel", "provider_account_id");

-- CreateIndex
CREATE INDEX "conversations_organization_id_status_last_message_at_idx" ON "conversations"("organization_id", "status", "last_message_at" DESC);

-- CreateIndex
CREATE INDEX "conversations_organization_id_owner_id_status_idx" ON "conversations"("organization_id", "owner_id", "status");

-- CreateIndex
CREATE INDEX "conversations_organization_id_lead_id_idx" ON "conversations"("organization_id", "lead_id");

-- CreateIndex
CREATE INDEX "conversations_organization_id_contact_id_idx" ON "conversations"("organization_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_organization_id_channel_external_conversation_key" ON "conversations"("organization_id", "channel", "external_conversation_id");

-- CreateIndex
CREATE INDEX "messages_organization_id_conversation_id_created_at_idx" ON "messages"("organization_id", "conversation_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "messages_organization_id_channel_external_message_id_key" ON "messages"("organization_id", "channel", "external_message_id");

-- CreateIndex
CREATE INDEX "contact_channel_identities_organization_id_contact_id_idx" ON "contact_channel_identities"("organization_id", "contact_id");

-- CreateIndex
CREATE INDEX "contact_channel_identities_organization_id_channel_phone_nu_idx" ON "contact_channel_identities"("organization_id", "channel", "phone_number");

-- CreateIndex
CREATE UNIQUE INDEX "contact_channel_identities_organization_id_channel_external_key" ON "contact_channel_identities"("organization_id", "channel", "external_user_id");

-- AddForeignKey
ALTER TABLE "channel_integrations" ADD CONSTRAINT "channel_integrations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_integrations" ADD CONSTRAINT "channel_integrations_connected_by_fkey" FOREIGN KEY ("connected_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "channel_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_channel_identities" ADD CONSTRAINT "contact_channel_identities_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_channel_identities" ADD CONSTRAINT "contact_channel_identities_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "contacts_org_created_idx" RENAME TO "contacts_organization_id_created_at_idx";

-- RenameIndex
ALTER INDEX "contacts_org_email_idx" RENAME TO "contacts_organization_id_email_idx";

-- RenameIndex
ALTER INDEX "contacts_org_mobile_idx" RENAME TO "contacts_organization_id_mobile_idx";

-- RenameIndex
ALTER INDEX "follow_ups_org_lead_scheduled_idx" RENAME TO "follow_ups_organization_id_lead_id_scheduled_at_idx";

-- RenameIndex
ALTER INDEX "follow_ups_org_user_status_scheduled_idx" RENAME TO "follow_ups_organization_id_assigned_user_id_status_schedule_idx";

-- RenameIndex
ALTER INDEX "follow_ups_sweep_idx" RENAME TO "follow_ups_status_scheduled_at_idx";

-- RenameIndex
ALTER INDEX "leads_org_contact_idx" RENAME TO "leads_organization_id_contact_id_idx";

