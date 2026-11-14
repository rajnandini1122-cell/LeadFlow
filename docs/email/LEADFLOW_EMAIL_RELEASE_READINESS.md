# LeadFlow — Email Campaigns Release Readiness

Status: **NOT production-ready for customer sending.** Code is complete and tested with local
fake servers. Customer sending stays disabled until every activation gate below is met and the
owner approves. An authorized user has not yet verified the send-and-reply workflow against the
real mailbox.

## Pull requests (stacked, merge in order)

| # | Branch | Contents |
|---|---|---|
| 31 | `feat/email-audit` | Audit and architecture docs |
| 32 | `feat/email-foundation` | Migration, permissions, Email Settings API (SSRF/TLS), outcome classification |
| 33 | `feat/email-consent-templates` | Eligibility, suppression, public unsubscribe, templates, attachments |
| 34 | `feat/email-campaign-engine` | Campaigns API, audience, idempotent confirm, PostgreSQL-leased dispatcher, lead history |
| 35 | `feat/email-inbox-sync` | IMAP reply and bounce sync, reply notifications |
| 36 | `feat/email-web` | Web UI: Email account, campaigns, composer, report, eligibility, unsubscribe page |

## What is verified (automated)

| Area | Evidence |
|---|---|
| SSRF | Hostnames only; private, loopback, link-local, CGNAT, ULA and mapped addresses refused; connection pinned to the checked address (unit). Private hosts refused through the API (e2e). |
| TLS | Implicit TLS or required STARTTLS, TLS 1.2+, certificate verified against the hostname; a wrong-host certificate fails the test (e2e, real TLS). |
| Credentials | Password sealed (AES-256-GCM), never in responses, audit or IMAP logs (e2e). |
| Connection tests | SMTP: sign-in only, no mail. IMAP: `EXAMINE` (read-only), no mutating command (e2e). |
| Eligibility | Unknown = not eligible; grant needs basis + evidence; unsubscribed/complained can't be re-granted or unsuppressed (e2e). |
| Unsubscribe | Public; GET changes nothing; POST idempotent (RFC 8058 target); cancels queued mail for that person in that organization only (e2e). |
| Content | Server-side allow-list sanitising; escaped merge values; header-injection-proof subject; unknown fields refused (unit + e2e). |
| Delivery | One message per recipient, own Message-ID, one-address envelope, List-Unsubscribe headers (e2e, real SMTP). |
| Idempotency | Double-click confirm creates one set of recipients; second key refused; stale audience count refused (e2e). |
| Failures | 4xx retried with backoff; 5xx permanent with bounce suppression; lost answer during send = UNCERTAIN, never resent; expired lease recovered as UNCERTAIN (e2e). A nodemailer quirk that reported an in-flight timeout as a connect error was found by these tests and fixed by staging the conversation. |
| Concurrency | Two workers claiming simultaneously never share a recipient, and no claim exceeds its limit (`FOR UPDATE SKIP LOCKED` in a materialized CTE, e2e on real PostgreSQL). The earlier `UPDATE … WHERE id IN (SELECT … LIMIT n FOR UPDATE)` form claimed more than n rows on real PostgreSQL — caught in CI, fixed in #34. |
| Limits | Hourly/daily mailbox limits enforced (e2e). |
| Lead history | Every email: EMAIL_SENT (accepted, with server response) or EMAIL_FAILED (rejected/bounced/unknown); replies: EMAIL_REPLY_RECEIVED with text snippet (e2e). |
| Replies | Matched only by our Message-IDs; HTML never stored; restart-safe, no duplicates; UIDVALIDITY change handled; nothing attached for unrelated mail (e2e). |
| Tenancy | All new models tenant-scoped; raw claim SQL covered in tenant-isolation suite; cross-tenant reads/sends 404 (e2e). |

## Activation gates (all required, in order)

1. **Outbound SMTP from Railway.** Production Railway blocks SMTP (audit, commit `7ce46dc`).
   Owner decision: enable it for the workspace (Railway Pro), then verify ports 465/587 from the
   API container. Until then, test sends and campaigns cannot leave production.
2. **IMAP egress (993)** verified from the container.
3. **Deploy** with `EMAIL_DISPATCH_ENABLED=true` (dispatcher + inbox sync in the API process, or a
   small dedicated worker service with the same image) and `EMAIL_CAMPAIGNS_SENDING_ENABLED=false`.
4. **Connect** `sales@cravionventures.com` (IMAP/SMTP `mail.cravionventures.com`, 993/465 SSL/TLS);
   both connection tests pass.
