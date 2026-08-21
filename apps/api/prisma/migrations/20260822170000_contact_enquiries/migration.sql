-- Public contact enquiries (Phase 8).
--
-- Additive: one table and one enum. No existing table is altered.
--
-- Deliberately has NO organization_id. The sender is an anonymous visitor who
-- belongs to no tenant, so the table is absent from TENANT_SCOPED_MODELS for
-- the same reason `plans` is — there is nothing to scope it to.

CREATE TYPE "enquiry_status" AS ENUM ('NEW', 'RESPONDED', 'SPAM');

CREATE TABLE "contact_enquiries" (
  "id"          UUID          NOT NULL DEFAULT uuidv7(),
  "name"        VARCHAR(150)  NOT NULL,
  "email"       VARCHAR(320)  NOT NULL,
  "company"     VARCHAR(200),
  "phone"       VARCHAR(32),
  "message"     VARCHAR(4000) NOT NULL,
  "source"      VARCHAR(60),
  "status"      "enquiry_status" NOT NULL DEFAULT 'NEW',
  -- NULL means the enquiry arrived but the notification was not accepted by
  -- the provider. That is the case worth alerting an operator about.
  "notified_at" TIMESTAMPTZ(6),
  -- Retained for abuse investigation only.
  "ip_address"  VARCHAR(64),
  "user_agent"  VARCHAR(400),
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "contact_enquiries_pkey" PRIMARY KEY ("id")
);

-- Triage queue: unanswered enquiries, newest first.
CREATE INDEX "contact_enquiries_status_created_at_idx"
  ON "contact_enquiries" ("status", "created_at" DESC);

-- Spotting one address submitting repeatedly.
CREATE INDEX "contact_enquiries_email_created_at_idx"
  ON "contact_enquiries" ("email", "created_at" DESC);
