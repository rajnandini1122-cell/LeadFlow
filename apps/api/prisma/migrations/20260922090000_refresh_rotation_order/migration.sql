-- Deterministic ordering for refresh-token rotation.
--
-- Several requests legitimately carrying one refresh token arrive together.
-- Exactly one may consume it; the rest must fail with 401 and leave the
-- family alone. Telling those losers apart from a genuine replay needs an
-- answer to one question: did this request register with the database before
-- the rotation did?
--
-- A timestamp cannot answer it once more than one API replica exists, because
-- the two replicas write their own clocks and clocks disagree. A sequence can:
-- every replica draws from the same one, and PostgreSQL hands out strictly
-- increasing values.
--
-- `nextval` is intentionally NOT transactional. A request that draws a value
-- and then fails leaves a gap, which is harmless here — nothing counts these
-- values, they are only compared. A counter row under a lock would close the
-- gaps and serialise every refresh in the product against every other, which
-- is a real cost for no benefit.
CREATE SEQUENCE IF NOT EXISTS "refresh_order_seq" AS BIGINT START 1;

-- Set only when a session is consumed by a rotation (revoked_reason =
-- 'ROTATED'). NULL everywhere else, including on rows that predate this
-- migration: a ROTATED row without an ordering value is classified as a
-- replay, which is the secure direction.
ALTER TABLE "sessions" ADD COLUMN "rotation_order" BIGINT;
