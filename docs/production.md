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
* **Intake stores the enquiry; converting it is a separate switch.** A
  submission always lands durably in `integration_intakes` first. Whether it
  then becomes a Lead — routed to a team, assigned to a salesperson and given
  a first follow-up — is decided by `INTAKE_AUTO_PROCESSING_ENABLED`, which is
  **off by default**. Enabling the intake boundary does not enable conversion,
  and that separation is deliberate: see §2.1.

Rotating the secret: set the new value and redeploy. There is no overlap window,
so coordinate with whoever operates the website — a submission signed with the
old secret is refused, and the website should retry it with the same event id
once both sides agree, which is exactly what the idempotency key is for.

### 2.1 Automatic conversion — the last switch to throw

| Variable | Value | Why |
|---|---|---|
| `INTAKE_AUTO_PROCESSING_ENABLED` | **`false`** on first deploy | See below |

With it on, the worker converts stored enquiries into leads by itself: it
resolves the territory, matches the routing table, takes the next agent in the
team's round-robin and creates the first follow-up.

**Deploy with it off, every time.** `integration_intakes` is durable and may
hold a backlog that arrived before this code existed, or while the automation
was off. Switching it on is not a gradual change — the sweep works through the
backlog, assigns every enquiry in it to a real salesperson and creates a
follow-up for each. That is easy to do and extremely hard to undo: the leads
are real, the assignments are real, and the reminders go to people's phones.

The safe order is to deploy with it off, confirm enquiries are landing, read
the backlog, and only then set it to `true` and redeploy. It also requires
`WORKER_ENABLED=true` to do anything — conversion runs in the worker and never
in an API replica.

### 2.2 Automatic leads from WhatsApp

A tenant setting, **not** an environment variable: `whatsappAutoLeadEnabled` on
`organization_settings`, off by default, edited from Settings → Channels.

It is separate from `INTAKE_AUTO_PROCESSING_ENABLED` on purpose. That one is
deployment-wide and governs the website backlog; sharing it would mean a tenant
enabling WhatsApp automation also converted every stored website enquiry at
once. This one is per organization because it is a decision about one
company's sales process.

**Two switches sit in series, and both are required for a lead to appear:**

| Switch | Scope | Controls |
|---|---|---|
| `whatsappAutoLeadEnabled` | per tenant | whether an inbound WhatsApp **buying enquiry** is recorded as an `integration_intakes` row |
| `INTAKE_AUTO_PROCESSING_ENABLED` + `WORKER_ENABLED` | deployment | whether the sweep **converts** any intake — website or WhatsApp — into a lead |

So with only the tenant setting on, WhatsApp enquiries accumulate at status
`RECEIVED`, visible under Website enquiries and convertible one at a time with
`POST /api/v1/integration-intakes/:id/retry`. That is a legitimate way to run
it: a person still decides, but the enquiry arrives already parsed. Automatic
end-to-end conversion additionally needs the worker.

What it does NOT do, so nobody has to infer it:

* It never fires on every message. The text must contain a buying signal
  (`lead-signals.ts` — a readable word list, not a model), so greetings and
  thanks stay in the Inbox.
* It never creates a second active lead for a number that already has one. The
  existing duplicate rule refuses it and the message goes to review.
* It never drops anything. An enquiry the routing rules cannot place is
  recorded as blocked and stays in the review queue.
* WhatsApp only. A wa_id is a real phone number, so the enquiry can be
  de-duplicated against existing leads by the same partial unique index every
  other lead uses. Instagram and Messenger supply no number, so the same
  automation there would have nothing to de-duplicate on — leads from those
  channels are still created by a person.

Because conversion goes through the existing pipeline, routing must already be
configured for it to succeed. A WhatsApp intake carries **no country** — nothing
in this repository derives one from a phone prefix safely — so territory
resolution answers `NO_TERRITORY` and the enquiry needs a **fallback assignment
rule** to land anywhere. Without one, every WhatsApp enquiry blocks as
`NO_MATCH` and waits in review.

