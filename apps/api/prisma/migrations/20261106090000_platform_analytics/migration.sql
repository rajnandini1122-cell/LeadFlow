-- =============================================================================
-- Platform analytics: user activity, API metrics, public-website analytics.
-- =============================================================================
--
-- For the LeadFlow Analytics module in the CRAVION Admin panel, which reads
-- these through the signed, read-only analytics API (integrations/admin-
-- analytics). Platform-level tables: no tenant user can query them.
--
-- ADDITIVE ONLY. Two nullable columns on users, seven new tables. Nothing is
-- dropped or rewritten.
--
-- NO BACKFILL. users.first_login_at and users.last_active_at start NULL for
-- everyone: nobody's first login or last activity was recorded before this,
-- and the dashboard says so ("not recorded before <started_at>") rather than
-- guessing. Registration dates (users.created_at) and the existing
-- users.last_login_at are real history and are shown as they are.
--
-- analytics_collections records when each kind of collection began.
--
-- VOLUME. user_activity_days: one row per active user per day. api_metric_
-- hours: one row per hour per (method, route template, status, error code)
-- that occurred -- tens to low hundreds a day at current traffic.
-- api_organization_hours: one per active organization per hour. Web tables:
-- one row per visitor, per visit, per (day, path) and per (day, event,
-- source). Retention is enforced by the API (see analytics-retention.ts):
-- 400 days for daily/visitor tables, 90 days for hourly API metrics.
--
-- ROLLBACK: DROP the seven tables and the two columns. The previous API reads
-- none of them, so rolling back the API alone does not require this.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "users"
    ADD COLUMN "first_login_at" TIMESTAMPTZ(6),
    ADD COLUMN "last_active_at" TIMESTAMPTZ(6);

CREATE TABLE "analytics_collections" (
    "key"        VARCHAR(40)    NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "analytics_collections_pkey" PRIMARY KEY ("key")
);
INSERT INTO "analytics_collections" ("key") VALUES ('user_activity'), ('api_metrics'), ('web_analytics')
ON CONFLICT DO NOTHING;

CREATE TABLE "user_activity_days" (
    "user_id"         UUID           NOT NULL,
    "organization_id" UUID           NOT NULL,
    "day"             DATE           NOT NULL,
    "first_seen_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_activity_days_pkey" PRIMARY KEY ("user_id", "organization_id", "day")
);
CREATE INDEX "user_activity_days_day_idx" ON "user_activity_days" ("day");
CREATE INDEX "user_activity_days_organization_id_day_idx" ON "user_activity_days" ("organization_id", "day");

CREATE TABLE "api_metric_hours" (
    "hour"       TIMESTAMPTZ(6) NOT NULL,
    "method"     VARCHAR(8)     NOT NULL,
    "route"      VARCHAR(200)   NOT NULL,
    "status"     SMALLINT       NOT NULL,
    "error_code" VARCHAR(60)    NOT NULL DEFAULT '',
    "count"      INTEGER        NOT NULL DEFAULT 0,
    "total_ms"   BIGINT         NOT NULL DEFAULT 0,
    "max_ms"     INTEGER        NOT NULL DEFAULT 0,
    "h0" INTEGER NOT NULL DEFAULT 0, "h1" INTEGER NOT NULL DEFAULT 0, "h2" INTEGER NOT NULL DEFAULT 0,
    "h3" INTEGER NOT NULL DEFAULT 0, "h4" INTEGER NOT NULL DEFAULT 0, "h5" INTEGER NOT NULL DEFAULT 0,
    "h6" INTEGER NOT NULL DEFAULT 0, "h7" INTEGER NOT NULL DEFAULT 0, "h8" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "api_metric_hours_pkey" PRIMARY KEY ("hour", "method", "route", "status", "error_code")
);
CREATE INDEX "api_metric_hours_hour_idx" ON "api_metric_hours" ("hour");

CREATE TABLE "api_organization_hours" (
    "hour"            TIMESTAMPTZ(6) NOT NULL,
    "organization_id" UUID           NOT NULL,
    "count"           INTEGER        NOT NULL DEFAULT 0,
    "error_count"     INTEGER        NOT NULL DEFAULT 0,
    CONSTRAINT "api_organization_hours_pkey" PRIMARY KEY ("hour", "organization_id")
);
CREATE INDEX "api_organization_hours_organization_id_hour_idx" ON "api_organization_hours" ("organization_id", "hour");

CREATE TABLE "web_visitors" (
    "visitor_hash"  CHAR(64)       NOT NULL,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "first_source"  VARCHAR(20)    NOT NULL,
    "first_landing" VARCHAR(120)   NOT NULL,
    CONSTRAINT "web_visitors_pkey" PRIMARY KEY ("visitor_hash")
);
CREATE INDEX "web_visitors_first_seen_at_idx" ON "web_visitors" ("first_seen_at");

CREATE TABLE "web_sessions" (
    "session_hash"    CHAR(64)       NOT NULL,
    "visitor_hash"    CHAR(64)       NOT NULL,
    "day"             DATE           NOT NULL,
    "started_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "landing_path"    VARCHAR(120)   NOT NULL,
    "source"          VARCHAR(20)    NOT NULL,
    "referrer_domain" VARCHAR(120),
    "page_views"      INTEGER        NOT NULL DEFAULT 0,
    "returning"       BOOLEAN        NOT NULL DEFAULT false,
    CONSTRAINT "web_sessions_pkey" PRIMARY KEY ("session_hash")
);
CREATE INDEX "web_sessions_day_idx" ON "web_sessions" ("day");
CREATE INDEX "web_sessions_visitor_hash_idx" ON "web_sessions" ("visitor_hash");

CREATE TABLE "web_page_days" (
    "day"   DATE         NOT NULL,
    "path"  VARCHAR(120) NOT NULL,
    "views" INTEGER      NOT NULL DEFAULT 0,
    CONSTRAINT "web_page_days_pkey" PRIMARY KEY ("day", "path")
);

CREATE TABLE "web_event_days" (
    "day"    DATE        NOT NULL,
    "event"  VARCHAR(40) NOT NULL,
    "source" VARCHAR(20) NOT NULL,
    "count"  INTEGER     NOT NULL DEFAULT 0,
    CONSTRAINT "web_event_days_pkey" PRIMARY KEY ("day", "event", "source")
);

COMMIT;
