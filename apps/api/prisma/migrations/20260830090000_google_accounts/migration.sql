-- -----------------------------------------------------------------------------
-- Google-created accounts.
--
-- Records WHICH Google account an account was created from, so signing in with
-- Google is only ever a way back into an account Google created. An account
-- registered with a password has no subject id and cannot be entered this way —
-- otherwise anyone controlling the matching Google address could take over an
-- account they never registered.
--
-- Additive only: one nullable column. Existing rows get NULL, which is exactly
-- the correct value for every account that predates Google sign-in.
-- -----------------------------------------------------------------------------
ALTER TABLE "users" ADD COLUMN "google_subject" VARCHAR(64);

-- One LeadFlow account per Google account. Without this, two rows could claim
-- the same Google identity and which one you signed into would be arbitrary.
CREATE UNIQUE INDEX "users_google_subject_key" ON "users"("google_subject");
