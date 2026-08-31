# LeadFlow — production deployment, backup and recovery

The architecture autopsy scored operational readiness 3/10: no production
deployment configuration, no backups, no disaster recovery plan. That was the
single reason the product classified as Functional MVP rather than Production
Beta — the application was close to ready and nothing could run it.

This document is the missing half. It is deliberately concrete: a runbook you
can follow, not a list of principles.

---

## 1. Topology

Two processes from **one image**, plus two managed services.

```
                    ┌──────────────┐
   HTTPS ──────────▶│  API         │  WORKER_ENABLED=false
                    │  main.ts     │  N replicas
                    └──────┬───────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
  ┌───────────┐     ┌───────────┐      ┌───────────┐
  │ Postgres  │     │  Redis    │      │  Object   │
  │ (managed) │     │ (managed) │      │  storage  │
  └───────────┘     └───────────┘      └───────────┘
        ▲                  ▲
        │                  │
                    ┌──────┴───────┐
                    │  WORKER      │  WORKER_ENABLED=true
                    │  worker.ts   │  EXACTLY ONE replica
                    └──────────────┘
```

### Why exactly one worker replica

The sweep is safe to run concurrently — every notification sits behind a
deterministic key with a unique index, and every marker is claimed
conditionally. Two replicas would not double-notify.

They would, however, do the same work twice and contend on the same rows for no
benefit. One replica is the correct default. Scale it only when a sweep starts
taking longer than its interval, which is visible in the `worker.lastSweepAt`
metric long before it becomes a problem.

### Why WORKER_ENABLED defaults to false

Both processes are built from the same image, so without an explicit flag every
API replica would also sweep. Three API replicas would mean three concurrent
sweeps competing with request latency — the exact thing a separate worker
process exists to prevent.

---

## 2. Required configuration

Beyond the existing `.env.example`, production needs:

| Variable | Value | Why |
|---|---|---|
| `NODE_ENV` | `production` | Disables `/api/docs`, changes error verbosity |
| `WORKER_ENABLED` | `false` on API, `true` on worker | See above |
| `FOLLOW_UP_SWEEP_INTERVAL_SECONDS` | `60` | A reminder up to a minute late is indistinguishable from on time |
| `RELEASE_SHA` | the git SHA of the build | Groups errors by deploy; without it every deploy looks the same |
| `DATABASE_URL` | pooled endpoint | Application traffic |
| `DIRECT_DATABASE_URL` | **unpooled** endpoint | Migrations take advisory locks and run DDL, which fails against a transaction-mode pooler |
| `REDIS_URL` | managed Redis, TLS | Sessions, token deny-list, queue |

Secrets come from the platform's secret store. Nothing is baked into the image.
`.env` and `.env.*` are already git-ignored, and no secret has ever been
committed — verified with `git ls-files`.

---

## 3. Database

**Managed PostgreSQL 17. Not PGlite.**

PGlite serves one connection at a time. It is excellent for fast, deterministic
local development and it stays for that, but it is not a production database and
it does not exercise production concurrency.

That divergence is not theoretical. It was recorded as debt item D-13 in the
autopsy, and a concrete instance surfaced while building the worker: PGlite
**drops its connection on a constraint violation**, where PostgreSQL with a pool
simply returns an error and carries on. The notification insert was originally
written as insert-and-catch-P2002; it worked in principle, passed in isolation,
and broke every subsequent query in the same process. It is now
`INSERT ... ON CONFLICT DO NOTHING`, which is better on both databases.

Connection pool: start at `DATABASE_POOL_MAX=10` per API replica. Saturation
shows up in `database.query_failures` on `/metrics` before it shows up as
latency.

---

## 4. Deploying

```bash
# 1. Build once. Both processes ship from this image.
docker build -t leadflow:$GIT_SHA .

# 2. Migrate BEFORE the new code starts, using the unpooled endpoint.
DATABASE_URL=$DIRECT_DATABASE_URL npm run db:migrate:deploy -w apps/api

# 3. Verify nothing is pending.
npx prisma migrate status --schema apps/api/prisma/schema.prisma

# 4. Roll the API, then the worker.
```

