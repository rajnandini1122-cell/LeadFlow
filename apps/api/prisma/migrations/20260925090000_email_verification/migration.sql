-- Mandatory email verification for new self-service registrations.
--
-- SAFETY: additive only. One nullable column, one new table, three indexes and
-- one foreign key. Nothing is dropped, renamed or rewritten.
--
-- It DOES write to an existing table, once: every user that exists when this
-- runs is marked verified. That back-fill is the whole reason this migration is
-- safe to apply to a live database, and it is explained below.

-- -----------------------------------------------------------------------------
-- users.email_verified_at — when somebody proved they control this mailbox.
--
-- Nullable, because "unverified" has to be representable. A timestamp rather
-- than a boolean: the two cost the same and the timestamp answers questions the
-- boolean cannot.
-- -----------------------------------------------------------------------------
ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMPTZ(6);

-- -----------------------------------------------------------------------------
-- BACK-FILL: everybody who already exists is verified.
--
-- This is the line that decides whether applying this migration is safe or
-- catastrophic, so it is worth being explicit about.
--
-- Without it, the column is NULL for every existing row, and the login
-- enforcement added alongside this migration would lock EVERY CURRENT USER out
-- of their own account the moment it deployed — including the platform owner,
-- who would then be unable to reach the console needed to investigate. A
-- security feature that logs out the entire customer base on release is an
-- outage, whatever it prevents.
--
-- The claim being made is narrow and defensible: these accounts were created
-- under a policy that did not require verification, they are in use, and
-- retroactively doubting them proves nothing about the mailboxes. Verification
-- starts applying to registrations from here on, which is the requirement.
--
-- `created_at` is used as the verification moment rather than now(), so the
-- timestamp stays truthful as "verified no later than account creation" rather
-- than asserting that thousands of people all confirmed at deploy time.
-- -----------------------------------------------------------------------------
UPDATE "users" SET "email_verified_at" = "created_at" WHERE "email_verified_at" IS NULL;

-- -----------------------------------------------------------------------------
-- The verification tokens.
--
-- A SEPARATE table from password_reset_tokens even though the shape is
-- identical. The two mean different things — one proves ownership of an
-- address, the other grants the power to change a credential — and a shared
-- table would let a verification link be redeemed as a password reset the first
-- time somebody confused the two columns.
--
-- Only the SHA-256 hash is stored. The raw token exists in transit and in the
-- recipient's mailbox, so a database disclosure yields nothing that can be
-- redeemed.
-- -----------------------------------------------------------------------------
CREATE TABLE "email_verification_tokens" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    -- Non-null means spent. Kept rather than deleted, so a replay attempt is
    -- visible instead of merely failing.
    "used_at" TIMESTAMPTZ(6),
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(400),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- The lookup every redemption performs, and the reason a raw token is never
-- needed in the database: the hash is the key.
CREATE UNIQUE INDEX "email_verification_tokens_token_hash_key"
    ON "email_verification_tokens" ("token_hash");

-- "Has this person any live verification token?" — asked on every resend.
CREATE INDEX "email_verification_tokens_user_id_used_at_idx"
    ON "email_verification_tokens" ("user_id", "used_at");

-- Supports expiry sweeps without scanning the table.
CREATE INDEX "email_verification_tokens_expires_at_idx"
    ON "email_verification_tokens" ("expires_at");

-- CASCADE: a deleted user's verification tokens are not history worth keeping,
-- and a live token pointing at nobody is a row that can only cause confusion.
ALTER TABLE "email_verification_tokens"
    ADD CONSTRAINT "email_verification_tokens_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
