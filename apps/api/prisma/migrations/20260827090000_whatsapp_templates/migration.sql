-- -----------------------------------------------------------------------------
-- WhatsApp message templates.
--
-- A CACHE of what Meta reported, not a source of truth. LeadFlow cannot create
-- a template and cannot approve one; every row here is a copy of something that
-- already exists in a Meta account, refreshed by an explicit sync.
--
-- Additive only: one new table, one new enum, one nullable column recording
-- when templates were last read back. Nothing existing is altered, so this
-- cannot fail against existing data.
-- -----------------------------------------------------------------------------
-- CreateEnum
CREATE TYPE "whatsapp_template_status" AS ENUM ('APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED');

-- AlterTable
ALTER TABLE "channel_integrations" ADD COLUMN     "templates_synced_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "whatsapp_templates" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "language" VARCHAR(20) NOT NULL,
    "category" VARCHAR(40),
    "status" "whatsapp_template_status" NOT NULL,
    "provider_template_id" VARCHAR(120),
    "components" JSONB NOT NULL,
    "supported" BOOLEAN NOT NULL DEFAULT false,
    "unsupported_reason" VARCHAR(300),
    "header_parameter_count" INTEGER NOT NULL DEFAULT 0,
    "body_parameter_count" INTEGER NOT NULL DEFAULT 0,
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "whatsapp_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "whatsapp_templates_organization_id_status_supported_idx" ON "whatsapp_templates"("organization_id", "status", "supported");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_templates_organization_id_name_language_key" ON "whatsapp_templates"("organization_id", "name", "language");

-- AddForeignKey
ALTER TABLE "whatsapp_templates" ADD CONSTRAINT "whatsapp_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_templates" ADD CONSTRAINT "whatsapp_templates_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "channel_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

