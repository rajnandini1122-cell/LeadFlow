-- =============================================================================
-- 20260820120000_neutral_tenant_locale
--
-- Removes the product's built-in assumption that every tenant is Indian.
--
-- Locale, currency, timezone and dialling country become per-organization data
-- rather than hardcoded constants. EXISTING organizations keep whatever they
-- already have — those are real tenant choices, not defaults to be overwritten.
-- Only the defaults for NEW organizations change.
-- =============================================================================

-- BCP 47 locale. Drives number, date and currency formatting in the clients.
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "locale" VARCHAR(16) NOT NULL DEFAULT 'en-US';

-- ISO 3166-1 alpha-2. Default dialling region when a user types a local number.
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "country" VARCHAR(2) NOT NULL DEFAULT 'US';

-- New tenants are no longer assumed to be in India. Existing rows are untouched.
ALTER TABLE "organizations" ALTER COLUMN "timezone" SET DEFAULT 'UTC';
ALTER TABLE "organizations" ALTER COLUMN "currency" SET DEFAULT 'USD';

-- Lead sources become tenant-configurable. An empty array means "use the
-- neutral built-in list", so a brand new organization works before anyone
-- configures anything.
ALTER TABLE "organization_settings"
  ADD COLUMN IF NOT EXISTS "lead_sources" TEXT[] NOT NULL DEFAULT '{}';
