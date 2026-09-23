-- CreateEnum
CREATE TYPE "conversation_link_state" AS ENUM ('UNLINKED', 'LINKED', 'REVIEW_REQUIRED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "activity_type" ADD VALUE 'CHANNEL_MESSAGE_RECEIVED';
ALTER TYPE "activity_type" ADD VALUE 'CONVERSATION_LINKED';
ALTER TYPE "activity_type" ADD VALUE 'CONVERSATION_UNLINKED';

-- AlterTable

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "link_state" "conversation_link_state" NOT NULL DEFAULT 'UNLINKED';

-- CreateIndex
CREATE INDEX "conversations_organization_id_link_state_last_message_at_idx" ON "conversations"("organization_id", "link_state", "last_message_at" DESC);

