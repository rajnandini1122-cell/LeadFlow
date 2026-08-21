-- Country on a public contact enquiry (additive).
--
-- Nullable with no default, so every existing row stays valid and nothing is
-- rewritten. Rollback is a single DROP COLUMN.
ALTER TABLE "contact_enquiries" ADD COLUMN "country" VARCHAR(2);
