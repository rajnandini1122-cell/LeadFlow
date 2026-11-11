# LeadFlow — Resend Broadcasts for promotional campaigns

PR #37 (`feat/email-resend`), stacked on #31–#36. LeadFlow remains the source of truth for leads,
campaigns, eligibility and reporting; Resend is the delivery mechanism.

| Campaign | Mailbox provider | Delivery channel |
|---|---|---|
| Promotional | Resend | **RESEND_BROADCAST** — Resend Broadcasts (this document) |
| Service message (transactional) | Resend | RESEND_EMAIL — one `POST /emails` per recipient, idempotency key = recipient row |
| Any | SMTP | SMTP — one message per recipient through the mailbox (PR #34) |

The channel is fixed when the campaign is confirmed. Replies are always read from the HostingRaja
mailbox over IMAP (PR #35). Password-reset and other platform emails are untouched: they use
`EMAIL_PROVIDER`/`RESEND_API_KEY` in `common/email`, which campaigns never read or call.

## Switches (all default OFF)

| Variable | Meaning |
|---|---|
| `EMAIL_DISPATCH_ENABLED` | This process runs the dispatcher, broadcast state machine, inbox sync and reconciliation. |
| `EMAIL_CAMPAIGNS_SENDING_ENABLED` | Customer campaigns may be confirmed and sent at all. |
| `EMAIL_RESEND_BROADCASTS_ENABLED` | Promotional campaigns may use Resend Broadcasts. Requires the switch above. |

## Resend API — what this relies on

Checked against Resend's documentation on 2026-11-11.

| Fact | Source | Used for |
|---|---|---|
| Rate limit 10 requests/second per team | API reference, introduction | Sequential calls only |
| Free: 100 emails/day, 3,000/month (transactional); marketing up to 1,000 contacts/month | Account quotas and limits | Quotas below |
| Bounce rate must stay under 4% and spam rate under 0.08%, or sending may pause | Account quotas and limits | Separate marketing account |
| Contacts are team-wide, addressed by id **or email**; `GET/PATCH /contacts/{email}` | Contacts API | Sync, unsubscribe push |
| `unsubscribed` is global: an unsubscribed contact receives no broadcasts | Contacts API, managing unsubscribes | Never set to false by LeadFlow |
| `POST /contacts/{email}/segments/{segmentId}` adds to a segment | Add contact to segment | Segment build |
| `GET /contacts?segment_id=&limit=100&after=` lists a segment | List contacts | Exact-membership check |
| `POST /broadcasts` (draft unless `send:true`) with `segment_id, from, reply_to, subject, html, text, name` | Create broadcast | Draft |
| `POST /broadcasts/{id}/send` — **no idempotency key documented** | Send broadcast | The state machine |
| Broadcast status: `draft`, `scheduled`, `queued`, `sent`, `canceled`; sent/queued cannot be deleted; queued can be cancelled (stops undelivered emails only) | Manage broadcasts | Reconciliation, pause/cancel rules |
| `{{{contact.first_name}}}`, `{{{RESEND_UNSUBSCRIBE_URL}}}` placeholders | Create broadcast | Rendering |
| Webhooks are Svix-signed: HMAC-SHA256 over `id.timestamp.body`, key = base64 part of `whsec_…`, header `v1,<sig>` (space-separated list) | Verify webhooks; Svix manual verification | Verification |
| `email.*` events carry `broadcast_id`, `email_id` (Resend's id) and `message_id` (RFC Message-ID header) as **separate fields**; `message_id` absent on `email.failed/suppressed/scheduled` | `email.sent` / `email.bounced` payload examples | Correlation |
| `contact.updated` carries `email` and `unsubscribed` | `contact.updated` payload example | Unsubscribe sync |

**Not documented — treated as assumptions, verified in rollout stage 3 before any customer send:**

1. Removing a contact from a segment (`DELETE /contacts/{email}/segments/{id}` is assumed by symmetry).
   If refused, the precheck **fails closed**: the campaign pauses and nothing is sent.
2. Whether Resend adds `List-Unsubscribe` / one-click headers to broadcasts automatically.
3. Whether `{{{contact.first_name}}}` without a fallback renders empty for contacts with no name.
4. That a second `POST /broadcasts/{id}/send` on a non-draft broadcast is refused. LeadFlow does **not**
   rely on this; it never sends without first reading `draft`.

## The broadcast state machine

```
PENDING ─sync contacts─▶ CONTACTS_SYNCED ─segment─▶ SEGMENT_READY ─precheck+draft─▶ DRAFT_CREATED
   ─precheck, persist─▶ SEND_REQUESTED ─send─▶ HANDED_OFF ─events/48 h─▶ COMPLETED
```

* Every step is persisted before the provider call that follows it, with a conditional update on the
  state just read, so a restart resumes and two workers cannot take the same step.
* **SEND_REQUESTED is resolved only by reading the broadcast** (`GET /broadcasts/{id}`):
  `scheduled/queued/sent` → HANDED_OFF; `canceled` → paused; `draft` → the earlier request did not send,
  and after a 2-minute settle the precheck runs again and the send is requested once more; no answer →
  stay and read later. An error or a lost answer on the send call never triggers a blind retry.
* **Precheck, immediately before draft creation and before every send request:**
  1. push every outstanding LeadFlow unsubscribe to Resend (any failure → wait; nothing sent);
  2. re-evaluate each queued recipient against LeadFlow's consent and suppression records;
  3. read each contact at Resend — unsubscribed there → LeadFlow suppression; unreadable → wait;
  4. list the segment and make it **exactly** the eligible set (remove strangers, add missing);
     if it cannot be made exact → **BLOCKED** (campaign paused, nothing sent).
* After hand-off, `email.*` webhooks drive each recipient: `email.sent` → ACCEPTED (+ lead history,
  RFC Message-ID stored for IMAP reply matching, Resend `email_id` stored separately);
  `delivered`; `bounced` (Permanent) → FAILED + BOUNCED suppression; `complained` → COMPLAINT
  suppression + eligibility withdrawn; `failed`/`suppressed` → FAILED. Recipients with no event
  48 hours after hand-off are closed as "no report".
* **Pause/cancel** work until SEND_REQUESTED. After that LeadFlow refuses with an explanation:
  sent emails cannot be recalled; a queued broadcast can be cancelled in Resend.

## Unsubscribe synchronisation (fail closed, never resubscribe)

* `email_provider_contacts` is a permanent ledger of every address placed in the organization's Resend
  account. A database trigger refuses to delete rows or to clear an unsubscribe. Contacts are never
  deleted to save allowance.
* LeadFlow → Resend: any LeadFlow suppression whose ledger row is still subscribed at Resend is an
  outstanding push (found by comparing the tables, so no suppression path can forget to queue it).
  Pushes are `PATCH {unsubscribed:true}` only; a failed push stays pending and blocks every broadcast
  precheck until it succeeds.
* Resend → LeadFlow: `contact.updated` with `unsubscribed:true`, contacts read during sync/precheck, and
  a 10-minute reconciliation that lists unsubscribed contacts. Each becomes an UNSUBSCRIBED suppression
  with eligibility withdrawn and queued mail to that person skipped.
* LeadFlow never sends `unsubscribed:false` for an existing contact, never re-creates a contact that its
  ledger knows unsubscribed, and ignores `contact.updated` with `unsubscribed:false`.

## Security assessment

| Concern | Control |
|---|---|
| Tenant isolation | Each LeadFlow organization uses its own Resend account and key (sealed per mailbox). All new tables are tenant-scoped. Webhooks are verified with the mailbox's own secret, then processed inside that organization only; a broadcast id from another organization finds nothing (tested). |
| Full-access key | Stored AES-256-GCM sealed (`CREDENTIAL_ENCRYPTION_KEY`), write-only, opened only server-side immediately before use, never logged or returned. Reported access level must be `full` before broadcasts. |
| Transactional independence | Campaigns refuse the platform `RESEND_API_KEY`; the suite asserts every Resend request used the marketing key. Separate Resend account recommended so marketing reputation pauses cannot stop password resets. |
| Webhook forgery/replay | Svix HMAC over the raw body, constant-time comparison, ±5-minute timestamp window, unique event id per mailbox. |
| Credential rotation | New API key → provider must be re-tested before sending resumes. New webhook secret → the previous one is accepted for 24 hours. |
| Ambiguous sends | Never retried blindly (above). Single-email path uses Resend idempotency keys (24 h). |
| Content | Server-side HTML sanitising (PR #33); broadcasts can only personalise first/last name; no attachments. |

## Migration review

All schema is in the unmerged `20261111090000_email_campaigns` migration — no production migration
has been run. Additions for this PR are purely additive: provider columns on `email_mailboxes`
(including `api_key_access`, a rotated webhook secret), broadcast state on `email_campaigns`
(CHECK-constrained), `provider_message_id`/`delivered_at`/`complained_at` on recipients, `provider` on
attempts, and two tables: `email_provider_events` (unique per mailbox + event id) and
`email_provider_contacts` (permanent ledger, trigger-guarded). Verified by applying every migration to
an empty PostgreSQL 17 database in the e2e run and by `prisma migrate diff` (no new drift).

## Quotas and cost (Resend, published pricing)

* Marketing (broadcasts): Free up to 1,000 contacts/month, unlimited sends; Pro marketing $40/month
  for 5,000 contacts.
* Transactional (single emails, separate quota): Free 100/day, 3,000/month; Pro $20/month for 50,000.
* Current LeadFlow data: 78 lead and 77 contact addresses in one organization; 0 with recorded
  marketing eligibility. Free tiers suffice for the first campaigns.

## Manual setup required (not done; needs your approval)

1. **Resend marketing account** (separate team, e.g. `cravionventures`):
   * Domains → Add `news.cravionventures.com`. Resend shows the records to create (step 2).
   * API Keys → create a key named `LeadFlow marketing` with **Full access**. Enter it in LeadFlow →
     Settings → Email account → *How campaigns are sent* → Resend. Do not paste it into chat.
   * Settings → turn **open and click tracking off** for the domain.
   * Webhooks → add the URL shown in LeadFlow (`https://leadflow.cravionventures.com/api/v1/webhooks/email/resend/<mailbox id>`),
     events: all `email.*` and `contact.updated`. Copy the signing secret (`whsec_…`) into LeadFlow.
2. **DNS (HostingRaja cPanel → Zone Editor) for `news.cravionventures.com`** — copy the exact values from
   Resend's domain page; they have this shape:

   | Type | Name | Value |
   |---|---|---|
   | TXT | `resend._domainkey.news` | `p=…` (DKIM public key from Resend) |
   | MX | `send.news` | `feedback-smtp.<region>.amazonses.com`, priority 10 |
   | TXT | `send.news` | `v=spf1 include:amazonses.com ~all` |

   **Do not change DMARC** (`_dmarc.cravionventures.com`, currently `p=none`) until every legitimate
   sender (HostingRaja, Resend transactional, Resend marketing, MailChannels if used) is validated.

## Staged production rollout

1. **Deploy dark.** Merge #31–#37 in order; deploy with all three switches off. Migration-first, after a
   verified backup. Nothing sends.
2. **Configure.** Steps 1–2 above. In LeadFlow: save the account, test IMAP, choose Resend, test Resend
   (key = full, domain DKIM/return path found). Confirm transactional emails still arrive (password reset).
3. **Verify the assumptions** with `EMAIL_DISPATCH_ENABLED=true`, `EMAIL_CAMPAIGNS_SENDING_ENABLED=true`,
   `EMAIL_RESEND_BROADCASTS_ENABLED=true` and an audience of **internal test addresses only** (record
   eligibility for them alone): one broadcast; check the received message (From, Reply-To, headers incl.
   List-Unsubscribe, DKIM/SPF/DMARC pass, name rendering), the webhook payloads in LeadFlow (accepted,
   delivered, RFC Message-ID stored), a reply arriving on the lead via IMAP, and unsubscribe from the
   mail client and from the link — both appearing in LeadFlow and Resend. Then switch broadcasts off.
4. **Owner approval** to enable customer broadcasts, with the first audience's eligibility recorded and
   reviewed. Start small; watch bounce (<4%) and complaint (<0.08%) rates.
5. Later, after validating every sending source: consider DMARC `p=quarantine`.