Migrations run first because every migration in this repository is **additive** —
26 of them, zero destructive statements, verified by scanning each one. Old code
therefore keeps working against the new schema, which is what makes a rolling
deploy safe and a rollback possible.

**That property is a rule, not an accident. Keep it.** The moment one migration
drops a column, deploys stop being rollable and this section becomes wrong.

### Rollback

Roll the *image* back. Do **not** roll migrations back — an additive migration is
harmless to old code, and `prisma migrate resolve --rolled-back` against a
migration that has already touched real data is how you lose it.

If a migration itself is the problem, write a new forward migration that
corrects it.

---

## 5. Backup and recovery

### Targets

| | Target | Reasoning |
|---|---|---|
| **RPO** | 15 minutes | Managed Postgres with WAL archiving gives this by default. Losing a quarter-hour of CRM entry is recoverable by asking the team; losing a day is not. |
| **RTO** | 4 hours | Realistic for single-region with one engineer. Promising better without a rehearsed runbook is fiction. |
| Snapshot | Daily, 30-day retention | |
| WAL | Continuous | |
| Restore test | **Quarterly** | |

### The restore test is the part that matters

A backup that has never been restored is a hypothesis, not a backup. Quarterly:

```bash
# 1. Restore the most recent snapshot into a scratch database.
# 2. Point a scratch environment at it.
# 3. Run the E2E suite against the restored data.
npm run test:e2e -w apps/api

# 4. Record the wall-clock time from "restore started" to "suite green".
#    That number IS the real RTO. If it exceeds 4 hours, the target above is
#    wrong and this document should change — not the reality.
```

### Tenant recovery

`organizations.deleted_at` exists so removing a tenant is reversible. There is
deliberately **no API that deletes an organization** — every tenant table
cascades from that row, so a hard `DELETE` destroys a customer in one statement
with no undo.

If a tenant must be removed: set `deleted_at`, wait out the retention period,
and only then consider a hard delete — from a fresh backup, with the snapshot
retained.

---

## 6. Monitoring

### Alert on two things

1. **Error-rate spike** — `api.errorRate` on `/metrics`, thresholded against a
   week of real traffic.
2. **Health-check failure** — `/readiness` non-200 twice consecutively.

More alerts than this get muted, and a muted alert is worse than none.

### Watch, but do not page on

- `worker.lastSweepAt` — **the most important single value here.** A sweep that
  stops running produces no errors and no logs. A timestamp that stops moving is
  the only evidence, and a dead sweep means nobody is being reminded of
  anything: the exact failure the worker exists to prevent.
- `api.p95Ms` — latency drift.
- `worker.failures` — per-tenant sweep failures. Non-zero and rising means one
  tenant has data the sweep cannot process.
- `notifications.created` — zero while follow-ups exist means something upstream
  of delivery is broken.

### Error tracking

`ErrorReporter` emits normalised events at error level under the `err_event`
key, so any aggregator can select on that key without parsing prose.

Every event passes through `redactText` first, which strips JWTs, bearer tokens,
connection-string credentials, and any `password` / `token` / `secret`-shaped
key. The redaction lives in one place specifically so a provider SDK cannot
bypass it — wiring a tracker means adding a transport **inside** `ErrorReporter`,
never calling one from a service.

Ordering in that function is load-bearing and is covered by a test: the generic
keyword rule, run first, matched `Authorization: Bearer <jwt>` and redacted the
word "Bearer", leaving the token in place. Specific patterns run first for that
reason.

---

## 7. Production readiness checklist

Before serving a paying customer:

- [ ] API deploys and passes `/readiness`
- [ ] Worker deploys with `WORKER_ENABLED=true`, and `worker.lastSweepAt` moves
- [ ] Migrations run from CI against the production database
- [ ] `RELEASE_SHA` set, so errors group by deploy
- [ ] Managed Postgres with WAL archiving on
- [ ] **One restore actually performed and timed**
- [ ] Error aggregation ingesting `err_event`
- [ ] Both alerts configured, and tested by deliberately breaking readiness
- [ ] Tenant isolation and FK-ownership suites green against the deployed build
- [ ] Android refresh token moved off `localStorage` (open — see debt D-07)
