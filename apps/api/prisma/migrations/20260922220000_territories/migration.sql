-- Territories: geography resolved to a NAME, so routing never parses an address.
--
-- SAFETY: additive, with ONE deliberate data rewrite — see "criteria keys"
-- below. Two enums, two tables, one new nullable column on assignment_rules,
-- one column widening, six indexes and five foreign keys. No column is dropped,
-- no row is deleted, and no existing routing decision changes.
--
-- NOT IN HERE, deliberately: postal ranges, wildcards, regex selectors,
-- latitude/longitude, polygons, radii. Routing matches selectors an
-- administrator configured and can read back. Anything fuzzier is a routing
-- decision nobody can audit, and it is not needed to answer "which team".

CREATE TYPE "territory_status" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "territory_coverage_type" AS ENUM ('COUNTRY', 'STATE', 'CITY', 'POSTAL_CODE');

-- -----------------------------------------------------------------------------
-- territories
--
-- No target_team_id, on purpose. Assignment rules are the one authority that
-- maps criteria to a team; a team column here would be a second routing system,
-- and the first time the two disagreed there would be no way to say which was
-- right. No member table either: who may receive work is derived from
-- organization membership and team configuration, and a second copy of a person
-- drifts the moment somebody is suspended.
-- -----------------------------------------------------------------------------
CREATE TABLE "territories" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,

    "name" VARCHAR(80) NOT NULL,
    -- Lower-cased, whitespace-collapsed `name`, stored rather than computed so
    -- the application's lookup and the index apply one rule instead of two.
    "name_key" VARCHAR(80) NOT NULL,
    "description" VARCHAR(500),

    "status" "territory_status" NOT NULL DEFAULT 'ACTIVE',

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "territories_pkey" PRIMARY KEY ("id")
);

-- Lets coverage rows and assignment rules point a COMPOSITE key at a territory
-- and carry the tenant into the key, exactly as teams and products already do.
CREATE UNIQUE INDEX "territories_id_organization_id_key"
    ON "territories" ("id", "organization_id");

-- One ACTIVE territory per name per organization. PARTIAL, like the team index
-- it mirrors: archiving "Pune / PCMC" and later creating a new territory by
-- that name is legitimate, and it is the race backstop as well as the rule.
CREATE UNIQUE INDEX "territories_org_name_key_active_uniq"
    ON "territories" ("organization_id", "name_key")
    WHERE "status" = 'ACTIVE';

CREATE INDEX "territories_org_status_name_idx"
    ON "territories" ("organization_id", "status", "name");

ALTER TABLE "territories"
    ADD CONSTRAINT "territories_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- territory_coverage
--
-- One row per explicit selector. country_code is NOT NULL for every shape: a
-- state or a pincode without a country is a fragment, not a place, and two
-- countries can spell a state the same way.
-- -----------------------------------------------------------------------------
CREATE TABLE "territory_coverage" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "territory_id" UUID NOT NULL,

    "type" "territory_coverage_type" NOT NULL,

    "country_code" VARCHAR(2) NOT NULL,

    -- Identity normalisation only — trimmed, whitespace-collapsed, lower-cased.
    -- There is no canonical global list of states or cities to validate
    -- against, and inventing one would mean refusing places that exist.
    "state_key" VARCHAR(80),
    "state_name" VARCHAR(80),
    "city_key" VARCHAR(80),
    "city_name" VARCHAR(80),

    -- A STRING, never an integer: SW1A 1AA is not a number and 08540 loses its
    -- leading zero the moment it becomes one.
    "postal_code_key" VARCHAR(16),
    "postal_code" VARCHAR(16),

    -- Server-generated, never accepted from a caller.
    "coverage_key" VARCHAR(200) NOT NULL,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(6),

    CONSTRAINT "territory_coverage_pkey" PRIMARY KEY ("id")
);

-- -----------------------------------------------------------------------------
-- The shape rules, as CHECK constraints rather than as validation alone.
--
-- Application validation says what an administrator is told; these say what can
-- exist. A COUNTRY row with a city in it, or a POSTAL_CODE row with no pincode,
-- would make the resolver's specificity order meaningless — and the resolver is
-- the thing that has to be deterministic.
--
-- State is OPTIONAL on a CITY row, and absent from COUNTRY and POSTAL_CODE
-- rows: plenty of countries have no province layer, and requiring one would
-- mean refusing to cover Singapore or the UAE.
-- -----------------------------------------------------------------------------
ALTER TABLE "territory_coverage"
    ADD CONSTRAINT "territory_coverage_shape_chk" CHECK (
        CASE "type"
            WHEN 'COUNTRY'     THEN "state_key" IS NULL AND "city_key" IS NULL AND "postal_code_key" IS NULL
            WHEN 'STATE'       THEN "state_key" IS NOT NULL AND "city_key" IS NULL AND "postal_code_key" IS NULL
            WHEN 'CITY'        THEN "city_key" IS NOT NULL AND "postal_code_key" IS NULL
            WHEN 'POSTAL_CODE' THEN "postal_code_key" IS NOT NULL AND "state_key" IS NULL AND "city_key" IS NULL
        END
    );