### The Central Admin control plane

`ADMIN_CONTROL_ENABLED=true` opens one signed server-to-server surface for the
CRAVION Central Admin backend. Disabled, every route under it answers **404** —
not 401 and not 403, because either would confirm to a scanner that there is a
control plane here and merely a secret to find.

| Variable | Required when enabled | Notes |
|---|---|---|
| `ADMIN_CONTROL_ENABLED` | — | Default `false` |
| `ADMIN_CONTROL_ORGANIZATION_ID` | yes | The one tenant this plane administers |
| `ADMIN_CONTROL_SIGNING_SECRET` | yes | ≥32 chars, platform secret store only |

Three properties, each a decision rather than an accident:

* **A separate trust domain from the website intake, with its own secret.** The
  website key lives in a public-facing site; this one can rewrite a tenant's
  routing table. The two secrets are **enforced different at boot** — sharing
  one would make a compromise of the first a compromise of the second, and
  would make either impossible to rotate alone.
* **Its signature binds more.** The website signs a timestamp, an event id and
  the body. A control command also signs the **method and the path**, so a
  captured `POST /teams` cannot be replayed against `POST /territories`, nor a
  `GET` re-aimed at a `DELETE`.
* **All or nothing.** Enabled with either value missing, the process refuses to
  start. An enabled control surface with no tenant authenticates callers and
  has nowhere to apply what they asked for; with no secret it authenticates
  nobody while still existing. Both are worse than not starting.

**Both integrations require the tenant to already exist.** The organization id
is validated as a UUID at boot, not looked up. Point either at an organization
that is not in the database and the process starts cleanly, then fails every
request at a foreign key. Create the tenant first.

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

**Mail is now on the signup critical path.** Registration issues no session
until the new owner clicks a link in their inbox, so a mail outage no longer
degrades one recovery flow — it stops every new organization from being created.
Two consequences for operating this:

* The registration response reports whether the PROVIDER accepted the message,
  and the screen tells the person their account exists but the email could not
  be sent, pointing them at "send a new link". Nobody is left with an
  unreachable account, but nobody gets in either until mail works.
* Existing users are unaffected by design. The migration sets
  `users.email_verified_at` to the migration's own execution timestamp
  (`now()`) for every row that already exists, so shipping verification does
  not sign the customer base out. If that step is ever skipped on a restore,
  **every** account is locked out at once, including the platform owner — check
  the column is populated after any manual schema work.

  > **Existing accounts are grandfathered as verified at rollout time to prevent
  > lockout. This does not assert that historical email verification occurred.**

  Read `email_verified_at` accordingly: for accounts created before this
  migration it records when the grandfathering happened, not when anybody proved
  a mailbox — no such event exists for those rows. They are recognisable as a
  block, because they all share one timestamp. From this migration onwards the
  column means what it says: the moment that person redeemed a verification
  link, accepted an emailed invitation, or signed in through an identity
  provider that asserted the address. Anything reasoning about verification
  history — an audit, a support answer, a security review — must not read a
  pre-rollout value as evidence about the mailbox.

Verification links last 24 hours, are single-use, and are stored only as a
SHA-256 hash. A resend spends the previous link, so there is never more than
one live link per account, and a per-account budget of five per hour limits how
much mail any one mailbox can be made to receive.

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

### 3.1 Preparing a fresh database

Migrations create the schema. They do **not** create the reference data the
application needs to function: permissions, the four system roles with their
grants, and the plan catalogue. Those are defined in code, and a separate,
deliberate step copies them into the database.

Without that step a freshly migrated database has no OWNER role, so
`POST /api/v1/auth/register` fails and the deployment cannot create its first
organization at all.

```bash
# 1. Schema.
DATABASE_URL=$DIRECT_DATABASE_URL npm run db:migrate:deploy -w apps/api

# 2. Verify nothing is pending.
npx prisma migrate status --schema apps/api/prisma/schema.prisma

# 3. Reference data. Idempotent — safe to re-run on every deploy.
DATABASE_URL=$DIRECT_DATABASE_URL npm run db:bootstrap -w apps/api
```

