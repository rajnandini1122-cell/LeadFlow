# LeadFlow — Email Campaigns Audit

Date: 2026-11-11. Baseline: `main` @ `661590a` (production, Railway "LeadFlow API").
Method: repository inspection plus read-only production checks (aggregate counts and
non-secret configuration only; no row data, no credentials printed).

## Summary

LeadFlow has **no Campaigns module and no marketing-email capability today**. What exists,
and is reused, is the infrastructure around it: transactional email, credential encryption,
tenant scoping, permissions, activities, a BullMQ-ready worker entry point and a pattern for
connecting per-organization channel integrations (WhatsApp/Messenger).

The decisive finding: **Railway blocks outbound SMTP for this project.** That was diagnosed
in production on 2026-09-24 (commit `7ce46dc`): connections to port 587 timed out before
authentication, so transactional mail was moved to Resend's HTTPS API. Railway's own
documentation limits outbound SMTP to the Pro plan. Per-organization SMTP sending, which is
what this feature requires, therefore **cannot work from production until outbound SMTP is
enabled for the Railway workspace**. The feature is built and tested with fake servers and
ships disabled. See "Blockers".

## 1. Campaigns screens and data structures

| Looked for | Found | Evidence |
|---|---|---|
| Campaign UI | None. `apps/web/src/features/marketing/*` is the public website (home, pricing, about), not campaigns. | `grep -ri campaign apps/web/src` → no matches |
| Campaign tables | None. | `prisma/schema.prisma` model list: no campaign, template, consent or suppression model |
| "campaign" in the API | Only attribution (`IntegrationIntake.utm*`, web analytics `source=campaign`). | `integrations/website/dto/website-intake.dto.ts`, `platform-analytics/web-analytics.ts` |

Gap: everything — campaigns, recipients, deliveries, reporting.

## 2. Email integration and simulation

| Component | State | Evidence |
|---|---|---|
| `common/email/EmailService` | Transactional only: password reset, verification, invitation, enquiry, billing notice. Never throws; logs "accepted", never "delivered". | `src/common/email/email.service.ts` |
| Providers | `console` (simulation), `unconfigured`, `smtp` (nodemailer, implicit TLS or required STARTTLS), `resend` (HTTPS). | `src/common/email/providers/*` |
| Production provider | `EMAIL_PROVIDER=resend`, sender domain `cravionventures.com`. SMTP_* variables are set but unused. | Railway variables (names/values of non-secrets only) |
| Outbound SMTP from Railway | **Blocked** (connect timeout). | commit `7ce46dc`; env.schema.ts comment on `RESEND_API_KEY`; [Railway outbound networking](https://docs.railway.com/reference/outbound-networking) |
| nodemailer | Pinned `10.0.10`, runtime dependency. | `apps/api/package.json` |
| IMAP client | None. | no imapflow/mailparser in package.json |

Reuse: nodemailer and the SMTP TLS rules (implicit TLS or *required* STARTTLS). Not reused:
`EmailService` itself — it is the platform's transactional channel (one sender, swallow
errors) and campaigns need per-organization senders, per-recipient outcomes and
classification of failures. Campaign mail must never be sent through Resend under the
platform's identity.

## 3. Templates and lead selection

| Component | State | Evidence |
|---|---|---|
| Email templates | Transactional templates in code only. | `src/common/email/email.templates.ts` |
| WhatsApp templates | Synced from Meta, per org. Not reusable for email (different content model). | `omnichannel/providers/whatsapp/whatsapp-template.*` |
| Lead list filters | Server-side filters on the leads list (status, priority, assignee, source, product, city, qualification…). | `modules/leads` |
| Fields usable for filtering | Lead: status, priority, source, city, state, country, product, assignee, qualification. Account: `industry` (1 account has it). **No tags exist.** | schema `Lead`, `Account.industry` |

Gap: email templates, merge fields, sanitisation, a recipient query that applies eligibility.
"Tags" in the request: there is no tag model; filtering uses the fields above.

## 4. Background workers and queues

| Component | State | Evidence |
|---|---|---|
| Worker entry point | `src/worker.ts` (`start:worker`), application context without HTTP. | `apps/api/src/worker.ts` |
| BullMQ + Redis | Wired for the follow-up sweep and integration intake; processors run only when `WORKER_ENABLED=true`. | `src/queues/queues.module.ts`, `intake-queue.ts` |
| Production | `WORKER_ENABLED=false`; **no worker service on Railway** (services: LeadFlow API, LeadFlow [migrations], postgres-17, Redis). | Railway status/variables |
| Outbound recovery precedent | WhatsApp outbound uses a recovery service for interrupted sends. | `omnichannel/outbound-recovery.service.ts` |

