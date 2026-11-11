# LeadFlow — Resend Broadcasts for promotional campaigns

PR #37 (`feat/email-resend`), stacked on #31–#36. LeadFlow remains the source of truth for leads,
campaigns, eligibility and reporting; Resend is the delivery mechanism.

| Campaign                        | Mailbox provider | Delivery channel                                                                 |
| ------------------------------- | ---------------- | -------------------------------------------------------------------------------- |
| Promotional                     | Resend           | **RESEND_BROADCAST** — Resend Broadcasts (this document)                         |
| Service message (transactional) | Resend           | RESEND_EMAIL — one `POST /emails` per recipient, idempotency key = recipient row |
| Any                             | SMTP             | SMTP — one message per recipient through the mailbox (PR #34)                    |

The channel is fixed when the campaign is confirmed. Replies are always read from the HostingRaja
mailbox over IMAP (PR #35). Password-reset and other platform emails are untouched: they use
`EMAIL_PROVIDER`/`RESEND_API_KEY` in `common/email`, which campaigns never read or call.

## Switches (all default OFF)

| Variable                          | Meaning                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| `EMAIL_DISPATCH_ENABLED`          | This process runs the dispatcher, broadcast state machine, inbox sync and reconciliation. |
| `EMAIL_CAMPAIGNS_SENDING_ENABLED` | Customer campaigns may be confirmed and sent at all.                                      |
| `EMAIL_RESEND_BROADCASTS_ENABLED` | Promotional campaigns may use Resend Broadcasts. Requires the switch above.               |

## Resend API — what this relies on

Checked against Resend's documentation on 2026-11-11 (re-checked for the PR #37 review). "Doc" means
the published reference says so; nothing here has been exercised against the live API yet (see
_Live verification still required_).

| Fact                                                                                                                                               | Source                                                                                                                                                                                                                                                                     | Used for                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Rate limit 10 requests/second per team                                                                                                             | [API introduction](https://resend.com/docs/api-reference/introduction)                                                                                                                                                                                                     | Client spaces calls ≥110 ms; a 429 is a failed step (retried, then NEEDS_REVIEW) |
| Free: 100 emails/day, 3,000/month (transactional); marketing up to 1,000 contacts/month                                                            | [Quotas and limits](https://resend.com/docs/knowledge-base/account-quotas-and-limits)                                                                                                                                                                                      | Quotas below                                                                     |
| Bounce rate must stay under 4% and spam rate under 0.08%, or sending may pause                                                                     | [Quotas and limits](https://resend.com/docs/knowledge-base/account-quotas-and-limits)                                                                                                                                                                                      | Separate marketing account                                                       |
| Contacts are team-wide, addressed by id **or email**                                                                                               | [Get contact](https://resend.com/docs/api-reference/contacts/get-contact), [Update contact](https://resend.com/docs/api-reference/contacts/update-contact), [Create contact](https://resend.com/docs/api-reference/contacts/create-contact)                                | Sync, unsubscribe push                                                           |
| `unsubscribed` is global: an unsubscribed contact receives no broadcasts                                                                           | [Managing unsubscribes](https://resend.com/docs/dashboard/contacts/managing-unsubscribe-list)                                                                                                                                                                              | Never set to false by LeadFlow                                                   |
| `POST /contacts/{id\|email}/segments/{segmentId}` adds to a segment                                                                                | [Add contact to segment](https://resend.com/docs/api-reference/contacts/add-contact-to-segment)                                                                                                                                                                            | Segment build, precheck                                                          |
| `DELETE /contacts/{id\|email}/segments/{segmentId}` removes; answers `{object:"contact_segment", id, deleted:true}`                                | [Delete contact segment](https://resend.com/docs/api-reference/contacts/delete-contact-segment)                                                                                                                                                                            | Precheck (404 = not a member = done)                                             |
| `GET /contacts/{id\|email}/segments?limit=&after=` lists one contact's segments (`has_more`, cursor = last id, limit ≤100)                         | [List contact segments](https://resend.com/docs/api-reference/contacts/list-contact-segments)                                                                                                                                                                              | **Per-contact membership verification**                                          |
| `GET /contacts?segment_id=&limit=100&after=` lists a segment; **no consistency or ordering guarantee documented**                                  | [List contacts](https://resend.com/docs/api-reference/contacts/list-contacts)                                                                                                                                                                                              | Only to find strangers, never as proof of membership                             |
| `POST /broadcasts` (draft unless `send:true`) with `segment_id, from, reply_to, subject, html, text, name`                                         | [Create broadcast](https://resend.com/docs/api-reference/broadcasts/create-broadcast)                                                                                                                                                                                      | Draft                                                                            |
| `POST /broadcasts/{id}/send` — **no idempotency key documented**                                                                                   | [Send broadcast](https://resend.com/docs/api-reference/broadcasts/send-broadcast)                                                                                                                                                                                          | The state machine                                                                |
| `GET /broadcasts/{id}` status: `draft`, `scheduled`, `queued`, `sent`, `canceled`                                                                  | [Get broadcast](https://resend.com/docs/api-reference/broadcasts/get-broadcast), [Manage broadcasts](https://resend.com/docs/dashboard/broadcasts/manage-broadcasts)                                                                                                       | Resolution by reading                                                            |
| `POST /broadcasts/{id}/cancel` — queued or scheduled only; **queued → `canceled`** (emails already sent are not recalled), **scheduled → `draft`** | [Cancel broadcast](https://resend.com/docs/api-reference/broadcasts/cancel-broadcast), [How do I cancel a broadcast](https://resend.com/docs/knowledge-base/how-do-i-cancel-a-broadcast)                                                                                   | Cancel after hand-off                                                            |
| `{{{contact.first_name\|fallback}}}` placeholders; `{{{RESEND_UNSUBSCRIBE_URL}}}` is unique per contact and broadcast                              | [Broadcast editor](https://resend.com/docs/dashboard/broadcasts/editor), [Contact properties](https://resend.com/docs/dashboard/contacts/properties), [Unsubscribe page](https://resend.com/docs/dashboard/settings/unsubscribe-page)                                      | Rendering                                                                        |
| Webhooks are Svix-signed: HMAC-SHA256 over `id.timestamp.body`, key = base64 part of `whsec_…`, header `v1,<sig>` (space-separated list)           | [Verify webhooks](https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests)                                                                                                                                                                                     | Verification                                                                     |
| `email.*` events carry `broadcast_id`, `email_id` (Resend's id) and `message_id` (RFC Message-ID header) as **separate fields**                    | [email.sent](https://resend.com/docs/webhooks/emails/sent), [email.delivered](https://resend.com/docs/webhooks/emails/delivered), [email.bounced](https://resend.com/docs/webhooks/emails/bounced), [email.complained](https://resend.com/docs/webhooks/emails/complained) | Correlation                                                                      |
| `contact.updated` carries `email` and `unsubscribed`                                                                                               | [contact.updated](https://resend.com/docs/webhooks/contacts/updated)                                                                                                                                                                                                       | Unsubscribe sync                                                                 |

## Live verification still required (rollout stage 3, internal addresses only)

These cannot be settled from documentation. None of them can cause an unwanted send; each is
checked against the live API with internal test addresses before any customer broadcast.

| #   | Question                                                                                                                                                                               | What LeadFlow does meanwhile                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | Real `email.sent` payload for a **broadcast**: are `broadcast_id`, `email_id` and `message_id` all present, and is `message_id` the exact `Message-ID` header of the received message? | Correlates by `broadcast_id` + address first; adopts `message_id` only if it has the `<…>` header form. IMAP reply matching uses it, so verify by replying to the test message. |
| L2  | Does Resend add `List-Unsubscribe` / `List-Unsubscribe-Post` (RFC 8058 one-click) to broadcasts?                                                                                       | The footer always carries `{{{RESEND_UNSUBSCRIBE_URL}}}`. Check the received headers.                                                                                           |
| L3  | Does a click on the unsubscribe link (and a one-click POST, if present) fire `contact.updated` with `unsubscribed:true`?                                                               | The 10-minute reconciliation also pulls unsubscribed contacts, so a missing webhook is caught.                                                                                  |
| L4  | `{{{contact.first_name}}}` with no fallback, for a contact without a name: empty or literal?                                                                                           | Every LeadFlow-synced contact gets a first name (display name fallback). Test with one unnamed contact.                                                                         |
| L5  | Is a second `POST /broadcasts/{id}/send` on a non-draft broadcast refused?                                                                                                             | Not relied on: LeadFlow sends only after reading `draft`, and never twice on its own.                                                                                           |
| L6  | Do membership changes show in `GET /contacts/{email}/segments` immediately?                                                                                                            | Not relied on: any correction forces another verification pass before sending.                                                                                                  |

## The broadcast state machine

```
PENDING ─sync contacts─▶ CONTACTS_SYNCED ─segment─▶ SEGMENT_READY ─precheck+draft─▶ DRAFT_CREATED
   ─precheck, persist─▶ SEND_REQUESTED ─send─▶ HANDED_OFF ─events/48 h─▶ COMPLETED
                             │                    └─cancel at Resend─▶ CANCELLED_AT_PROVIDER
                             └─still draft / unreadable 15 min─▶ NEEDS_REVIEW ─person─▶ (see table)
any step failing for 15 min ─▶ NEEDS_REVIEW
```

- Every step is persisted before the provider call that follows it, with a conditional update on the
  state just read, so a restart resumes and two workers cannot take the same step.
- **SEND_REQUESTED is resolved only by reading the broadcast** (`GET /broadcasts/{id}`):
  `scheduled/queued/sent` → HANDED_OFF; `canceled` → CANCELLED_AT_PROVIDER, paused; no answer → stay
  and read again. **`draft` after the 2-minute settle → NEEDS_REVIEW.** LeadFlow never asks Resend to
  send a broadcast a second time on its own: an error or a lost answer on the send call is resolved
  by reading, and a broadcast that still reads `draft` waits for a person.
- **Any step that keeps failing** (Resend unreadable, a contact or membership that cannot be verified,
  a removal refused, an unsubscribe that cannot be pushed) is retried every tick. The first failure
  is stamped in `broadcast_retry_since`; after **15 minutes** the campaign moves to **NEEDS_REVIEW**
  (paused, reason shown). Any successful step clears the stamp.
- **NEEDS_REVIEW is left only by a person** — `POST /api/v1/email/campaigns/{id}/broadcast/resolve`
  `{action: "retry" | "abandon", reason, expectedVersion}` (permission `campaign.send`: organisation
  owners and administrators only). Resume and Cancel are refused while in NEEDS_REVIEW. The live status
  is read first and always wins:
  | Live status | `retry` | `abandon` |
  |---|---|---|
  | `queued` / `scheduled` / `sent` | recorded as HANDED_OFF — **never sent again** | same |
  | `canceled` | campaign cancelled; recipients UNCERTAIN | same |
  | `draft` | back to DRAFT_CREATED: precheck, then **one** send request | campaign cancelled; recipients CANCELLED |
  | no broadcast yet | back to PENDING (every step is idempotent) | campaign cancelled; recipients CANCELLED |
  | unreadable | **refused (409), nothing changed** | campaign cancelled; recipients **UNCERTAIN** if a send was ever requested |
- **Recovery panel** (campaign page → _Resend broadcast_): shows the state, the last status check
  with Resend and what it said, the failure reason, the Resend broadcast id, when a send was requested
  and whether anyone may already have the email (_not sent_ / _may have been sent_ / _handed to
  Resend_). Administrators get **Recheck & retry if safe** and **Abandon campaign**; each opens a
  confirmation listing the actual consequences and requires a reason. The panel only calls the
  endpoint above — there is no second recovery path.
- **Concurrency and stale pages:** every broadcast state change bumps `broadcast_version`. A decision
  carries the version the person saw, and the server first _claims_ the review with a conditional
  update on (NEEDS_REVIEW, PAUSED, that version). A second operator, a page refreshed by someone
  else's decision, or a repeated click finds the version moved and gets 409 before Resend is
  called. The dialog also disables Confirm while a request is in flight and when the 10-second refresh
  shows a newer version.
- **Audit trail:** every attempt — decided or refused — writes a row to `email_broadcast_reviews`
  (actor, time, action, reason, outcome, refusal text, state and status before and after, the
  Resend status read, recipients closed) and an audit-log entry (`email.campaign.broadcast_resolved`
  or `…_resolve_refused`). A database trigger refuses UPDATE and any direct DELETE (only a cascade
  from deleting the organization removes them). Requests stopped by authentication, permission (403)
  or tenant isolation (404) never reach the service and are not written there.
- **Precheck, immediately before draft creation and before every send request:**
  1. push every outstanding LeadFlow unsubscribe to Resend (any failure → wait; nothing sent);
  2. re-evaluate each queued recipient against LeadFlow's consent and suppression records;
  3. read each contact at Resend — unsubscribed there → LeadFlow suppression; unreadable → wait;
  4. **verify membership contact by contact** (`GET /contacts/{email}/segments`, all pages) for every
     address in the campaign: add the eligible ones missing, remove (`DELETE`) the ones no longer
     eligible;
  5. list the segment (all pages, de-duplicated) only to find **strangers**, and remove them;
  6. if anything was corrected, **do not send on this pass**: the next tick verifies again from
     scratch. A send request follows only a pass that found nothing to fix. A mismatch or failure that
     persists for 15 minutes → NEEDS_REVIEW. A partial listing is never treated as complete: a failed
     page fails the whole read.
- After hand-off, `email.*` webhooks drive each recipient: `email.sent` → ACCEPTED (+ lead history,
  RFC Message-ID stored for IMAP reply matching, Resend `email_id` stored separately);
  `delivered`; `bounced` (Permanent) → FAILED + BOUNCED suppression; `complained` → COMPLAINT
  suppression + eligibility withdrawn; `failed`/`suppressed` → FAILED. Recipients with no event
  48 hours after hand-off are closed as "no report".
- **Pause** works until SEND_REQUESTED; after that it is refused (pausing cannot stop Resend).
- **Cancel after hand-off** uses Resend's Cancel API. LeadFlow reads the status, then:
  `sent` → refused, "sent emails cannot be recalled" (nothing is called); `queued`/`scheduled` →
  `POST /broadcasts/{id}/cancel`, then **reads again** — only a confirmed `canceled`/`draft` cancels the
  campaign (state CANCELLED_AT_PROVIDER). A refused or unconfirmed cancel changes nothing in LeadFlow.
  After a queued broadcast is cancelled, open recipients become **UNCERTAIN** ("emails Resend had already
  sent cannot be recalled"), never "cancelled"; a later `email.sent` for one of them still marks it
  ACCEPTED and writes lead history. LeadFlow never claims a sent message was recalled.

## Unsubscribe synchronisation (fail closed, never resubscribe)

- `email_provider_contacts` is a permanent ledger of every address placed in the organization's Resend
  account. A database trigger refuses to delete rows or to clear an unsubscribe. Contacts are never
  deleted to save allowance.
- LeadFlow → Resend: any LeadFlow suppression whose ledger row is still subscribed at Resend is an
  outstanding push (found by comparing the tables, so no suppression path can forget to queue it).
  Pushes are `PATCH {unsubscribed:true}` only; a failed push stays pending and blocks every broadcast
  precheck until it succeeds.
- Resend → LeadFlow: `contact.updated` with `unsubscribed:true`, contacts read during sync/precheck, and
  a 10-minute reconciliation that lists unsubscribed contacts. Each becomes an UNSUBSCRIBED suppression
  with eligibility withdrawn and queued mail to that person skipped.
- LeadFlow never sends `unsubscribed:false` for an existing contact, never re-creates a contact that its
  ledger knows unsubscribed, and ignores `contact.updated` with `unsubscribed:false`.

## Security assessment

| Concern                    | Control                                                                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tenant isolation           | Each LeadFlow organization uses its own Resend account and key (sealed per mailbox). All new tables are tenant-scoped. Webhooks are verified with the mailbox's own secret, then processed inside that organization only; a broadcast id from another organization finds nothing (tested). |
| Full-access key            | Stored AES-256-GCM sealed (`CREDENTIAL_ENCRYPTION_KEY`), write-only, opened only server-side immediately before use, never logged or returned. Reported access level must be `full` before broadcasts.                                                                                     |
| Transactional independence | Campaigns refuse the platform `RESEND_API_KEY`; the suite asserts every Resend request used the marketing key. Separate Resend account recommended so marketing reputation pauses cannot stop password resets.                                                                             |
| Webhook forgery/replay     | Svix HMAC over the raw body, constant-time comparison, ±5-minute timestamp window, unique event id per mailbox.                                                                                                                                                                            |
| Credential rotation        | New API key → provider must be re-tested before sending resumes. New webhook secret → the previous one is accepted for 24 hours.                                                                                                                                                           |
| Ambiguous sends            | Never retried automatically: resolved by reading, else NEEDS_REVIEW and an audited human decision that re-reads the live status first. Single-email path uses Resend idempotency keys (24 h).                                                                                              |
| Content                    | Server-side HTML sanitising (PR #33); broadcasts can only personalise first/last name; no attachments.                                                                                                                                                                                     |

## Migration review

All schema is in the unmerged `20261111090000_email_campaigns` migration — no production migration
has been run. It creates only new types, tables, indexes, triggers and functions, adds four values to
two existing enums (`activity_type`: EMAIL_SENT, EMAIL_FAILED, EMAIL_REPLY_RECEIVED;
`notification_type`: EMAIL_REPLY_RECEIVED), and **writes no rows** (no INSERT/UPDATE/DELETE). No
existing table or column is altered.

Rollback: [`apps/api/prisma/rollbacks/20261111090000_email_campaigns.down.sql`](../../apps/api/prisma/rollbacks/20261111090000_email_campaigns.down.sql)
drops every email object, rebuilds the two enums without the new values, and forgets the migration.
It **refuses** (and changes nothing) once lead history holds email entries or email notifications
exist: from then on a rollback is a data decision for the owner.

**Compatibility risk to plan for:** the previous API image works against the migrated database while
no email activity exists (verified: extra enum values and new tables are invisible to it). Once a
campaign has written EMAIL\_\* lead history, the previous image's Prisma client would fail reading
those history rows. Roll back the image only before activation, or roll forward.

### Migration and rollback test — restored, sanitised production copy (2026-11-11)

Local PostgreSQL 17 (127.0.0.1:55433), database `e2e_prodlike`. Production was not touched.

1. Restored `jumvo_PRODUCTION_20261109_224425_pre-pricing.dump` (verified backup) with `pg_restore`.
2. Sanitised every personal field (names, emails, phones, addresses, notes, message bodies, audit
   payloads, tokens, sessions) to deterministic placeholders, keeping counts and NULL-ness.
3. Applied `main`'s migrations (pricing), so the copy matched production's current schema.
4. Baseline: `pg_dump --schema-only` and row counts of all 55 existing tables (2,277 rows; 143 leads,
   78 with an email).

| Step                                      | Result                                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `prisma migrate deploy` (branch)          | Applied `20261111090000_email_campaigns` in 5.7 s; `migrate status`: up to date                      |
| Existing data                             | Row counts identical in all 55 existing tables                                                       |
| Existing schema                           | Only change to pre-existing objects: the 4 enum values appended                                      |
| New tables                                | All 12 email tables empty                                                                            |
| Eligibility                               | 0 marketing consents; **78 lead emails → 0 eligible**                                                |
| Drift (`prisma migrate diff` DB → schema) | 30 lines, **identical with and without the migration** (pre-existing production drift; none added)   |
| Rollback script                           | Applied; `pg_dump --schema-only` **identical to the baseline**; row counts identical                 |
| Re-apply after rollback                   | Applied again; schema identical to the first application                                             |
| Rollback with an EMAIL_SENT history row   | Refused: "rollback refused: lead history contains email activity"; all 12 email tables still present |

## Marketing eligibility — nobody is added without a record

- The only code that sets an address **eligible** is `ConsentRepository.grant`
  ([consent.repository.ts](../../apps/api/src/modules/campaigns/consent/consent.repository.ts)), called only
  from `POST /api/v1/email/eligibility/grant` (permission `marketing.consent.manage`), which takes an
  explicit list of addresses, requires a basis (`CONSENT`, `EXISTING_CUSTOMER` or
  `LEGITIMATE_INTEREST_REVIEWED`) and a note, refuses unsubscribed/complained addresses, and writes an
  audit record. There is no bulk "all leads" grant, no import path and no migration backfill. Every
  other write to `marketing_consents` sets WITHDRAWN.
- A campaign's audience is evaluated at confirmation, and again by the precheck immediately before each
  send: an address without a GRANTED record, or with a suppression, is skipped and never sent to Resend.
- Evidence: on the production copy above, 78 lead emails → 0 eligible. In the e2e suite, "nobody
  without recorded eligibility is ever sent to Resend" (two leads without a grant never appear in any
  Resend request) and "rechecks eligibility immediately before sending".
- The 78 existing leads therefore stay excluded until someone records eligibility for each address.

## Quotas and cost (Resend, published pricing)

- Marketing (broadcasts): Free up to 1,000 contacts/month, unlimited sends; Pro marketing $40/month
  for 5,000 contacts.
- Transactional (single emails, separate quota): Free 100/day, 3,000/month; Pro $20/month for 50,000.
- Current LeadFlow data: 78 lead and 77 contact addresses in one organization; 0 with recorded
  marketing eligibility. Free tiers suffice for the first campaigns.

## Manual setup required (not done; needs your approval)

1. **Resend marketing account** (separate team, e.g. `cravionventures`):
   - Domains → Add `news.cravionventures.com`. Resend shows the records to create (step 2).
   - API Keys → create a key named `LeadFlow marketing` with **Full access**. Enter it in LeadFlow →
     Settings → Email account → _How campaigns are sent_ → Resend. Do not paste it into chat.
   - Settings → turn **open and click tracking off** for the domain.
   - Webhooks → add the URL shown in LeadFlow (`https://leadflow.cravionventures.com/api/v1/webhooks/email/resend/<mailbox id>`),
     events: all `email.*` and `contact.updated`. Copy the signing secret (`whsec_…`) into LeadFlow.
2. **DNS (HostingRaja cPanel → Zone Editor) for `news.cravionventures.com`** — copy the exact values from
   Resend's domain page; they have this shape:

   | Type | Name                     | Value                                               |
   | ---- | ------------------------ | --------------------------------------------------- |
   | TXT  | `resend._domainkey.news` | `p=…` (DKIM public key from Resend)                 |
   | MX   | `send.news`              | `feedback-smtp.<region>.amazonses.com`, priority 10 |
   | TXT  | `send.news`              | `v=spf1 include:amazonses.com ~all`                 |

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
