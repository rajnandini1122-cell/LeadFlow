-- Automated intake routing: a website enquiry becomes an assigned lead with a
-- mandatory first follow-up.
--
-- SAFETY: additive only. One enum value, one table, one settings column, nine
-- nullable columns on integration_intakes, two composite unique indexes on
-- existing tables, four indexes and six foreign keys. Nothing is dropped,
-- rewritten or back-filled: every historical intake keeps its status, and no
-- existing lead, follow-up or contact is touched.
--
-- Nothing here switches processing ON. That is INTAKE_AUTO_PROCESSING_ENABLED,
-- which defaults to false, so applying this migration converts nothing. The
-- separation is the point — a deploy that quietly started creating leads out of
-- a backlog of historical enquiries would be very hard to undo.

-- -----------------------------------------------------------------------------
-- BLOCKED: durable, valid, and waiting on configuration rather than on a fix.
--
-- Added rather than folded into FAILED because the two need different people.
-- FAILED means something went wrong on our side. BLOCKED means the enquiry is
-- perfectly good and the routing table has no answer for it yet — no rule
-- matches, or the team it matches has nobody who can take work. One is an
-- incident, the other is an administrator's to-do, and a queue that shows them
-- as the same thing teaches operators to ignore both.
-- -----------------------------------------------------------------------------
ALTER TYPE "intake_status" ADD VALUE IF NOT EXISTS 'BLOCKED';

-- -----------------------------------------------------------------------------
-- The first-response SLA, as tenant configuration.
--
-- 60 minutes is CRAVION's initial commitment. It is a column rather than a
-- constant because it is business policy: an organization selling differently
-- wants a different number without a deploy, and the value appears in exactly
-- one place instead of being spelled "+60 minutes" across three services.
-- -----------------------------------------------------------------------------
ALTER TABLE "organization_settings"
    ADD COLUMN "website_intake_first_follow_up_minutes" INTEGER NOT NULL DEFAULT 60;

ALTER TABLE "organization_settings"
    ADD CONSTRAINT "organization_settings_first_follow_up_minutes_chk"
    CHECK ("website_intake_first_follow_up_minutes" BETWEEN 1 AND 20160);

-- -----------------------------------------------------------------------------
-- Composite uniques, so intakes can point tenant-safe foreign keys at what
-- routed them. Both columns are already unique on their own; these add nothing
-- to the tables themselves beyond the ability to carry the tenant into a key.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX "leads_id_organization_id_key"
    ON "leads" ("id", "organization_id");
CREATE UNIQUE INDEX "assignment_rules_id_organization_id_key"
    ON "assignment_rules" ("id", "organization_id");

-- -----------------------------------------------------------------------------
-- integration_intakes: how an enquiry was routed.
--
-- IDENTIFIERS ONLY. The name, the message, the phone number and the email are
-- already on this row; copying any of them into "metadata" would create a
-- second place to find and redact when somebody asks to be forgotten.
-- -----------------------------------------------------------------------------
ALTER TABLE "integration_intakes"
    ADD COLUMN "last_processing_at" TIMESTAMPTZ(6),
    ADD COLUMN "processing_attempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "processing_code" VARCHAR(40),
    ADD COLUMN "resolved_territory_id" UUID,
    ADD COLUMN "matched_assignment_rule_id" UUID,
    ADD COLUMN "assigned_team_id" UUID,
    ADD COLUMN "assigned_membership_id" UUID,
    ADD COLUMN "assigned_user_id" UUID;

ALTER TABLE "integration_intakes"
    ADD CONSTRAINT "integration_intakes_processing_attempts_chk"
    CHECK ("processing_attempts" >= 0);

-- The claim query: what is waiting ANYWHERE, oldest first. Deliberately not
-- organization-first — the sweep asks that question before it has entered any
-- tenant's context, and an organization-first index cannot serve it.
CREATE INDEX "integration_intakes_status_received_idx"
    ON "integration_intakes" ("status", "received_at");

