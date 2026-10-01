-- Structured classification and routing fields for website enquiries.
--
-- SAFETY: additive. One new enum type, six nullable columns on
-- integration_intakes, one nullable column on assignment_rules, and one
-- semantics-preserving rewrite of a derived index string (explained below).
-- Nothing is dropped, renamed, or narrowed, and no business data changes
-- meaning: every existing intake and every existing rule behaves after this
-- migration exactly as it did before.

-- -----------------------------------------------------------------------------
-- What the customer wants, as a closed set.
--
-- An enum rather than free text because assignment rules may match on it, and a
-- routing dimension needs a closed set — otherwise "Sample", "sample" and
-- "samples" become three different rules pointing three different ways.
--
-- Deliberately NOT folded into `source`. Source says how an enquiry reached us
-- and is what attribution is counted on; this says what the customer is asking
-- for. One column cannot answer both questions.
-- -----------------------------------------------------------------------------
CREATE TYPE "enquiry_type" AS ENUM (
    'GENERAL',
    'QUOTE',
    'SAMPLE',
    'BULK',
    'EXPORT',
    'HORECA',
    'DISTRIBUTOR',
    'PRIVATE_LABEL'
);

-- -----------------------------------------------------------------------------
-- The intake columns.
--
-- All nullable, none with a default. A default would put an answer in every
-- historical row that nobody gave: `enquiry_type = 'GENERAL'` on a three-month-
-- old enquiry would be this migration inventing what a customer said.
--
-- `sample_required` is nullable BOOLEAN for three states rather than two —
-- asked and said yes, asked and said no, never asked. `NOT NULL DEFAULT false`
-- would record every historical enquirer as having declined a sample.
-- -----------------------------------------------------------------------------
ALTER TABLE "integration_intakes"
    ADD COLUMN "enquiry_type"        "enquiry_type",
    ADD COLUMN "state"               VARCHAR(120),
    ADD COLUMN "city"                VARCHAR(120),
    ADD COLUMN "quantity"            VARCHAR(80),
    ADD COLUMN "destination_country" VARCHAR(2),
    ADD COLUMN "sample_required"     BOOLEAN;

-- Supports "show me every SAMPLE enquiry still waiting", which is the query an
-- operator actually runs. Tenant-first, like every other index in this schema:
-- the leading column is what makes the tenant predicate selective rather than a
-- filter applied after a scan.
CREATE INDEX "integration_intakes_organization_id_enquiry_type_idx"
    ON "integration_intakes" ("organization_id", "enquiry_type");

-- -----------------------------------------------------------------------------
-- The fourth routing dimension.
--
-- Nullable, and null means "any" — the same semantics the other three
-- dimensions already have.
-- -----------------------------------------------------------------------------
ALTER TABLE "assignment_rules"
    ADD COLUMN "enquiry_type" "enquiry_type";

-- -----------------------------------------------------------------------------
-- The criteria key gains one constant suffix.
--
-- THIS IS THE ONE STATEMENT THAT TOUCHES EXISTING ROWS, so it is worth being
-- precise about what it does and does not change.
--
-- `criteria_key` is a DERIVED string — the concatenation of the matching
-- dimensions, with `*` for a dimension a rule does not constrain. It is not
-- business data. Its only job is to let the application refuse two ACTIVE rules
-- that match identical input and disagree about the answer.
--
-- Adding a fourth dimension changes the format from three segments to four. A
-- rule that does not constrain enquiry type is, in the new format, exactly
-- itself plus `|enquiry_type=*`. So this rewrite preserves every rule's
-- identity: no rule starts or stops matching anything, no rule's target
-- changes, and two rules that conflicted before still conflict after.
--
-- Leaving it unmigrated would be the unsafe choice. Old three-segment keys and
-- new four-segment keys never collide, so the duplicate check would stop seeing
-- a conflict between a rule written last week and one written today — and two
-- ACTIVE rules matching the same input while pointing at different teams is the
-- exact failure the key exists to prevent.
--
-- This is the pattern the TERRITORY dimension established when it was added;
-- its note in rule-criteria.ts is the reason the new dimension is appended last
-- rather than inserted, and why one constant suffix is all that is needed.
--
-- The WHERE clause makes the statement safe to run against a database that
-- somehow already carries the suffix, rather than double-appending it.
-- -----------------------------------------------------------------------------
UPDATE "assignment_rules"
    SET "criteria_key" = "criteria_key" || '|enquiry_type=*'
    WHERE "criteria_key" NOT LIKE '%|enquiry_type=%';