**Where these run.** From an approved one-off, build or CI context — the one
that has devDependencies installed and `DIRECT_DATABASE_URL` configured. Not
from the API or worker container.

Two different reasons, and only the first is a guarantee:

* **`db:bootstrap` cannot run there at all.** It executes through `tsx`, a
  devDependency, and the runtime image is built with `npm ci --omit=dev`. The
  Docker CI gate asserts `tsx` is absent, so this will not drift quietly.
* **The Prisma CLI happens to be there, and that is not a contract.** `prisma`
  is present in the runtime image as a transitive dependency of
  `@prisma/client`, which is a production dependency — so `npx prisma migrate
  deploy` would in fact work from inside the container today. Nobody chose
  that and nothing pins it: a patch release of the client could drop it, and
  no test in this repository would notice. **Do not build a deployment
  procedure on it.**

> An earlier version of this document stated the runtime image contained
> neither tool. That was wrong about the Prisma CLI, and the Docker CI gate is
> what proved it — the assertion written from that belief failed on its first
> run. The dependency graph is
> `@prisma/client@7 → prisma@7`, plus `typescript` alongside it.

Keeping schema changes in one place is still the right practice; it is now a
deliberate convention rather than something the image enforces.

**`db:bootstrap` requires `DIRECT_DATABASE_URL` when `NODE_ENV=production`** and
refuses to start without it, rather than quietly falling back to whichever URL
happens to be set. It creates no organization, no user and no business data;
it prints the organization and user counts afterwards so the run says plainly
that it changed neither.

> ### ⚠️ Never run `db:seed` against production
>
> `npm run db:seed` is the DEVELOPMENT seed. It creates demo organizations
> (*Northwind Supply*, *Meridian Foods*) staffed by demo users who share one
> password — working credentials nobody chose, in the same tenant table as real
> customers.
>
> It refuses to run when `NODE_ENV=production`, exiting non-zero before it
> writes anything. Do not work around that. Production's path is
> `db:bootstrap`, which shares the same reference-data code and creates no
> tenant data.

### 3.2 Creating the CRAVION platform owner

CRAVION operates the platform and is not a customer. Its master account holds a
distinct system role, `PLATFORM_OWNER`, which no tenant API can grant.

```bash
# After db:migrate:deploy and db:bootstrap.
PLATFORM_OWNER_EMAIL=... PLATFORM_OWNER_FIRST_NAME=... PLATFORM_OWNER_LAST_NAME=... PLATFORM_OWNER_PASSWORD=...   npm run db:bootstrap-platform-owner -w apps/api
```

| Variable | Notes |
|---|---|
| `PLATFORM_OWNER_EMAIL` | Validated for shape before anything is written |
| `PLATFORM_OWNER_FIRST_NAME` / `_LAST_NAME` | Required |
| `PLATFORM_OWNER_PASSWORD` | **12 characters minimum** — the same bar as a customer OWNER |

The password is read from the environment so it stays out of shell history and
process listings. It is never echoed, never logged, and never included in an
error message.

It creates the organization **CRAVION VENTURES (OPC) PRIVATE LIMITED**
(`cravion-ventures`) with `organization_type = INTERNAL`, the master user, and a
membership carrying `PLATFORM_OWNER`. Idempotent: a re-run reconciles and
reports, and **never rewrites an existing password** — a bootstrap that reset
credentials would be a takeover tool wearing a safe name.

It refuses, by name, rather than guessing:

* an existing organization already holding the slug — converting a customer into
  the platform operator would hand their owner access to every other customer;
* a soft-deleted platform organization — resurrection is a decision;
* an existing user who is not ACTIVE — reactivation is a decision;
* a missing `PLATFORM_OWNER` role — run `db:bootstrap` first, which owns
  reference data.