-- The lead this became. A real relation rather than a bare id, so a lead can
-- show the enquiry behind it — the original message, the page, the time it
-- arrived — without copying four thousand characters into the CRM tables.
--
-- SET NULL, not CASCADE: deleting a lead must not delete the record that a
-- customer once wrote in.
ALTER TABLE "integration_intakes"
    ADD CONSTRAINT "integration_intakes_created_lead_id_organization_id_fkey"
    FOREIGN KEY ("created_lead_id", "organization_id") REFERENCES "leads"("id", "organization_id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Routing provenance. All SET NULL for the same reason: retiring a rule or a
-- territory must not erase how an enquiry was handled while it was live.
ALTER TABLE "integration_intakes"
    ADD CONSTRAINT "integration_intakes_resolved_territory_id_organization_id_fkey"
    FOREIGN KEY ("resolved_territory_id", "organization_id") REFERENCES "territories"("id", "organization_id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "integration_intakes"
    ADD CONSTRAINT "integration_intakes_matched_rule_id_organization_id_fkey"
    FOREIGN KEY ("matched_assignment_rule_id", "organization_id") REFERENCES "assignment_rules"("id", "organization_id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "integration_intakes"
    ADD CONSTRAINT "integration_intakes_assigned_team_id_organization_id_fkey"
    FOREIGN KEY ("assigned_team_id", "organization_id") REFERENCES "teams"("id", "organization_id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Who the rotation chose. A plain key rather than a composite one: a user is
-- global in this product — one person may belong to several organizations — so
-- there is no tenant to carry into the key. assigned_membership_id is the
-- tenant-scoped half of the same fact, and is deliberately NOT a foreign key,
-- for the reason teams.manager_membership_id is not one either: a membership
-- carries organization_id, and ON DELETE SET NULL would have to null that too.
ALTER TABLE "integration_intakes"
    ADD CONSTRAINT "integration_intakes_assigned_user_id_fkey"
    FOREIGN KEY ("assigned_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- team_assignment_cursors: where each team's rotation has got to.
--
-- ONE ROW PER TEAM, and the cursor belongs to the team rather than to a rule.
-- Several rules may route to the same team — a website rule, a product rule, a
-- territory rule — and they share one rotation, because a salesperson
-- experiences work arriving, not the rule that sent it. A cursor per rule would
-- hand somebody three turns for being in a popular team.
--
-- The sequence is a MONOTONIC COUNTER over the CURRENT candidate list, not a
-- pointer at a person:
--
--     chosen = eligible[sequence % eligible.length]
--
-- which is what lets membership change with no migration and no rebuild.
-- Holding a user id instead would break the moment that person left the team.
-- -----------------------------------------------------------------------------
CREATE TABLE "team_assignment_cursors" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,

    -- BIGINT because it only ever climbs. An INTEGER would wrap after two
    -- billion assignments, which is a long way off and an unpleasant way to
    -- find out about a type choice.
    "sequence" BIGINT NOT NULL DEFAULT 0,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "team_assignment_cursors_pkey" PRIMARY KEY ("id")
);

-- Never negative. The rotation index is `sequence % length`, and in PostgreSQL
-- a negative left operand yields a negative remainder — which would index
-- outside the candidate array rather than wrapping.
ALTER TABLE "team_assignment_cursors"
    ADD CONSTRAINT "team_assignment_cursors_sequence_chk" CHECK ("sequence" >= 0);

-- One cursor per team, and one per team per tenant. Two rows would mean two
-- rotations for one team, and which one answered would depend on row order.
CREATE UNIQUE INDEX "team_assignment_cursors_team_id_key"
    ON "team_assignment_cursors" ("team_id");
CREATE UNIQUE INDEX "team_assignment_cursors_team_id_organization_id_key"
    ON "team_assignment_cursors" ("team_id", "organization_id");

ALTER TABLE "team_assignment_cursors"
    ADD CONSTRAINT "team_assignment_cursors_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite, so another tenant's team has nothing to match. CASCADE, unlike the
-- provenance keys above: a deleted team's rotation POSITION is not history
-- worth keeping, while the assignments it produced live on the leads.
ALTER TABLE "team_assignment_cursors"
    ADD CONSTRAINT "team_assignment_cursors_team_id_organization_id_fkey"
    FOREIGN KEY ("team_id", "organization_id") REFERENCES "teams"("id", "organization_id")
    ON DELETE CASCADE ON UPDATE CASCADE;
