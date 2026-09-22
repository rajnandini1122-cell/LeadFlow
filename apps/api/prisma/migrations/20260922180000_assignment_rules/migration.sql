-- Assignment rules: which TEAM handles which work.
--
-- SAFETY: additive only. One enum, one table, one composite unique on an
-- existing table, four indexes, three foreign keys. Nothing is dropped,
-- rewritten or back-filled, and no existing row changes — old and new code run
-- against this schema at the same time during a rolling deploy.
--
-- NOT IN HERE, deliberately: country, state, city, pincode, territory. Geography
-- is the next phase and arrives as a Territory reference; a column here now
-- would have to be replaced then, and migrations that replace columns are the
-- ones that go wrong.

-- Lets a rule point a COMPOSITE foreign key at a product and carry the tenant
-- into the key, exactly as teams and team members already do. `id` is unique on
-- its own; this adds nothing to the products table itself.
CREATE UNIQUE INDEX "products_id_organization_id_key"
    ON "products" ("id", "organization_id");

CREATE TYPE "assignment_rule_status" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

CREATE TABLE "assignment_rules" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,

    "name" VARCHAR(80) NOT NULL,
    "name_key" VARCHAR(80) NOT NULL,
    "description" VARCHAR(500),

    "status" "assignment_rule_status" NOT NULL DEFAULT 'ACTIVE',

    -- LOWER RUNS FIRST: 10 before 20 before 100.
    "priority" INTEGER NOT NULL,

    -- The tenant's own source vocabulary, as they write it, plus the
    -- normalised form used for comparison. Free text because that is what
    -- source IS here: each organization configures its own list, and an enum
    -- would be a second taxonomy disagreeing with theirs.
    "source" VARCHAR(60),
    "source_key" VARCHAR(60),

    -- The CANONICAL product, never the free text a customer typed.
    "product_id" UUID,

    "is_fallback" BOOLEAN NOT NULL DEFAULT false,

    -- Server-generated, never accepted from a caller.
    "criteria_key" VARCHAR(120) NOT NULL,

    "target_team_id" UUID NOT NULL,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "assignment_rules_pkey" PRIMARY KEY ("id")
);

-- -----------------------------------------------------------------------------
-- Three partial unique indexes, all for the same reason: an ambiguous routing
-- table is worse than a missing one. Each covers ACTIVE rules only, so paused
-- and archived history never blocks a legitimate replacement.
--
-- They are partial, which is why they are written here rather than in
-- schema.prisma, and they are the RACE backstop as well as the rule: two
-- administrators configuring routing at the same moment both pass any prior
-- check, and one of them has to lose.
-- -----------------------------------------------------------------------------

-- At most one active fallback. Two would mean the last resort depended on
-- precedence nobody set.
CREATE UNIQUE INDEX "assignment_rules_active_fallback_uniq"
    ON "assignment_rules" ("organization_id")
    WHERE "status" = 'ACTIVE' AND "is_fallback";

-- No two active rules matching exactly the same input. Without this, identical
-- enquiries route to different teams depending on which rule happened to come
-- first.
CREATE UNIQUE INDEX "assignment_rules_active_criteria_uniq"
    ON "assignment_rules" ("organization_id", "criteria_key")
    WHERE "status" = 'ACTIVE' AND NOT "is_fallback";

-- Precedence is unique, so which rule wins is never decided by row order or
-- creation time. Reordering means choosing a free number rather than swapping
-- two — a refusal an administrator can see, where an ambiguous order is a
-- silent misroute.
CREATE UNIQUE INDEX "assignment_rules_active_priority_uniq"
    ON "assignment_rules" ("organization_id", "priority")
    WHERE "status" = 'ACTIVE' AND NOT "is_fallback";

CREATE INDEX "assignment_rules_org_status_priority_idx"
    ON "assignment_rules" ("organization_id", "status", "priority");
CREATE INDEX "assignment_rules_org_team_status_idx"
    ON "assignment_rules" ("organization_id", "target_team_id", "status");

ALTER TABLE "assignment_rules"
    ADD CONSTRAINT "assignment_rules_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite: the team must belong to the same organization, so another
-- tenant's team id has nothing to match rather than being caught by a check
-- somebody could forget to write.
--
-- RESTRICT, not CASCADE: deleting a team out from under live routing would
-- take the rules with it silently. Teams are archived rather than deleted in
-- this product, and archiving one that active rules reference is refused in
-- the application with a message naming what to fix.
ALTER TABLE "assignment_rules"
    ADD CONSTRAINT "assignment_rules_target_team_id_organization_id_fkey"
    FOREIGN KEY ("target_team_id", "organization_id") REFERENCES "teams"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "assignment_rules"
    ADD CONSTRAINT "assignment_rules_product_id_organization_id_fkey"
    FOREIGN KEY ("product_id", "organization_id") REFERENCES "products"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
