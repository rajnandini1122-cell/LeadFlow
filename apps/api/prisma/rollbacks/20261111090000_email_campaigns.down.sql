-- Rollback for migration 20261111090000_email_campaigns (PRs #32–#37).
--
-- Only for an emergency return to the pre-email release, AFTER a verified
-- backup, with the email switches off and the old API image ready. It removes
-- every email table (mailboxes, eligibility, suppressions, campaigns, provider
-- ledger) and the four enum values the migration added, then forgets the
-- migration so `prisma migrate deploy` can apply it again later.
--
-- It REFUSES to run if lead history already holds email entries
-- (lead_activities is append-only and those rows would block the enum
-- rebuild), or if any email notification exists: in that case the data
-- decision belongs to the owner, not to this script.
--
-- Verified on a restored, sanitised production copy: see
-- docs/email/LEADFLOW_RESEND_BROADCASTS.md, "Migration and rollback test".

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "lead_activities"
    WHERE "activity_type"::text IN ('EMAIL_SENT', 'EMAIL_FAILED', 'EMAIL_REPLY_RECEIVED')
  ) THEN
    RAISE EXCEPTION 'rollback refused: lead history contains email activity';
  END IF;
  IF EXISTS (SELECT 1 FROM "notifications" WHERE "type"::text = 'EMAIL_REPLY_RECEIVED') THEN
    RAISE EXCEPTION 'rollback refused: email reply notifications exist';
  END IF;
END $$;

DROP TABLE "email_broadcast_reviews", "email_provider_contacts", "email_provider_events", "email_inbound_messages",
  "email_delivery_attempts", "email_campaign_recipients", "email_campaigns", "email_assets",
  "email_templates", "email_suppressions", "marketing_consents", "email_mailboxes";

DROP FUNCTION "email_delivery_attempts_guard"();
DROP FUNCTION "email_provider_contacts_guard"();
DROP FUNCTION "email_broadcast_reviews_guard"();

DROP TYPE "email_sending_provider", "email_inbound_kind", "email_recipient_status",
  "email_campaign_status", "email_campaign_category", "email_campaign_purpose",
  "email_suppression_reason", "marketing_consent_basis", "marketing_consent_status",
  "email_security";

-- PostgreSQL cannot drop an enum value: rebuild both types without them.
ALTER TYPE "activity_type" RENAME TO "activity_type_with_email";
CREATE TYPE "activity_type" AS ENUM ('LEAD_CREATED', 'LEAD_UPDATED', 'LEAD_ASSIGNED',
  'LEAD_REASSIGNED', 'CALL_COMPLETED', 'CALL_NOT_ANSWERED', 'CALL_BACK_LATER', 'WHATSAPP_OPENED',
  'WHATSAPP_SENT', 'WHATSAPP_DELIVERED', 'WHATSAPP_READ', 'WHATSAPP_RECEIVED', 'NOTE_ADDED',
  'STATUS_CHANGED', 'FOLLOW_UP_CREATED', 'FOLLOW_UP_COMPLETED', 'FOLLOW_UP_RESCHEDULED', 'LEAD_WON',
  'LEAD_LOST', 'CHANNEL_MESSAGE_RECEIVED', 'CONVERSATION_LINKED', 'CONVERSATION_UNLINKED',
  'DOCUMENT_ATTACHED', 'DOCUMENT_REMOVED');
ALTER TABLE "lead_activities"
  ALTER COLUMN "activity_type" TYPE "activity_type" USING "activity_type"::text::"activity_type";
DROP TYPE "activity_type_with_email";

ALTER TYPE "notification_type" RENAME TO "notification_type_with_email";
CREATE TYPE "notification_type" AS ENUM ('FOLLOW_UP_DUE', 'FOLLOW_UP_OVERDUE',
  'FOLLOW_UP_ESCALATED', 'REPEAT_BUSINESS_CANDIDATE', 'BILLING_REMINDER', 'BILLING_EXPIRED',
  'BILLING_PAYMENT');
ALTER TABLE "notifications"
  ALTER COLUMN "type" TYPE "notification_type" USING "type"::text::"notification_type";
DROP TYPE "notification_type_with_email";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261111090000_email_campaigns';

COMMIT;