5. **Test send** to an internal address arrives in the inbox (check spam folder and headers).
   Test sends need both `EMAIL_DISPATCH_ENABLED=true` and `EMAIL_CAMPAIGNS_SENDING_ENABLED=true`.
6. **Reply sync**: reply to the test campaign from an internal address; the reply appears on the
   lead history and in the campaign report.
7. **Unsubscribe** link and one-click header work from a real mail client.
8. **Consent**: eligibility recorded for the intended first audience; suppression list reviewed.
9. **Provider limits**: confirm HostingRaja's per-hour/day limit and set the mailbox limits below it.
10. **Owner approval**, then `EMAIL_CAMPAIGNS_SENDING_ENABLED=true`.

## Email provider configuration outstanding

| Item | Current | Needed |
|---|---|---|
| SPF | present, `~all`, includes server IP | OK for mail sent through `mail.cravionventures.com` |
| DKIM | `default._domainkey` present | Verify `DKIM=pass` on a real test message |
| DMARC | `p=none` | Keep `none` while verifying; move to `quarantine` after alignment is confirmed |
| Sending limits | unknown | Obtain from HostingRaja; configure below it |
| Railway SMTP | blocked | Owner decision (see gate 1) |

## Rollback

Set `EMAIL_DISPATCH_ENABLED=false` (stops all sending and syncing immediately; queued rows wait),
or pause/cancel campaigns. The migration is additive; the previous API ignores the new tables
while no email lead history exists. A schema rollback script
(`apps/api/prisma/rollbacks/20261111090000_email_campaigns.down.sql`) was tested on a restored,
sanitised production copy and restores the schema exactly; it refuses once email history exists. See
[LEADFLOW_RESEND_BROADCASTS.md](LEADFLOW_RESEND_BROADCASTS.md#migration-review).

## Rollout record — first production campaign (closed 2026-11-14)

Status: **completed**. Email sending is **off** again; the features stay live.

### Deployment history

| When (UTC) | What | Commit | Railway API deployment |
|---|---|---|---|
| 2026-11-12 | Email campaigns released dark (#31–#37) | `51dc8dc` | `868d4687` |
| 2026-11-13 | #41 settings toggle (Resend), footer | `3676e6f` | `d2d35572` |
| 2026-11-13 | #42 editor hooks fix, #43 custom recipient list, #48 test-send readiness | `7561c84` | `5fe57566` |
| 2026-11-13 | #49 test email to one server-approved address | `db61985` | `9712ae1b` |
| 2026-11-13 14:33 | Restricted activation for one recipient (switches only) | `db61985` | `b6ff41d0` |
| 2026-11-13 15:59 | Sending rolled back to off (switches only) | `db61985` | `2983b424` |
| 2026-11-13 16:35 | #51 manual eligibility entry, #50 single test control + real-send warning | `e905dcc` | `d894284b` |

### What happened

- 10:01 internal test (Outlook, `shvbhosale@outlook.com`): accepted by Resend, delayed by
  Outlook for ~3.5 h, delivered 13:34.
- Two Gmail test windows were refused (the wrong test button was used); nothing was sent.
  This led to #50.
- 14:36 first real Promotional campaign `01a1d277…` ("CRAVION – New Leads B2B Product
  Introduction – Nov 2026"), 1 recipient `shvbhosale@gmail.com` with recorded eligibility,
  sent as a Resend Broadcast (attachment removed first: broadcasts cannot carry attachments),
  `email.sent` 14:37, **delivered 15:32**. Campaign status COMPLETED.

### Completion checklist

- [x] Restricted activation used the exact allowlist + CRAVION organization only;
      `EMAIL_SENDING_UNRESTRICTED` never set.
- [x] Exactly one campaign recipient; eligibility recorded before sending; not suppressed.
- [x] Delivery confirmed by Resend webhook (`email.delivered`), deduplicated.
- [x] Rolled back: `EMAIL_DISPATCH_ENABLED`, `EMAIL_CAMPAIGNS_SENDING_ENABLED`,
      `EMAIL_RESEND_BROADCASTS_ENABLED` = `false`; allowlist back to the internal Outlook address.
- [x] No queued or scheduled campaigns; migration runner: no pending migrations.
- [x] Production `/health` 200; log "Email dispatcher disabled".
- [ ] Follow-ups still open: #44 (recipient-set fingerprint), #45 (selection/send audit
      completeness). Readiness centralisation is LeadFlow 2.0 PR C-1.

Reactivating sending requires explicit owner approval and the activation gates above.
