-- Structured call outcomes and the stated requirement, on the lead.
--
-- WHY. "Which customers did not answer?", "which are awaiting a response?" and
-- "when did we last actually speak to them?" could not be answered: an outcome
-- was free text on a follow-up, and a click on "Call" was logged as a completed
-- call before anyone had answered. These columns hold the facts the sales
-- workspace filters and sorts on.
--
-- SAFETY. ADDITIVE ONLY. Five NULLABLE columns with no default, which
-- PostgreSQL adds as a catalogue change without rewriting the table, and one
-- index. No existing row changes; the code production runs today ignores the
-- new columns. Nothing is backfilled: historical "call completed" entries were
-- written on a dial click, so deriving a last-contacted time from them would
-- invent contact that never happened. Legacy leads show "—" until a call is
-- logged.
--
-- ONE TRANSACTION, with a bounded lock wait — `prisma migrate deploy` does not
-- wrap a file itself. If `leads` is busy for 5 s the migration fails cleanly
-- with nothing applied and can be re-run after
-- `prisma migrate resolve --rolled-back 20261023090000_lead_call_outcomes_and_requirement`.
--
-- ROLLBACK (before any outcome has been logged, nothing is lost):
--   DROP INDEX "leads_organization_id_last_outcome_assigned_to_idx";
--   ALTER TABLE "leads" DROP COLUMN "last_outcome", DROP COLUMN "last_outcome_at",
--     DROP COLUMN "last_contacted_at", DROP COLUMN "requirement_quantity",
--     DROP COLUMN "expected_purchase_date";
-- After outcomes exist, dropping them loses that data; the timeline keeps each
-- call regardless, in lead_activities.metadata.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "leads"
    ADD COLUMN "last_outcome"           VARCHAR(40),
    ADD COLUMN "last_outcome_at"        TIMESTAMPTZ(6),
    ADD COLUMN "last_contacted_at"      TIMESTAMPTZ(6),
    ADD COLUMN "requirement_quantity"   VARCHAR(100),
    ADD COLUMN "expected_purchase_date" DATE;

CREATE INDEX "leads_organization_id_last_outcome_assigned_to_idx"
    ON "leads" ("organization_id", "last_outcome", "assigned_to");

COMMIT;