-- A key without its display form, or the reverse, would show an administrator
-- one thing and match another.
ALTER TABLE "territory_coverage"
    ADD CONSTRAINT "territory_coverage_display_chk" CHECK (
        ("state_key" IS NULL) = ("state_name" IS NULL)
        AND ("city_key" IS NULL) = ("city_name" IS NULL)
        AND ("postal_code_key" IS NULL) = ("postal_code" IS NULL)
    );

-- -----------------------------------------------------------------------------
-- ONE live owner per place, per organization.
--
-- The whole reason resolution can be deterministic. Without this, two
-- territories could both cover "IN / Maharashtra" and which one answered would
-- depend on row order — and the same enquiry would route differently on two
-- replicas. PARTIAL on removed_at, so a selector may legitimately be moved from
-- one territory to another: remove it here, add it there.
--
-- It is also the race backstop. Two administrators claiming Pune at the same
-- moment both pass any prior existence check; one of them has to lose, and
-- PostgreSQL is what decides that, not a read.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX "territory_coverage_active_key_uniq"
    ON "territory_coverage" ("organization_id", "coverage_key")
    WHERE "removed_at" IS NULL;

CREATE INDEX "territory_coverage_org_territory_removed_idx"
    ON "territory_coverage" ("organization_id", "territory_id", "removed_at");

ALTER TABLE "territory_coverage"
    ADD CONSTRAINT "territory_coverage_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite: a territory from another tenant has nothing to match, so a
-- cross-tenant coverage row cannot be written even by code that forgot to check.
ALTER TABLE "territory_coverage"
    ADD CONSTRAINT "territory_coverage_territory_id_organization_id_fkey"
    FOREIGN KEY ("territory_id", "organization_id") REFERENCES "territories"("id", "organization_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- assignment_rules: the territory criterion
-- -----------------------------------------------------------------------------

ALTER TABLE "assignment_rules" ADD COLUMN "territory_id" UUID;

-- RESTRICT, like the team and product references: losing a territory out from
-- under live routing would take the rules with it silently. Territories are
-- archived rather than deleted, and archiving one that active rules reference
-- is refused in the application with a message naming what to fix.
ALTER TABLE "assignment_rules"
    ADD CONSTRAINT "assignment_rules_territory_id_organization_id_fkey"
    FOREIGN KEY ("territory_id", "organization_id") REFERENCES "territories"("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- "Which rules point at this territory?" — asked before one may be archived.
CREATE INDEX "assignment_rules_org_territory_status_idx"
    ON "assignment_rules" ("organization_id", "territory_id", "status");

-- -----------------------------------------------------------------------------
-- Criteria keys: the one data rewrite, and why it is safe.
--
-- A criteria key names every dimension, so that "any source, product X" and
-- "source Y, product X" are different keys and the active-criteria unique index
-- can refuse two rules that match identical input. Adding a third dimension
-- therefore changes the format:
--
--     source=website|product=*        ->  source=website|product=*|territory=*
--
-- Safe on all four counts that matter:
--
--   SEMANTICS ARE IDENTICAL. Every existing rule constrains no territory, and
--   `territory=*` is exactly how the generator writes an unconstrained
--   dimension. No rule starts or stops matching anything.
--
--   IT IS DETERMINISTIC. One constant suffix on every row — not a recomputation
--   from columns that might be spelled differently than when the key was built.
--
--   UNIQUENESS IS PRESERVED EXACTLY. Appending the same suffix to every value is
--   injective: two keys collide afterwards if and only if they collided before.
--   No pair of ACTIVE rules can become ambiguous, and none that was already
--   refused becomes allowed.
--
--   THERE IS ONE FORMAT AFTERWARDS, not two. A lazily migrated table would mean
--   an old two-segment key and a new three-segment key for the same criteria,
--   which the unique index would read as different rules — the precise failure
--   this index exists to prevent.
--
-- The column widens first: source(60) + a uuid + a uuid plus the segment labels
-- no longer fits in 120 characters.
-- -----------------------------------------------------------------------------
ALTER TABLE "assignment_rules" ALTER COLUMN "criteria_key" TYPE VARCHAR(200);

UPDATE "assignment_rules" SET "criteria_key" = "criteria_key" || '|territory=*';
