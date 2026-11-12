# LeadFlow — Email Campaigns Architecture

Companion to `LEADFLOW_EMAIL_CAMPAIGNS_AUDIT.md`. Everything here runs in the existing
NestJS API codebase and PostgreSQL. No Firebase Function, no CRAVION Admin change.

## Principles

1. **Off until approved.** `EMAIL_CAMPAIGNS_SENDING_ENABLED=false` (platform switch) and a
   per-organization mailbox that starts disabled. With either off, nothing is delivered to a
   customer: campaigns can be drafted and previewed, nothing more.
2. **No one is marketing-eligible by default.** Eligibility is an explicit record with a basis.
3. **The database is the queue.** One row per recipient, created in the same transaction that
   confirms the campaign.
4. **At-most-once for promotional mail.** SMTP is not transactional with PostgreSQL. When the
   outcome of a send is unknown, the recipient is marked `UNCERTAIN` and is *not* retried.
5. **Accurate words.** "Accepted by SMTP" is not "delivered". No opens or clicks are tracked,
   so none are shown.
6. **Tenant isolation by construction.** Every new table is in `TENANT_SCOPED_MODELS`.

## Data model (migration `20261111090000_email_campaigns`, additive)

| Table | Purpose | Key constraints |
|---|---|---|
| `email_mailboxes` | One mailbox per organization: address, description, SMTP host/port/security, IMAP host/port/security, username, **encrypted password** (AES-256-GCM, `CREDENTIAL_ENCRYPTION_KEY`), enabled, hourly/daily limits, last SMTP/IMAP check and sync state (UIDVALIDITY, last UID). | unique `organization_id` |
| `marketing_consents` | Per organization + normalized email: `GRANTED` or `WITHDRAWN`, basis (`CONSENT`, `EXISTING_CUSTOMER`, `LEGITIMATE_INTEREST_REVIEWED`), source, note, who/when. Absence = unknown = ineligible. | unique (`organization_id`, `email`) |
| `email_suppressions` | Never send promotional mail: `UNSUBSCRIBED`, `BOUNCED`, `COMPLAINT`, `MANUAL`. | unique (`organization_id`, `email`) |
| `email_templates` | Reusable subject + sanitized HTML + plain text, by category. | per org |
| `email_assets` | Attachments (PDF/PNG/JPEG, ≤ 5 MB each), optionally linked to a product (catalogue). Bytes in the database, as lead attachments are. | per org, sha256 |
| `email_campaigns` | Name, category, purpose (`PROMOTIONAL`/`TRANSACTIONAL`), subject, HTML, text, asset ids, recipient filter, status, schedule, confirmation (who/when/idempotency key), counters. | unique (`organization_id`, `submit_key`) |
| `email_campaign_recipients` | **The queue.** Email, lead/contact ids, merge snapshot, status, attempts, `next_attempt_at`, lease (`locked_by`, `locked_until`), generated `Message-ID`, last SMTP response, hashed unsubscribe token, reply time. | unique (`campaign_id`, `email`); unique `message_id`; unique `unsubscribe_token_hash` |
| `email_delivery_attempts` | Append-only audit of every SMTP attempt: started, finished, outcome, SMTP code/response (credential-scrubbed). | append-only trigger |
| `email_inbound_messages` | IMAP messages already processed: mailbox, UIDVALIDITY+UID, Message-ID, In-Reply-To, from, subject, snippet, classification (`REPLY`, `BOUNCE`, `OTHER`), matched recipient/lead, created activity. | unique (`organization_id`, `message_id`); unique (`mailbox_id`, `uid_validity`, `uid`) |

New `ActivityType` values: `EMAIL_SENT`, `EMAIL_REPLY_RECEIVED`.

## Permissions (synced by bootstrap)

| Permission | Roles | Allows |
|---|---|---|
| `email.settings.manage` | OWNER, ADMIN | Configure/test the mailbox. Password is write-only. |
| `campaign.view` | MANAGER+ | Campaigns, reports, templates. |
| `campaign.manage` | MANAGER+ | Drafts, templates, assets, test sends to own team. |
| `campaign.send` | OWNER, ADMIN | Confirm, schedule, pause, resume, cancel. |
| `marketing.consent.manage` | OWNER, ADMIN | Record/withdraw eligibility; manage suppressions. |

PLATFORM_OWNER gets these only inside its own organization; tenant scoping prevents reading
another organization's mailbox, and no API returns a password, even to its owner.

## Mailbox settings

Fields match a standard mail client: email address, description, IMAP host/port/security,
SMTP host/port/security, password (username defaults to the address).

* Security: `SSL_TLS` (implicit) or `STARTTLS` (required, never opportunistic). No plaintext,
  `rejectUnauthorized` always true, TLS ≥ 1.2.
* SSRF: hostnames must be public DNS names; every resolved address is checked and private,
  loopback, link-local, CGNAT, multicast and reserved ranges (IPv4 and IPv6) are refused; the
  connection is made to the checked address with SNI set to the hostname, so DNS rebinding
  cannot redirect it. Ports: SMTP 465/587, IMAP 993/143(STARTTLS).
