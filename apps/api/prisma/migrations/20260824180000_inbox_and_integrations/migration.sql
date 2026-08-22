-- AlterTable
ALTER TABLE "channel_integrations" ADD COLUMN     "enabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable

-- AlterTable
ALTER TABLE "organization_settings" ADD COLUMN     "shared_unassigned_queue" BOOLEAN NOT NULL DEFAULT false;

