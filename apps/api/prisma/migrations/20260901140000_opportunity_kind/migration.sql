-- Repeat business classification.
--
-- SAFETY: additive only. One new enum type, one nullable column, one index.
-- Nothing is dropped, rewritten or back-filled, and no existing row changes.
--
-- The column is deliberately left NULL for every existing lead. NULL means
-- "we do not know what kind of business this was", which is the truth: those
-- leads were captured before accounts existed, so there is no record of what
-- the customer had bought at the time. Defaulting them to FIRST would invent
-- an acquisition figure, and defaulting to REPEAT would invent retention.
CREATE TYPE "opportunity_kind" AS ENUM ('FIRST', 'REPEAT_PRODUCT', 'EXPANSION');

ALTER TABLE "leads" ADD COLUMN "opportunity_kind" "opportunity_kind";

-- Repeat and expansion demand group on this within a tenant. Mostly NULL, so
-- the btree stays small.
CREATE INDEX "leads_organization_id_opportunity_kind_idx"
    ON "leads" ("organization_id", "opportunity_kind");