* Test SMTP: connect, TLS, AUTH, QUIT — **no message is sent**. Test IMAP: connect, TLS,
  LOGIN, SELECT INBOX (read-only), LOGOUT. 15 s timeouts. Errors are mapped to safe messages
  ("authentication failed", "TLS certificate not valid", "connection timed out").
* Saved after a successful test only if requested; every change is audited without secrets.

## Recipients and eligibility

The server builds the audience from a filter (statuses, priorities, sources, cities, states,
countries, products, assignee, account industry, qualification) over live leads with an
email, plus linked contacts. Then, per normalized address, in this order:

1. invalid address → excluded (`INVALID`)
2. suppression row → excluded (`SUPPRESSED`)
3. promotional campaign and no `GRANTED` consent → excluded (`NO_CONSENT`)
4. duplicate address → collapsed to one recipient

The preview returns counts per reason plus a sample, and the same function runs at
confirmation time and **again immediately before each send** (an unsubscribe in between wins).

## Composer and rendering

* HTML is sanitized server-side with an allow-list (`sanitize-html`): no script, style
  attributes limited, no event handlers, no `javascript:`/`data:` URLs, images only over
  https. A plain-text part is required (generated from HTML if left empty).
* Merge fields: `{{first_name}} {{last_name}} {{full_name}} {{company}} {{city}}
  {{organization}} {{sender_name}}` — values HTML-escaped; unknown fields are rejected at save.
* Footer added by the server to promotional mail: organization name, why they receive it,
  and the unsubscribe link. Branding is the sending organization's own; CRAVION branding
  only for CRAVION.

## Delivery engine

```
confirm (idempotent submit_key) ──tx──► campaign SCHEDULED/SENDING + recipients QUEUED
                                              │
dispatcher tick (every 5 s, EMAIL_DISPATCH_ENABLED)
  1. recover: SENDING with expired lease ─► UNCERTAIN (never resent automatically)
  2. per mailbox: check limits (hour/day) and platform + org switches + entitlement
  3. claim N rows: FOR UPDATE SKIP LOCKED, set SENDING + lease, insert attempt (commit)
  4. re-check suppression/consent for each claimed row
  5. SMTP send (one message per recipient, own Message-ID, List-Unsubscribe headers)
  6. classify and commit:
       250 accepted                         → ACCEPTED   (+ EMAIL_SENT activity)
       connect/TLS/auth error, 4xx before DATA → QUEUED again with backoff (1, 5, 15, 60 min; max 5)
       5xx                                  → FAILED (5.1.x recipient → BOUNCED suppression)
       error/timeout after DATA was sent     → UNCERTAIN
```

Concurrency: one SMTP connection per mailbox at a time (advisory lock on the mailbox),
any number of dispatcher replicas (`SKIP LOCKED`). Pause stops claims; resume re-allows;
cancel moves `QUEUED` rows to `CANCELLED` (rows already `SENDING` finish their single
attempt). Campaign status completes when no row is `QUEUED`/`SENDING`.

## IMAP sync and replies

Every 2 minutes per enabled mailbox: read-only `EXAMINE INBOX`, fetch UIDs above the last
seen (reset if UIDVALIDITY changes), at most 200 per run, headers + up to 256 KB of source,
parsed with `mailparser`. Matching: `In-Reply-To`/`References` against our Message-IDs →
recipient → lead. DSNs (`multipart/report; report-type=delivery-status`) referencing our
Message-ID → `BOUNCED` + suppression. Unique keys make reprocessing harmless. A reply creates
one `EMAIL_REPLY_RECEIVED` activity on the lead (text snippet only; HTML never rendered;
content never interpreted as instructions) and marks the recipient replied; the campaign
report lists replies with a "Create follow-up" action. Unmatched mail is recorded as `OTHER`
and not attached to anyone — no contacts are created from inbound mail.

## Unsubscribe

* Token: 32 random bytes (base64url) per recipient; only its SHA-256 is stored.
* Headers: `List-Unsubscribe: <https://leadflow.cravionventures.com/api/v1/email/unsubscribe/{token}>`
  and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058).
* `POST /email/unsubscribe/:token` (public, no login): suppresses the address for that
  organization and withdraws consent; idempotent. Page `/unsubscribe/:token` shows the
  organization name and a confirm button; GET never changes anything (link scanners).

## Reporting

Per campaign: selected, eligible, excluded by reason, queued, attempted, accepted by SMTP,
temporary failures (retrying), permanent failures, uncertain, cancelled, replies, unsubscribes,
status. Label: "Accepted by the mail server — not proof of inbox delivery".

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `EMAIL_CAMPAIGNS_SENDING_ENABLED` | `false` | Platform switch for real customer sends. |
| `EMAIL_DISPATCH_ENABLED` | `false` | This process runs the dispatcher and IMAP sync. |
| `EMAIL_PUBLIC_BASE_URL` | `WEB_BASE_URL` | Base for unsubscribe links. |
| `CREDENTIAL_ENCRYPTION_KEY` | (set) | Reused. |

## Rollback

Additive migration; the previous API ignores the new tables. Turning
`EMAIL_DISPATCH_ENABLED` off stops all sending and syncing immediately; queued rows wait.
