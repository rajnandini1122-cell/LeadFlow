# Runbook

## Local development options

This project's primary development machine has no Docker, no WSL2 and no native
Postgres. Three supported setups:

### 1. Managed services — recommended

[Neon](https://neon.tech) for Postgres, [Upstash](https://upstash.com) for
Redis. Both have free tiers adequate for development.

```
DATABASE_URL=postgresql://…@ep-xxx-pooler.…neon.tech/idea001?sslmode=require
DIRECT_DATABASE_URL=postgresql://…@ep-xxx.…neon.tech/idea001?sslmode=require
REDIS_URL=rediss://default:…@….upstash.io:6379
```

Neon gives two hostnames. The **pooled** one is for the application; the
**unpooled** one is for migrations. Getting this backwards produces migrations
that hang or fail with confusing lock errors.

Use a Neon **branch** per developer or feature so nobody shares a schema.

### 2. Docker

```bash
docker compose -f infrastructure/docker/docker-compose.yml up -d
```

Postgres 17, Redis 8 and MinIO — the same images CI and production use. Highest
fidelity.

### 3. In-process Postgres — no Docker required

```bash
node scripts/local-db.mjs              # persistent, ./.tmp/pgdata
node scripts/local-db.mjs --memory     # ephemeral
node scripts/local-db.mjs --port 5433
```

Runs **real PostgreSQL 17** compiled to WebAssembly (PGlite), served over the
Postgres wire protocol, so Prisma connects through the ordinary `pg` driver and
migrations, enums, triggers, partial indexes and CHECK constraints all behave
exactly as in production.

Two constraints, both from PGlite:

- **One connection at a time.** Set `DATABASE_POOL_MAX=1`. A second client — a
  seed script *and* the running API — will be refused.
- **A SQL error drops the connection.** Fine for the application, which reaches
  the database through validated code paths; awkward for tests that deliberately
  provoke constraint violations, which is why the schema-invariants suite opens
  a fresh `pg` connection per assertion.
- Append `?sslmode=disable` — PGlite's socket server does not implement the SSL
  negotiation Prisma's schema engine attempts by default.

Redis has no equivalent. The API degrades gracefully without it (see below), so
running with no Redis at all is fine for feature work; the test suite uses an
in-memory double.

## Tests

```bash
npm run test     -w apps/api    # unit — no database
npm run test:e2e -w apps/api    # e2e  — boots PGlite automatically
```

The e2e global setup starts its own throwaway PGlite, runs migrations and sets
`DATABASE_URL`. Nothing to start by hand.

In CI, `CI_USE_EXTERNAL_DB=1` makes the same suite use the `postgres:17` and
`redis:8` service containers instead — the images production runs.

> `maxWorkers: 1` is required, not a performance choice: PGlite serves one
> connection.

## Behaviour when dependencies fail

| Failure | Behaviour |
|---|---|
| **Redis down** | API keeps serving. Membership cache falls back to Postgres, the token deny list fails open (signature and expiry still checked). Verified: login succeeded in 99 ms with Redis refused. `/readiness` reports `cache: false` and returns 503. |
| **Postgres down** | API cannot serve. `/readiness` returns 503 with `database: false`. `/health` still returns 200 — the process is alive, and restarting it would not fix the database. |
| **Both probes** | `/health` = liveness, never touches a dependency. `/readiness` = should this instance receive traffic. Wire orchestrator liveness to the former and load-balancer membership to the latter. Wiring liveness to `/readiness` turns a brief database blip into a restart loop. |

## Deployment

Two processes from one image:

```bash
node dist/main.js     # API   — binds PORT
node dist/worker.js   # worker — binds nothing
```

Scale independently. Run migrations once per deploy, before either starts:

```bash
npm run db:migrate:deploy -w apps/api
```

Environments — `development`, `staging`, `production` — never share
credentials. Every variable is validated by a zod schema at boot; the process
refuses to start on a missing or malformed value rather than failing on the
first request that needs it.

## Troubleshooting

**`nest build` exits 0 but `dist/` is empty.** Stale incremental state.
`tsBuildInfoFile` is set inside `dist` so `deleteOutDir` clears both together;
if you see this, delete `dist` and any stray `*.tsbuildinfo`.

**`P1001: Can't reach database server` against a local PGlite.** Either
`?sslmode=disable` is missing, or something synchronous is blocking the event
loop — PGlite runs in-process and cannot accept connections while the loop is
blocked. Never call it behind `execFileSync`.

**`TenantContextMissingError` in a background job.** The work is not inside
`runWithTenant()` / `runAsSystem()`, or the callback returns a lazy Prisma
promise without awaiting it inside the scope. See [tenancy.md](tenancy.md).

**Dependency injection fails at runtime after a lint fix.** Something rewrote a
NestJS import to `import type`, which erases the class and leaves
`design:paramtypes` as `Object`. `consistent-type-imports` is disabled for
`apps/api` for exactly this reason — do not re-enable it.

**Login returns 429 in tests.** The strict `auth` throttler. Raise
`AUTH_THROTTLE_LIMIT` for the environment; do not hardcode limits in decorators.

**Web shows `502` / "Request failed with status code 502" on login.** The Vite
dev server is up but the API behind its `/api` proxy is not. Almost always the
API process died rather than a proxy misconfiguration — check `curl
http://127.0.0.1:3000/health` first.

The usual cause is running `npm run build` (or the full gate) in another
terminal while `npm run dev:api` is watching: `prebuild` runs `rimraf dist`,
deleting `dist/main.js` out from under the running watcher, which exits with
`MODULE_NOT_FOUND`. Restart `npm run dev:api`.

To avoid it entirely, stop the dev servers before building, or build into a
separate checkout. Tests are safe to run alongside — `npm run test` and
`npm run test:e2e` do not touch `dist`.

**Blank page on the web app after changing shared-package resolution.** The
browser loads dependencies as native ES modules and cannot read named exports
from a CommonJS build. `vite build` hides this, because Rollup converts CJS
during bundling — so the production build stays green while `npm run dev` serves
a blank page with a console `SyntaxError`. `apps/web/vite.config.ts` aliases
`@idea001/api-types` to its TypeScript source to prevent it. The Vitest smoke
test does NOT catch this class of failure (Vitest performs CJS interop); load
the page in a real browser once after touching module resolution.
