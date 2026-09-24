-- CRAVION as the platform operator: one new role, one new organization kind.
--
-- SAFETY: additive only. Two enum values, one enum type, one column with a
-- default, one partial unique index. Nothing is dropped, renamed, rewritten or
-- back-filled. No organization, user, membership, role, subscription or lead is
-- modified, and every existing row keeps the meaning it already had.
--
-- Nothing here creates the CRAVION organization or its master user. That is
-- `npm run db:bootstrap-platform-owner -w apps/api`, a separate and deliberate
-- act, so applying this migration grants nobody anything.

-- -----------------------------------------------------------------------------
-- RoleKey: the platform administrator.
--
-- ADD VALUE is additive and cannot fail on existing data — no row holds the new
-- value, and nothing reads the enum exhaustively in SQL.
--
-- IF NOT EXISTS because a migration must be safe to re-apply against a database
-- somebody has already repaired by hand, which is the state a production
-- database is in precisely when it matters.
--
-- Note for whoever adds the next enum value: ALTER TYPE ... ADD VALUE cannot run
-- inside a transaction block on PostgreSQL before 12. This project is on 17,
-- where it can, so Prisma's implicit transaction around the migration is fine.
-- -----------------------------------------------------------------------------
ALTER TYPE "role_key" ADD VALUE IF NOT EXISTS 'PLATFORM_OWNER';

-- -----------------------------------------------------------------------------
-- What an organization IS, as opposed to what state it is in.
--
-- DEFAULT 'CUSTOMER' is what makes this safe on a running database: every
-- existing organization becomes a customer without a back-fill, which is what
-- every one of them already was. The column is NOT NULL because "unknown kind
-- of organization" is not a state this product should be able to represent —
-- the answer is always one of the two.
-- -----------------------------------------------------------------------------
CREATE TYPE "organization_type" AS ENUM ('CUSTOMER', 'INTERNAL');

ALTER TABLE "organizations"
    ADD COLUMN "organization_type" "organization_type" NOT NULL DEFAULT 'CUSTOMER';

-- -----------------------------------------------------------------------------
-- AT MOST ONE internal organization, enforced by the database.
--
-- A partial unique index on a constant: every INTERNAL row indexes the same
-- key, so the second one is refused. CUSTOMER rows are not in the index at all,
-- so this costs nothing and constrains nothing else.
--
-- Worth the index rather than a check in the bootstrap command, because the
-- failure it prevents is not a race — it is somebody running the bootstrap
-- twice with a different organization name and ending up with two platform
-- operators, each of whose owner can administer every customer. A second
-- platform organization is not a duplicate record; it is a second set of keys
-- to the building.
--
-- Prisma's schema language cannot express a partial unique index on an
-- expression, so it is written here. It is invisible to the client, which is
-- fine: nothing queries by it, and the application never inserts a second one
-- deliberately.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX "organizations_single_internal_uniq"
    ON "organizations" ((TRUE))
    WHERE "organization_type" = 'INTERNAL';

-- "List the customers" and "find the platform organization" are both common on
-- the platform-admin surface, and both are a type filter.
CREATE INDEX "organizations_organization_type_idx"
    ON "organizations" ("organization_type");
