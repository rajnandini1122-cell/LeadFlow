-- The server-to-server integration boundary: an intake inbox.
--
-- SAFETY: additive only. One enum, one table, one unique index, one lookup
-- index, one foreign key. Nothing is dropped, rewritten or back-filled, no
-- existing row changes, and no existing table is touched — so a rolling deploy
-- runs old and new code against this schema at the same time without either
-- noticing.
--
-- WHY A NEW TABLE rather than contact_enquiries: the public contact form and a
-- signed integration are different responsibilities with different owners. An
-- enquiry comes from an anonymous visitor who belongs to no organization and is
-- emailed to a sales mailbox; an intake arrives through an authenticated
-- integration configured for exactly one tenant and is CRM work in waiting.
-- Putting both in one table would have meant a nullable organization_id on a
-- table that must be tenant-scoped, which is the shape that lets a scoping bug
-- pass unnoticed.

CREATE TYPE "intake_status" AS ENUM ('RECEIVED', 'DUPLICATE', 'PROCESSED', 'FAILED');

CREATE TABLE "integration_intakes" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,

    "source" VARCHAR(40) NOT NULL,
    "external_event_id" VARCHAR(120) NOT NULL,
    "event_type" VARCHAR(60) NOT NULL,
    "status" "intake_status" NOT NULL DEFAULT 'RECEIVED',

    -- SHA-256 of the exact body bytes, hex. Distinguishes a retry of the same
    -- submission from a caller reusing an event id for a different one.
    "payload_hash" CHAR(64) NOT NULL,

    -- The submission, canonicalised on the way in: phone in E.164, country as
    -- ISO 3166-1 alpha-2. Deliberately typed columns rather than a JSON dump of
    -- the request — a raw copy of whatever a caller sent, kept forever, is a
    -- liability nobody can audit.
    "name" VARCHAR(150),
    "email" VARCHAR(320),
    "phone" VARCHAR(20),
    "country" VARCHAR(2),
    "company" VARCHAR(200),
    "message" VARCHAR(4000),
    "product_interest" VARCHAR(120),
    "source_page" VARCHAR(200),

    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    -- Written by the conversion phase. Its absence is what "not yet a Lead"
    -- means, and it is the column that answers "did this produce a Lead?".
    "created_lead_id" UUID,
    -- Duplicate SIGNALS. Recorded so a person can decide; never acted on
    -- automatically, and never a reason to modify the record they point at.
    "matched_contact_id" UUID,
    "matched_lead_id" UUID,
    "failure_reason" VARCHAR(400),

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "integration_intakes_pkey" PRIMARY KEY ("id")
);

-- IDEMPOTENCY, enforced here rather than in application code.
--
-- The application cannot do this with a read followed by an insert: two
-- identical requests arriving together both find nothing and both write, which
-- is precisely the case a retrying website produces. The index is what makes
-- the second one fail so it can be answered with the first one's receipt.
--
-- Scoped by organization and source as well as the event id, because two
-- integrations numbering their own events from 1 are not the same submission.
CREATE UNIQUE INDEX "integration_intakes_org_source_event_key"
    ON "integration_intakes" ("organization_id", "source", "external_event_id");

-- The review queue: what is waiting for this tenant, oldest first.
CREATE INDEX "integration_intakes_org_status_received_idx"
    ON "integration_intakes" ("organization_id", "status", "received_at");

ALTER TABLE "integration_intakes"
    ADD CONSTRAINT "integration_intakes_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