**Billing.** The internal organization has **no subscription row**, and that is
correct: there is no plan, no period and no payment. `GET
/api/v1/subscriptions/entitlement` reports `PLATFORM_INTERNAL` with
`billable: false`, and the billing screen shows an "Internal CRAVION account"
card instead of a trial countdown or an upgrade prompt. It does **not** claim the
account is paid. Customer organizations are unaffected — same trial, same
statuses, same screen.

**Privilege boundary.** A `platform.*` permission does not widen the Prisma
tenant scope. A platform owner's ordinary requests see only the organization
their token is scoped to, exactly like anybody else's; crossing tenants happens
only through `PlatformAdminRepository` under an audited system scope, and reads
identity, lifecycle and counts — never a customer's leads, contacts or
conversations. Every cross-tenant action is audited against the **target**
organization, so a customer can see that it happened.

### 3.3 Creating the first customer organization

Through the application's supported registration flow, not a script:

1. Start the API with both integrations and automation **off**.
2. Register the organization at `POST /api/v1/auth/register` (or the web sign-up
   page), with a password the owner chooses.
3. Read back the new organization's UUID — from the registration response, or
   `GET /api/v1/organizations/current` as that owner.
4. Set that UUID as `WEBSITE_INTAKE_ORGANIZATION_ID` and
   `ADMIN_CONTROL_ORGANIZATION_ID` when enabling those integrations, and
   redeploy.

The bootstrap deliberately does not create this organization. A script that
invented an owner account would be inventing a credential, and a credential a
script chose is one that lives in a script.

**Both integration organization ids are UUID-format-validated only, never
looked up.** Point either at an organization that does not exist and the process
starts cleanly, then fails every request at a foreign key. Create the tenant
first, then configure the id.

---

## 4. Deploying

Two Railway services from **one image**, configured as code in
`infrastructure/deployment/`: `railway.api.toml` starts
`node apps/api/dist/main.js` with a `/health` healthcheck, and
`railway.worker.toml` starts `node apps/api/dist/worker.js` with **no**
healthcheck, because the worker binds no port. Nothing deploys automatically —
CI builds and tests, and has no deploy job.

```bash
# 1. Build once. Both processes ship from this image.
docker build -t leadflow:$GIT_SHA .

# 2. Migrate BEFORE the new code starts, using the unpooled endpoint.
DATABASE_URL=$DIRECT_DATABASE_URL npm run db:migrate:deploy -w apps/api

# 3. Verify nothing is pending.
npx prisma migrate status --schema apps/api/prisma/schema.prisma

# 4. Roll the API, then the worker.
```

### The web app ships inside the API

The API process serves the built React bundle from `apps/web/dist` at the same
origin it answers `/api/v1` on. There is no second service and no CDN to
configure: the image contains both, so they cannot disagree about the contract
between them.

That is not only convenience. The browser bundle calls the API with **relative**
paths and holds its refresh token in an httpOnly `SameSite=Strict` cookie. Split
across two origins, both stop working as designed — an absolute API URL baked in
at build time, CORS, and a cookie that is no longer same-site.

`/api/*`, `/health` and `/readiness` are excluded from the SPA fallback, so an
unknown API route still answers the API's JSON 404 rather than an HTML page, and
a missing fingerprinted asset still answers 404 rather than the shell. The
boundary is asserted in `apps/api/test/web-hosting.e2e-spec.ts`.

### Full production activation order

For a first deployment, or any deployment alongside the CRAVION Admin and
website components:

| # | Step | Note |
|---|---|---|
| 0a | Provision PostgreSQL and Redis; configure `DATABASE_URL` and `DIRECT_DATABASE_URL` | |
| 0b | `db:migrate:deploy`, then `prisma migrate status` | Schema only — see §3.1 |
| 0c | **`db:bootstrap`** | Reference data. Without it registration fails on a missing OWNER role |
| 1 | Deploy LeadFlow API + worker, **automation and both integrations OFF** | `INTAKE_AUTO_PROCESSING_ENABLED=false` |
| 1b | **Create the CRAVION organization** through the registration flow, and capture its UUID | See §3.2. Not created by any script |
| 2 | Deploy J8A.1 Website/UI Functions | They hold the secret LeadFlow validates, so LeadFlow must exist first |
| 3 | Apply Admin schema 10 | |
| 4 | Deploy the J2 Website relay | |
| 5 | **Smoke test** | A signed intake lands in `integration_intakes` and stays unprocessed; a signed admin command round-trips; `/readiness` is ready; `workerProcess.status` is `HEALTHY` |
| 6 | Set `INTAKE_AUTO_PROCESSING_ENABLED=true` and redeploy | **Only after** reviewing the intake backlog — see §2.1 |

