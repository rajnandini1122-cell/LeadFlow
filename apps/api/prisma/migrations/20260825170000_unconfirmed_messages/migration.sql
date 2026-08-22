-- AlterEnum
ALTER TYPE "message_delivery_status" ADD VALUE 'UNCONFIRMED';

-- AlterTable

-- CreateIndex
CREATE INDEX "messages_delivery_status_created_at_idx" ON "messages"("delivery_status", "created_at");

