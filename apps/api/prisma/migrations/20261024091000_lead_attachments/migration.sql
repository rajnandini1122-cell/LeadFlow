-- Files attached to leads: quotations, invoices, proformas, purchase orders,
-- product and sample photos, other documents.
--
-- SAFETY: a NEW, empty table. No existing table or row changes. Its foreign
-- keys take a brief SHARE ROW EXCLUSIVE lock on "leads" and "organizations"
-- (blocks writes only for the moment the constraint is added; the table is
-- empty so there is nothing to validate). One transaction with a bounded lock
-- wait — `prisma migrate deploy` does not wrap a file itself.
--
-- The bytes are stored in PostgreSQL (bytea), the same as user avatars: no
-- external storage service. Each file is capped at 10 MB by the API.
--
-- ROLLBACK: DROP TABLE "lead_attachments";  (loses attached files — export
-- them first if any exist).

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE "lead_attachments" (
    "id"              UUID           NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID           NOT NULL,
    "lead_id"         UUID           NOT NULL,
    "kind"            VARCHAR(30)    NOT NULL,
    "file_name"       VARCHAR(255)   NOT NULL,
    "mime_type"       VARCHAR(120)   NOT NULL,
    "size_bytes"      INTEGER        NOT NULL,
    "sha256"          VARCHAR(64)    NOT NULL,
    "data"            BYTEA          NOT NULL,
    "note"            VARCHAR(500),
    "amount"          DECIMAL(14, 2),
    "uploaded_by"     UUID,
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at"      TIMESTAMPTZ(6),
    "deleted_by"      UUID,

    CONSTRAINT "lead_attachments_pkey" PRIMARY KEY ("id"),
    -- A size is a fact about the stored bytes, and never negative.
    CONSTRAINT "lead_attachments_size_check" CHECK ("size_bytes" >= 0),
    CONSTRAINT "lead_attachments_amount_check" CHECK ("amount" IS NULL OR "amount" >= 0)
);

CREATE INDEX "lead_attachments_organization_id_lead_id_created_at_idx"
    ON "lead_attachments" ("organization_id", "lead_id", "created_at" DESC);
CREATE INDEX "lead_attachments_organization_id_kind_created_at_idx"
    ON "lead_attachments" ("organization_id", "kind", "created_at" DESC);

ALTER TABLE "lead_attachments"
    ADD CONSTRAINT "lead_attachments_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lead_attachments"
    ADD CONSTRAINT "lead_attachments_lead_id_fkey"
    FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
