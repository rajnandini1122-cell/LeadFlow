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
| `REDIS_URL` | managed Redis, TLS | Sessions, token deny-list, queue, **rate-limit counters** |
| `TRUST_PROXY_HOPS` | the real number of proxies in front of the API | See below. Wrong in either direction is a security bug |
| `EMAIL_PROVIDER` | `smtp` | `console` only logs and is refused in production |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASSWORD` | the real mailbox | Required together; a partial set refuses to boot |
| `EMAIL_FROM` | a mailbox the SMTP server may send as | Most servers reject a `From` they do not own |
| `DEFAULT_COUNTRY` / `DEFAULT_TIMEZONE` / `DEFAULT_CURRENCY` / `DEFAULT_LOCALE` | `IN` / `Asia/Kolkata` / `INR` / `en-IN` | Applied to NEW organizations only; existing tenants keep their own. Validated at boot |

### Getting `TRUST_PROXY_HOPS` right

`req.ip` is what every rate limit and audit row is keyed on, and Express derives
it by walking `X-Forwarded-For` from the right through this many hops.

* **Too high** (or `true`) — any caller invents a fresh identity per request by
  sending the header, and the limiter stops existing. This is the failure that
  matters: it is silent, and it looks exactly like a working limiter.
* **Too low** — every customer behind the load balancer shares one bucket, so
  one noisy client locks out the rest.

Count the hops that actually append to the header: `1` behind a single load
balancer, `2` behind a CDN in front of one. The default is `0` — trust nothing —
which is correct until the topology is known, and is the value the tests run
under. Verify after a deploy by comparing the `ip` on an audit row against the
address the client really used.

### The website intake boundary

`WEBSITE_INTAKE_ENABLED=true` opens one server-to-server route,
`POST /api/v1/integrations/website/intake`, for an approved backend to submit
enquiries. Disabled, it answers 404 — an endpoint nobody has configured should
not announce itself.

A caller proves itself by signing each request. Three headers:

| Header | Meaning |
|---|---|
| `X-LeadFlow-Timestamp` | unix seconds; accepted within five minutes either way |
| `X-LeadFlow-Event-Id` | the caller's own id for the submission, and the idempotency key |
| `X-LeadFlow-Signature` | `sha256=<hex>`, HMAC-SHA256 of `<timestamp>.<eventId>.<sha256 of the exact body bytes>` |

Three properties are worth stating because each one is a decision:

* **The tenant is configuration.** `WEBSITE_INTAKE_ORGANIZATION_ID` decides
  where a submission lands. A signature proves who is calling, not what they
  may touch — a body that could name an organization would make one shared
  secret into access to every tenant. An `organizationId` in the payload is
  stripped before validation sees it.
* **A retry is not a second customer.** The event id is unique per tenant and
  source *in the database*, so two identical requests arriving together produce
  one row and one receipt. The same id carrying a different payload is a 409
  rather than an overwrite.
* **Intake does not create a Lead yet.** An active lead needs a next follow-up
  date, and a lead needs an owner to be anybody's job. Both are policy —
  how soon somebody calls a website enquiry, and who — and those belong to the
  assignment workstream. Submissions are durable and auditable in
  `integration_intakes`; `created_lead_id` is what will record the conversion.

Rotating the secret: set the new value and redeploy. There is no overlap window,
so coordinate with whoever operates the website — a submission signed with the
old secret is refused, and the website should retry it with the same event id
once both sides agree, which is exactly what the idempotency key is for.

### Mail

`EMAIL_PROVIDER=smtp` talks to any standards-compliant server; there is no
vendor in the code. Two things are worth knowing before the first deploy:

* **Boot does not touch the network.** The configuration is validated and the
  transport is built, but no SMTP connection is opened and no test message is
  sent. A mail server having a bad morning must not stop every API replica from
  serving requests that have nothing to do with email — and a startup probe
  that sends real mail is a side effect nobody asked for. The cost of that
  choice is that a wrong password is discovered by the first password reset,
  in the log, rather than at deploy time. Send one reset to a mailbox you
  control as the last step of a deploy.
* **Delivery failures are deliberately invisible to callers.** `forgot-password`
  answers identically whether the address exists, the send succeeded, or SMTP
  is down; an operator reads `SMTP delivery failed` in the log, with the tag
  and the recipient's domain, never the address, the link or the credential.

Set `SMTP_SECURE` to match the port the server actually offers — `true` for
implicit TLS (465), `false` for a STARTTLS upgrade (587). It is never inferred,
and `false` still requires the upgrade to succeed.

Rate-limit counters live in Redis so that every replica enforces one shared
limit rather than its own copy of it. If Redis is unreachable the limiter fails
**open** and says so in the log (`Rate-limit storage is unreachable`) — requests
pass unthrottled until it returns, and `/readiness` reports the outage.

### The process refuses to start when these are wrong

Three checks fail at boot rather than letting a process look healthy while a
capability it exists to provide is silently off:

| Condition | Why it refuses |
|---|---|
| FCM partially configured | With one or two of the three values set, the provider reports itself unconfigured. Notifications are created, persisted, and never delivered — every probe green. |
| `WORKER_ENABLED=true` in production with no FCM | A worker whose entire job is reaching salespeople, deployed with no way to reach them. Somebody finds out by missing a customer. |
| `RELEASE_SHA` unset in production | Every deploy groups as one deploy in the error tracker, so today's regression is indistinguishable from three-month-old noise. |

An API replica (`WORKER_ENABLED=false`) does NOT need FCM credentials — it
delivers nothing, and requiring them would put a secret on every web pod.

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
shows up in `database.query_failures` on `/api/metrics` before it shows up as
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

1. **Error-rate spike** — `api.errorRate` on `/api/metrics`, thresholded against a
   week of real traffic.
2. **Health-check failure** — `/readiness` non-200 twice consecutively.

More alerts than this get muted, and a muted alert is worse than none.

### Watch, but do not page on

- `worker.lastSweepAt` (on `/api/metrics`) — **the most important single value here.** A sweep that
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
- [ ] `TRUST_PROXY_HOPS` set to the real hop count, and an audit row checked to
      confirm it records the client's address rather than the proxy's
- [ ] `EMAIL_PROVIDER=smtp` with real credentials, and **one password reset
      actually delivered** to a mailbox you control — boot does not prove mail
      works, only that it is configured
- [ ] Android refresh token moved off `localStorage` (open — see debt D-07)

---

## 8. Android release builds

```bash
VITE_API_BASE_URL=https://api.your-domain.example npm run android:release -w apps/web
```

The build REFUSES to produce an artefact that cannot work — no URL, a
`localhost` or private-network address, or plaintext http. The P2 audit built a
release APK with no API URL at all: correct at runtime (it throws loudly rather
than guessing) but only discoverable after signing, uploading and installing it.
The check now happens before the build.

Debug builds are deliberately exempt: pointing one at a LAN address is exactly
what testing on a real handset requires.