Decision: campaign delivery uses a **PostgreSQL-leased queue** (rows claimed with
`FOR UPDATE SKIP LOCKED` and a lease), not BullMQ. The recipient rows *are* the queue, so
enqueue is atomic with campaign confirmation, a Redis flush cannot lose work, and recovery
after a restart is a query. The dispatcher runs where `EMAIL_DISPATCH_ENABLED=true`
(default off), either in the API process or in a dedicated worker service.

## 5. Consent and unsubscribe

| Looked for | Found |
|---|---|
| Marketing consent fields | None, on Lead or Contact. |
| Unsubscribe / suppression | None. |
| Bounce handling | None. |

Consequence, applied as a rule: **no existing lead or contact is marketing-eligible.**
Eligibility must be recorded explicitly (basis, source, who, when) before a promotional send
can include the address. Imports do not grant it.

## 6. Permissions

Catalogue in `packages/api-types/src/permissions.ts`; roles OWNER ⊃ ADMIN ⊃ MANAGER ⊃
SALES_REP, synced to the database by `prisma/bootstrap.ts` on every deploy. No email or
campaign permissions exist. PLATFORM_OWNER inherits OWNER within *its own* organization only;
tenant scoping (below) stops cross-organization access, including to mailbox credentials.

## 7. Activities and follow-ups

`LeadActivity` with `ActivityType` enum (calls, WhatsApp sent/delivered/read/received,
notes, status, follow-ups, documents). No email types. `FollowUp` model and follow-up sweep
exist. Gap: email sent / reply received activity types; reply → follow-up suggestion.

## 8. Deployment, migrations, tests

* Railway auto-deploys `main`; migrations run in the "LeadFlow" service
  (`migrate deploy` → `status` → `bootstrap`). Releases with migrations go migration-first.
* Tenant isolation: `common/prisma/tenant-scope.extension.ts` — every model in
  `TENANT_SCOPED_MODELS` is filtered by organization or the query is refused; the
  cross-tenant e2e suite covers every listed model automatically.
* Credential encryption: `common/crypto/secret-box.ts` (AES-256-GCM, `CREDENTIAL_ENCRYPTION_KEY`,
  set in production). Used for WhatsApp tokens — reused for mailbox passwords.
* Tests: Jest unit (~1,355), e2e on PGlite or real Postgres 17 (CI), 80 suites.

## Production baseline (read-only, aggregates)

| Measure | Value |
|---|---|
| Organizations | 7 (6 customers PENDING_REVIEW + CRAVION internal) |
| Live leads / with email | 142 / 78 |
| Contacts / with email | 143 / 77 |
| Organizations holding any lead email | 1 |
| Imported leads | 0 |
| Products | 2 |
| Lead attachments | 0 |
| Channel integrations | 1 |

## CRAVION mailbox (owner-provided settings)

`sales@cravionventures.com`, IMAP `mail.cravionventures.com:993` SSL/TLS, SMTP on the same
host. Checked from a workstation (TCP/TLS only, no login):

| Check | Result |
|---|---|
| Host | HostingRaja shared cPanel (`server70.hostingraja.org`, Exim 4.100) at 103.146.177.70 |
| IMAP 993 | TLS valid (`cravionventures.com`, expires 2027-01-12), IMAP4rev1 with IDLE |
| SMTP 465 | TLS valid, same certificate |
| SPF | present, includes the server IP, `~all` |
| DKIM | `default._domainkey` present (cPanel) and `resend._domainkey` |
| DMARC | `p=none` (monitoring only) |

Shared-hosting senders have hourly per-domain limits; the configured campaign limit must
stay below the host's limit (to be confirmed with HostingRaja).

## Blockers and risks

1. **Outbound SMTP from Railway** (blocker for production sending and test-send). Options:
   enable SMTP on the Railway workspace (Pro plan; then verify ports 465/587 from the
   container), or deliver campaigns through an HTTPS email API with the organization's
   verified domain. Decision for the owner.
2. **IMAP egress from Railway** (port 993) — not yet verified from the container; a probe
   from inside production requires owner permission.
3. **No worker service** in production; the dispatcher can run in the API process
   (leased, multi-replica safe) or in a new small worker service.
4. Shared-hosting sending limits and reputation: bulk promotional mail from a shared cPanel
   IP can be throttled or blocklisted; limits must be conservative.
5. DMARC `p=none` — acceptable for testing; tighten after alignment is verified.
