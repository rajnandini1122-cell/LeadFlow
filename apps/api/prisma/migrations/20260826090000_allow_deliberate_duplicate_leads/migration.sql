-- -----------------------------------------------------------------------------
-- Make `allowDuplicate` actually work.
--
-- The partial unique index on (organization_id, mobile) was documented as "the
-- backstop for the race between two concurrent creates", but it was written as
-- an absolute prohibition. That also blocked the deliberate second lead the API
-- offers through `allowDuplicate`, which therefore returned HTTP 500.
--
-- The fix marks a lead whose duplication was acknowledged and excludes those
-- rows from the index. The race protection is unchanged for every lead that
-- did NOT opt in: two concurrent creates still leave only one winner.
--
-- Additive and non-destructive. The new predicate is strictly weaker than the
-- old one, so it cannot fail against existing data, and existing rows keep the
-- NULL default that leaves them inside the index exactly as before.
-- -----------------------------------------------------------------------------
ALTER TABLE "leads" ADD COLUMN "duplicate_acknowledged_at" TIMESTAMPTZ(6);

DROP INDEX "leads_org_mobile_uniq";

CREATE UNIQUE INDEX "leads_org_mobile_uniq"
  ON "leads" ("organization_id", "mobile")
  WHERE "mobile" IS NOT NULL
    AND "deleted_at" IS NULL
    AND "status" <> 'LOST'
    AND "duplicate_acknowledged_at" IS NULL;
