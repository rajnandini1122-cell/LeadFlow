-- =============================================================================
-- 20260821090000_password_reset_tokens
--
-- Single-use password reset tokens.
--
-- A separate table rather than columns on `users`, because a reset is an event
-- with its own lifecycle — it expires, it is consumed exactly once, and the
-- record of who requested one and when is a security signal worth keeping.
--
-- Additive only: one new table and its indexes. Nothing existing is touched.
-- =============================================================================

CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  "id"         UUID           NOT NULL DEFAULT uuidv7(),
  "user_id"    UUID           NOT NULL,
  -- SHA-256 of the token. The raw value exists only in transit and in the
  -- email, so a database disclosure yields nothing usable.
  "token_hash" VARCHAR(64)    NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  -- Non-null means spent. Rows are retained rather than deleted so a replay
  -- attempt remains visible.
  "used_at"    TIMESTAMPTZ(6),
  "ip_address" VARCHAR(64),
  "user_agent" VARCHAR(400),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- Unique: the hash is how a token is looked up, and two rows sharing one would
-- make redemption ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS "password_reset_tokens_token_hash_key"
  ON "password_reset_tokens" ("token_hash");

-- Finds a user's outstanding tokens, which is how requesting a new one
-- invalidates the previous.
CREATE INDEX IF NOT EXISTS "password_reset_tokens_user_id_used_at_idx"
  ON "password_reset_tokens" ("user_id", "used_at");

-- Supports an expiry sweep without scanning the table.
CREATE INDEX IF NOT EXISTS "password_reset_tokens_expires_at_idx"
  ON "password_reset_tokens" ("expires_at");

-- CASCADE: a deleted user's reset tokens have no meaning and must not linger
-- as orphaned credentials.
ALTER TABLE "password_reset_tokens"
  DROP CONSTRAINT IF EXISTS "password_reset_tokens_user_id_fkey";
ALTER TABLE "password_reset_tokens"
  ADD CONSTRAINT "password_reset_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
