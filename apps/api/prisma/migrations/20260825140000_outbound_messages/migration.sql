-- CreateEnum
CREATE TYPE "message_delivery_status" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- AlterTable

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "delivery_status" "message_delivery_status",
ADD COLUMN     "failure_reason" VARCHAR(300),
ADD COLUMN     "idempotency_key" VARCHAR(120),
ADD COLUMN     "sent_by" UUID,
ALTER COLUMN "external_message_id" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "messages_organization_id_external_message_id_idx" ON "messages"("organization_id", "external_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_organization_id_idempotency_key_key" ON "messages"("organization_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sent_by_fkey" FOREIGN KEY ("sent_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

