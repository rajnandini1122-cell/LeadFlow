-- Duplicate-lead protection for enquiries that carry an email but no phone.
--
-- THE GAP THIS CLOSES. `leads_org_mobile_uniq` makes the mobile number the
-- duplicate key, and conversion re-checks it inside the row lock. An enquiry
-- with an email and no phone passed both: the pre-check is guarded by
-- `if (mobile)` and simply skipped, and no constraint covered email. Two
-- website submissions from one person who left the phone field blank therefore
-- became two active leads.
--
-- SAFETY: additive. One index. No column is added, dropped or rewritten, and no
-- row is modified — this migration changes no data at all.
--
-- ⚠️ IT CAN FAIL ON EXISTING DATA, and that is deliberate rather than a
-- weakness. If a tenant already holds two active, unacknowledged leads sharing
-- an email, PostgreSQL refuses to build the index and the migration aborts with
-- nothing applied. Run the preflight query in the migration notes (and in the
-- PR description) BEFORE deploying this, and resolve any rows it returns by the
-- ordinary product means — acknowledge one as a deliberate duplicate, close it,
-- or correct the address. Forcing the index past real duplicates would mean
-- choosing which customer record to break, and that is a person's decision.

-- -----------------------------------------------------------------------------
-- Mirrors leads_org_mobile_uniq exactly, with one deliberate difference.
--
-- The predicate is copied clause for clause from the mobile index as it stands
-- after 20260826090000_allow_deliberate_duplicate_leads, so the two keys behave
-- identically:
--
--   * NULL email is not a duplicate of anything — most leads have no email;
--   * a soft-deleted lead is not competing for the address;
--   * a LOST lead releases it, so a customer who went quiet may legitimately
--     come back as a new enquiry;
--   * an acknowledged duplicate is excluded, which is what lets a person
--     deliberately create a second lead for the same customer.
--
-- THE DIFFERENCE: the key is `lower(email)`, not `email`.
--
-- Email is case-insensitive in practice, and this codebase does not store it
-- consistently — the website intake DTO lowercases, while the manual
-- create/update DTOs did not normalise at all. A plain index on `email` would
-- therefore treat `Dana@Example.test` and `dana@example.test` as two different
-- customers, which is precisely the duplicate it is supposed to catch.
--
-- An expression index fixes that WITHOUT touching a single stored row: no
-- backfill, no rewrite, and historical mixed-case addresses are deduplicated
-- correctly from the moment it exists. The application now normalises on write
-- as well, so new rows are clean, but the index does not depend on that having
-- always been true.
--
-- Not declared in schema.prisma, following the same convention as
-- leads_org_mobile_uniq: Prisma's schema language does not express a partial
-- index over an expression, and a half-declared index is worse than an
-- honestly raw one.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX "leads_org_email_uniq"
  ON "leads" ("organization_id", lower("email"))
  WHERE "email" IS NOT NULL
    AND "deleted_at" IS NULL
    AND "status" <> 'LOST'
    AND "duplicate_acknowledged_at" IS NULL;