Steps 2–4 need the CRAVION organization's real UUID from step 1b, configured as
`WEBSITE_INTAKE_ORGANIZATION_ID` / `ADMIN_CONTROL_ORGANIZATION_ID` with their
two distinct signing secrets.

LeadFlow is first in every case: everything downstream authenticates *against*
it, and while an integration is disabled its routes answer 404.

Migrations run first because every migration in this repository is **additive** —
**32** of them, latest `20260923140000_admin_control_plane`, zero destructive
statements, verified by scanning each one. Old code therefore keeps working
against the new schema, which is what makes a rolling deploy safe and a
rollback possible.

One caveat on how far back a rollback reaches. `20260922220000_territories`
deterministically rewrites every `assignment_rules.criteria_key`, appending
`|territory=*`. It is injective and semantics-preserving — no rule starts or
stops matching anything — but code from **before** that migration computes
two-segment keys and would no longer agree with the stored three-segment ones.
Image rollback is therefore safe back to that deploy boundary, not past it.

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
3. **Worker heartbeat not `HEALTHY`** — `workerProcess.status` on `/api/metrics`.

More alerts than this get muted, and a muted alert is worse than none.

### The worker heartbeat

The worker binds no port, so nothing can probe it, and it fails **silently**: a
sweep that stops running produces no error, no log and no failed request. The
first evidence would otherwise be a customer who was never called.

Process-local metrics could not answer this, and for a while appeared to. The
worker recorded its sweep timestamp in the worker's memory while `/api/metrics`
was served by the API — so the API reported the worker as `null` forever,
whether it was thriving or gone.

The heartbeat fixes that with **Redis as the authority**, because Redis is
already mandatory infrastructure both processes share. The worker writes
`leadflow:worker:heartbeat` every **30s** with a **90s TTL**; any API replica
reads it.

| `workerProcess.status` | Meaning | What to do |
|---|---|---|
| `HEALTHY` | Beat within 60s | Nothing |
| `STALE` | Beat present but older than 60s | Worker is up and wedged — check its logs before it expires |
| `MISSING` | No key: TTL expired, or it never started | **Page.** Nobody is being reminded of anything |
| `UNKNOWN` | Redis unreachable | Look at Redis, not the worker — `/readiness` will also be failing |

TTL expiry *is* the crash behaviour, and it is why this is not a database
table: a dead worker stops refreshing and the key evaporates on its own.
Nothing has to notice the death, and there is no row left behind reading
"healthy". It also survives an API restart, because it is not the API's memory.

Do **not** make the Railway healthcheck depend on it. `/health` stays liveness
for the API process alone; a dead worker must page somebody, not restart the
API.

### Watch, but do not page on

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

- [ ] `db:bootstrap` run against the production database, and `db:seed` **never**
- [ ] The CRAVION organization created through the registration flow, and its
      real UUID configured for both integrations
- [ ] API deploys and passes `/readiness`
- [ ] The web app loads from the API origin, and a page refresh on a deep route
      (e.g. `/leads/<id>`) still renders rather than 404ing
- [ ] Worker deploys with `WORKER_ENABLED=true`, and `workerProcess.status` on
      `/api/metrics` reads `HEALTHY` from an **API** replica
- [ ] `INTAKE_AUTO_PROCESSING_ENABLED=false` on first deploy, and the intake
      backlog reviewed before it is ever set to `true`
- [ ] Both integration secrets set, different from each other, and the
      configured organization ids exist in the database
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
