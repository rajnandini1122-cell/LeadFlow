-- AlterEnum
ALTER TYPE "channel_integration_status" ADD VALUE 'CONNECTING';

-- AlterTable
ALTER TABLE "channel_integrations" ADD COLUMN     "access_token_hint" VARCHAR(16),
ADD COLUMN     "business_account_id" VARCHAR(120),
ADD COLUMN     "encrypted_access_token" TEXT;

-- AlterTable

