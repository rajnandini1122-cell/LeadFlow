-- Sales teams: the structure future assignment rules will read.
--
-- SAFETY: additive only. One enum, two tables, one unique index on an existing
-- table, four indexes, five foreign keys. No column is dropped or rewritten, no
-- existing row is touched, and nothing back-fills — so a rolling deploy runs
-- old and new code against this schema at once.
--
-- NOT IN HERE, deliberately: territories, routing rules, round-robin cursors,
-- assignment weights. Those are later phases with requirements of their own,
-- and a half-formed version now would be rewritten the moment they arrive.

-- -----------------------------------------------------------------------------
-- Cross-tenant safety, at the database rather than in a guard.
--
-- `organization_users.id` is already unique by itself; this composite adds
-- nothing to that table. It exists so the team tables below can point FOREIGN
-- KEYS at (id, organization_id) and have PostgreSQL refuse a row that pairs a
-- membership with the wrong organization. Application code cannot forget it,
-- and a bug cannot work around it.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX "organization_users_id_organization_id_key"
    ON "organization_users" ("id", "organization_id");

CREATE TYPE "team_status" AS ENUM ('ACTIVE', 'ARCHIVED');

CREATE TABLE "teams" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,

    "name" VARCHAR(80) NOT NULL,
    -- Lower-cased and whitespace-collapsed `name`. A stored column rather than
    -- a functional index, because the application has to apply the same
    -- normalisation when it looks a team up, and two expressions of one rule
    -- drift apart.
    "name_key" VARCHAR(80) NOT NULL,
    "description" VARCHAR(500),

    "status" "team_status" NOT NULL DEFAULT 'ACTIVE',

    -- A MEMBERSHIP, not a user id: a user is global and belongs to no tenant,
    -- so a bare user id could name somebody from another organization.
    "manager_membership_id" UUID,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- Lets team_members point a composite key at a team and inherit its tenant.
CREATE UNIQUE INDEX "teams_id_organization_id_key" ON "teams" ("id", "organization_id");

-- One ACTIVE team per name per organization.
--
-- PARTIAL on purpose, which is why it is written here rather than in
-- schema.prisma: archiving "Pune Sales" and later creating a new team by that
-- name is legitimate, and a total unique index would refuse it forever. It is
-- also the race backstop — two administrators creating the same team at the
-- same moment both pass a prior existence check and one of them must lose.
CREATE UNIQUE INDEX "teams_org_name_key_active_uniq"
    ON "teams" ("organization_id", "name_key")
    WHERE "status" = 'ACTIVE';

CREATE INDEX "teams_organization_id_status_idx" ON "teams" ("organization_id", "status");

CREATE TABLE "team_members" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "organization_membership_id" UUID NOT NULL,

    -- Whether FUTURE automatic assignment may route work here. Not a login, not
    -- a permission, and not a reason to touch an existing lead.
    "assignment_enabled" BOOLEAN NOT NULL DEFAULT true,

    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- NULL means currently in the team. Set on removal rather than deleting the
    -- row, so "who was in this team when that deal closed" stays answerable.
    "removed_at" TIMESTAMPTZ(6),

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

-- ONE active membership per person per team, enforced by the database.
--
-- Partial, because history is the point: a person removed from a team and
-- added back must produce two rows, and only the current one may be active. A
-- read-then-insert cannot hold this — two concurrent "add" requests both find
-- nothing and both write — so this index is what decides, and the application
-- reads the loser's error rather than guessing.
CREATE UNIQUE INDEX "team_members_active_uniq"
    ON "team_members" ("team_id", "organization_membership_id")
    WHERE "removed_at" IS NULL;

CREATE INDEX "team_members_org_team_removed_idx"
    ON "team_members" ("organization_id", "team_id", "removed_at");
CREATE INDEX "team_members_org_membership_removed_idx"
    ON "team_members" ("organization_id", "organization_membership_id", "removed_at");

ALTER TABLE "teams"
    ADD CONSTRAINT "teams_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- The composite that makes a foreign manager impossible: the pair must exist in
-- organization_users, so a membership from another tenant has nothing to match.
--
-- NO ACTION rather than SET NULL because the reference includes
-- organization_id, which is NOT NULL and therefore cannot be nulled. Nothing
-- hard-deletes a membership in this product — removal is a status and a
-- timestamp — and the application clears this column itself when a manager
-- leaves the team.
ALTER TABLE "teams"
    ADD CONSTRAINT "teams_manager_membership_id_organization_id_fkey"
    FOREIGN KEY ("manager_membership_id", "organization_id")
    REFERENCES "organization_users"("id", "organization_id")
    ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "team_members"
    ADD CONSTRAINT "team_members_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Team and member both carry the tenant into the key, so "team in organization
-- A holding a member from organization B" is not a bug that has to be guarded
-- against — it is a row PostgreSQL will not accept.
ALTER TABLE "team_members"
    ADD CONSTRAINT "team_members_team_id_organization_id_fkey"
    FOREIGN KEY ("team_id", "organization_id") REFERENCES "teams"("id", "organization_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "team_members"
    ADD CONSTRAINT "team_members_membership_id_organization_id_fkey"
    FOREIGN KEY ("organization_membership_id", "organization_id")
    REFERENCES "organization_users"("id", "organization_id")
    ON DELETE CASCADE ON UPDATE CASCADE;
