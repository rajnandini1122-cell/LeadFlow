-- AlterTable

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "archived_at" TIMESTAMPTZ(6),
ADD COLUMN     "archived_by" UUID,
ADD COLUMN     "archived_reason" VARCHAR(200),
ADD COLUMN     "potential_lead" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "potential_lead_signals" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "conversations_organization_id_archived_at_last_message_at_idx" ON "conversations"("organization_id", "archived_at", "last_message_at" DESC);

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_archived_by_fkey" FOREIGN KEY ("archived_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

