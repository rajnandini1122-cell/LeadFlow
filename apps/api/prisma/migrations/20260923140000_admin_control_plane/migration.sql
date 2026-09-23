-- The Central Admin control plane: who asked for what, and exactly once.
--
-- SAFETY: additive only. One table, one nullable column on audit_logs, three
-- indexes and one foreign key. Nothing is dropped, rewritten or back-filled: no
-- lead, follow-up, intake or rotation cursor is touched, and every existing
-- audit row keeps the meaning it already had.
--
-- Nothing here switches the control plane ON. That is ADMIN_CONTROL_ENABLED,
-- which defaults to false, so applying this migration exposes no new surface.

-- -----------------------------------------------------------------------------
-- audit_logs: who did it, when they are not one of our users.
--
-- actor_user_id has a foreign key to `users`, so an external administrator's
-- reference cannot go there — it would either fail the key or, worse, collide
-- with a real person and attribute the change to them.
--
-- The two columns together identify anybody, with no third column naming the
-- kind: a user id is a person here, an external ref is a person somewhere else,
-- and both null is the system. A `kind` column would be a second source of
-- truth able to disagree with the first.
-- -----------------------------------------------------------------------------
ALTER TABLE "audit_logs" ADD COLUMN "external_actor_ref" VARCHAR(200);

-- "What has this administrator changed?" — the external counterpart of the
-- existing actor index. Mostly NULL, so the btree stays small.
CREATE INDEX "audit_logs_external_actor_ref_created_at_idx"
    ON "audit_logs" ("external_actor_ref", "created_at" DESC);

-- -----------------------------------------------------------------------------
-- admin_control_commands: the idempotency ledger.
--
-- A row exists IF AND ONLY IF the mutation it describes committed, because it
-- is written inside that same transaction. That single property is the design,
-- and it rules out both orderings that look reasonable and are not:
--
--   claim, commit, then mutate — a crash in between permanently records a
--   request that never ran, and the honest retry is refused as a duplicate of
--   nothing that happened;
--
--   mutate, commit, then claim — a crash in between loses the record, and the
--   honest retry performs the mutation a second time.
--
-- Here a failure rolls the row back with the mutation, leaving the request id
-- free to be tried again, and a success records both together.
--
-- IDENTIFIERS AND A DIGEST, never a payload. Whatever customer data a command
-- touched already lives in the table it touched; a copy here would be a second
-- place to find and redact.
-- -----------------------------------------------------------------------------
CREATE TABLE "admin_control_commands" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,

    -- The caller's own id for this command, carried in a signed header so it
    -- cannot be altered in flight.
    "request_id" VARCHAR(120) NOT NULL,

    -- Opaque. Not a LeadFlow user id, not an email, not a permission — how the
    -- calling system names the person who asked, so the two trails line up.
    "actor_ref" VARCHAR(200) NOT NULL,

    -- What was asked, in exactly the terms the signature covered. A retry that
    -- differs in ANY of these is a different command wearing the same id, and
    -- is refused rather than answered with the first one's result.
    "method" VARCHAR(10) NOT NULL,
    "path" VARCHAR(300) NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,

    -- The allowlisted operation, from a fixed set. Never a controller or method
    -- name chosen by the caller — there is no generic dispatcher to name one to.
    "action" VARCHAR(60) NOT NULL,

    -- What it produced, so a retry re-reads the authoritative record instead of
    -- replaying the mutation or storing a copy of the response.
    "entity_type" VARCHAR(40),
    "entity_id" UUID,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_control_commands_pkey" PRIMARY KEY ("id")
);

-- The idempotency guarantee itself, and the thing that decides a race: two
-- identical commands arriving at once both try to insert, the second blocks on
-- this index until the first commits, and then finds it already done.
--
-- Per tenant, because two organizations choosing the same request id are not
-- the same command.
CREATE UNIQUE INDEX "admin_control_commands_organization_id_request_id_key"
    ON "admin_control_commands" ("organization_id", "request_id");

CREATE INDEX "admin_control_commands_org_created_idx"
    ON "admin_control_commands" ("organization_id", "created_at" DESC);

ALTER TABLE "admin_control_commands"
    ADD CONSTRAINT "admin_control_commands_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
