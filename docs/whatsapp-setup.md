# WhatsApp Cloud API — setup and operation

LeadFlow receives WhatsApp messages, matches them to contacts and leads, shows
them in the inbox, and — within WhatsApp's 24-hour customer service window —
sends text replies back. Templates, media and automated replies are not
implemented; see section 9.

Every value in this document is a placeholder. Do not commit real credentials,
and do not paste an access token into a ticket, a chat message or a log.

---

## 1. What you need from Meta

One Meta app serves the whole deployment; each tenant connects their own phone
number to it.

| Thing | Where it comes from | Scope |
|---|---|---|
| App Secret | App dashboard → Settings → Basic | The whole deployment |
| Verify token | You invent it | The whole deployment |
| Phone number ID | WhatsApp → API Setup | Per tenant |
| WhatsApp Business Account ID | WhatsApp → API Setup | Per tenant — **required for templates** |
| Permanent access token | System user with `whatsapp_business_messaging` | Per tenant |

A temporary 24-hour token from the API Setup page is fine for a first test. It
will expire, the integration will move to `ERROR`, and it will need replacing —
use a system user token for anything lasting.

**Two token permissions, not one.** `whatsapp_business_messaging` sends
messages. Reading the template list additionally needs
`whatsapp_business_management`. A token with only the first connects and sends
perfectly well and then fails on **Refresh templates** with a permission error —
which is the most common template setup problem, and the reason the error names
the scope.

---

## 2. Environment variables

```bash
# Meta app secret. Every webhook body is HMAC-signed with it.
WHATSAPP_APP_SECRET=<from the Meta app dashboard>

# Any long random string. The SAME value goes into Meta's webhook setup.
WHATSAPP_VERIFY_TOKEN=<openssl rand -hex 32>

# Graph API version. Bump when Meta deprecates one; nothing else changes.
WHATSAPP_API_VERSION=v21.0

# Encrypts tenant access tokens at rest. 32 bytes, base64.
CREDENTIAL_ENCRYPTION_KEY=<openssl rand -base64 32>
```

**`WHATSAPP_APP_SECRET` is required for the webhook to accept anything.** With
it unset, every delivery is rejected — deliberately. An endpoint that waves
requests through because it was misconfigured is worse than one that is down.

**Losing `CREDENTIAL_ENCRYPTION_KEY` means stored tokens cannot be decrypted.**
They are not recoverable; each tenant re-enters theirs. Back it up with your
other deployment secrets, and rotate it only with a plan for re-encrypting
existing rows.

---

## 3. Webhook URL

```
https://<your-api-host>/api/v1/webhooks/whatsapp
```

Must be publicly reachable over HTTPS. Meta will not deliver to a private
host or a self-signed certificate.

In the Meta app: **WhatsApp → Configuration → Webhook → Edit**, paste the URL
and your verify token, then subscribe to the **`messages`** field. Nothing else
is read; other fields are ignored safely.

Meta immediately performs a `GET` with `hub.mode`, `hub.verify_token` and
`hub.challenge`. LeadFlow echoes the challenge only when the token matches
exactly, and returns a bare `403` otherwise.

---

## 4. Connecting a tenant

In LeadFlow, as an owner or administrator: **Settings → Channels → WhatsApp →
Connect**. Enter the phone number ID, optionally the business account ID, and a
permanent access token.

What happens then:

1. The token is encrypted (AES-256-GCM) and stored; the integration is saved as
   `CONNECTING`.
2. LeadFlow calls the Graph API to read that phone number back.
3. Success → `CONNECTED`. Failure → `ERROR`, with a short non-secret reason.

**`CONNECTED` is never written without a successful call to Meta.** An owner who
believes their number is live stops watching their phone; the state has to mean
what it says.

A phone number ID can belong to only one LeadFlow organization, enforced by a
global unique constraint. Attempting to connect one that is already claimed
returns `409` without revealing who holds it.

---

## 5. Local development

Meta cannot reach `localhost`. Use a tunnel:

```bash
cloudflared tunnel --url http://localhost:3000
# or: ngrok http 3000
```

Register the tunnel URL as the webhook, with the same verify token as your
`.env`.

To exercise the pipeline without Meta at all, sign a payload yourself:

```bash
BODY='{"object":"whatsapp_business_account","entry":[...]}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WHATSAPP_APP_SECRET" | awk '{print $2}')

curl -X POST http://localhost:3000/api/v1/webhooks/whatsapp \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: sha256=$SIG" \
  --data-raw "$BODY"
```

The signature covers the exact bytes sent, so `--data-raw` matters — anything
that re-encodes the JSON produces a different HMAC and a legitimate `403`.

`apps/api/test/whatsapp-webhook.e2e-spec.ts` contains realistic payloads.

---

## 6. Production checklist

- [ ] `WHATSAPP_APP_SECRET` set from the Meta app, not a placeholder
- [ ] `WHATSAPP_VERIFY_TOKEN` matches what is configured at Meta
- [ ] `CREDENTIAL_ENCRYPTION_KEY` set, backed up, and not in Git
- [ ] Webhook URL is HTTPS with a valid certificate
- [ ] `messages` field subscribed
- [ ] The app has `whatsapp_business_messaging` permission
- [ ] Access tokens are system user tokens, not 24-hour test tokens
- [ ] Business verification complete (Meta requires it for production)

---

## 7. What happens to a message

```
Meta → POST /api/v1/webhooks/whatsapp
  ↓ HMAC-SHA256 over the raw body           reject → 403, nothing written
  ↓ parse (batches, mixed events)           unreadable events counted, others continue
  ↓ phone_number_id → integration           unknown → 200, no tenant chosen
  ↓ enabled? status CONNECTED?              no → 200, nothing written
  ↓ existing ingestion service              ← everything below predates WhatsApp
  ↓ identity resolution, lead matching
  ↓ inbox / review queue / lead timeline
```

Processing is synchronous. There is no queue in this deployment, and adding one
for a handler that runs a few indexed queries would be infrastructure to operate
for no current benefit. Every step is idempotent, so Meta's retries are safe.

**Idempotency** is a unique index on `(organization_id, channel,
external_message_id)`. Meta redelivers on any non-2xx and sometimes without
cause; the second delivery of a message is a no-op, not a duplicate.

**Ordering** uses the provider's `sent_at`, not insertion order. A late-arriving
message appears where it belongs in the conversation.

---

## 8. Diagnosing

| Symptom | Cause |
|---|---|
| Meta cannot verify the URL | Verify token mismatch, or the URL is not reachable |
| Every delivery returns 403 | `WHATSAPP_APP_SECRET` unset or wrong |
| 200 but nothing appears | Number not connected, integration disabled, or status is not `CONNECTED` |
| Integration flips to `ERROR` | Token expired or was revoked — replace it |
| Messages appear under no lead | Working as intended: an unrecognised number goes to the review queue |

Logs record the integration id, the organization id, the provider message id
and an error category. They never record access tokens, the app secret, the
verify token, authorization headers or message bodies.

---

## 9. Sending replies

Added in Phase E2. Inbound and outbound share one conversation, one message
table and one lead — there is no separate outbound store.

### When a reply is possible

The API calculates it; the UI renders a composer only when told to. All of it
is answered from the database, so opening a conversation never waits on Meta:

| Condition | Otherwise |
|---|---|
| Channel is WhatsApp | Instagram and Facebook stay read-only |
| Caller holds `lead.update` and can see the conversation | "You do not have permission to reply" |
| Integration exists, `CONNECTED`, enabled | Points at settings |
| Customer wrote within the last 24 hours | Explains the template requirement |

A second, **separate** answer sits alongside it: `canSendTemplate`, with
`templateDisabledReason`. It is not a fallback for `canSend` — see §10.

**The 24-hour customer service window** is WhatsApp's rule, not ours. Free-form
replies are permitted only within 24 hours of the customer's most recent
message; after that Meta requires an approved template. The window is computed
from the last inbound message and the composer disappears when it closes.

Since Phase K an approved template **can** be sent once it closes — see §10. The
free-form rule itself is unchanged: `canSend` is still false, and a typed
message is still refused.

### Sending

```
POST /api/v1/conversations/:id/messages
{ "content": "…", "idempotencyKey": "<uuid>" }
```

Text only. Maximum 4096 characters, matching Meta's limit.

### Idempotency, and the tradeoff

The message row is written **before** Meta is called, carrying the client's
idempotency key under a unique index. A repeated request finds that row and
returns it rather than sending again — which holds across application instances,
because the guarantee lives in the database rather than in memory.

This ordering is deliberate. If the process dies between Meta accepting a
message and us recording it, the claim still exists and the retry stops. The
cost is a row that may say `FAILED` for a message the customer actually
received; the alternative cost is sending a second copy. **A duplicate reaches
the customer. A stale status only reaches the salesperson**, who can see the
conversation and check.

The client generates one key per composed message and reuses it on retry,
regenerating only after a success.

### Statuses

`PENDING → SENT → DELIVERED → READ`, with `FAILED` reachable from `PENDING` or
`SENT`. Nothing ever moves backwards: Meta gives no ordering guarantee, and a
late `delivered` after a `read` is ignored rather than applied. `FAILED` cannot
overwrite `DELIVERED` or `READ` — the customer demonstrably received those.

Status events arrive on the same webhook as inbound messages, get the same
signature check and the same tenant resolution, and only ever update an existing
outbound message. They never create a message, a conversation or a lead.

### Failures

Meta's error bodies echo request parameters and can contain the token, so none
of them reach the user. Failures are translated into one sentence someone can
act on, and the detail stays in the server log as a status and an error code.

A failure the provider explicitly rejected is a `409`. An **uncertain** one — a
timeout, or an acceptance with no message id — is a `502`, and the message row
is kept on purpose: it is the only thing telling the salesperson to check the
conversation before resending.

Nothing retries automatically. An automatic retry after an uncertain failure is
how a customer receives the same message twice.

### Not in this phase

Interactive messages, reactions, typing indicators, read receipts sent by us,
and any form of automated or AI reply. (Media arrived in Phase J and templates
in Phase K.)

### Stale sends, and why they are not retried

Writing the row before calling Meta protects against duplicates, but it leaves
one gap: if the process dies mid-send, nothing ever comes back to close the row.
Without a sweep it would read "Sending…" forever.

A background pass finalises any outbound message still `PENDING` after
`OUTBOUND_RECOVERY_AFTER_SECONDS` (default **120**). The provider call times out
at 15 seconds, so anything still pending two minutes later belongs to a process
that is no longer running — comfortably past any slow-but-alive send, short
enough that nobody watches a spinner for long.

It runs once at startup — the likeliest reason a row is stranded is that this
process's predecessor died holding it — and then every
`OUTBOUND_RECOVERY_INTERVAL_SECONDS`. No queue, no scheduler, no new
infrastructure. Set `OUTBOUND_RECOVERY_ENABLED=false` to turn it off.

**It never resends.** After a crash we do not know whether Meta accepted the
message, so resending would be a guess whose failure mode is a customer
receiving the same message twice. The row becomes:

```
UNCONFIRMED — "Delivery could not be confirmed, and the message was not
               resent automatically. Check WhatsApp before sending it again."
```

`UNCONFIRMED` is **not** `FAILED`, and the two are shown differently. `FAILED`
means the customer did not get it, and someone reading that will quite
reasonably send it again. `UNCONFIRMED` means nobody knows.

Safety comes from a single conditional `UPDATE` matching only `PENDING` rows
older than the cutoff. Instances sweeping simultaneously converge on the same
state, and since nothing here talks to a provider, a race cannot produce a
message. `SENT`, `DELIVERED`, `READ` and `FAILED` are never touched; neither is
a lead, a conversation or an owner.

Replaying the original request afterwards returns the `UNCONFIRMED` attempt
rather than sending again — the idempotency key outlives recovery.

**A known limitation:** a message reaches `UNCONFIRMED` precisely because its
provider id was never stored, so a later status webhook has nothing to match on.
Such a message stays `UNCONFIRMED` permanently. Matching it by phone number,
content or timestamp would be a guess, and a wrong guess would attach one
customer's delivery receipt to another's message. The status ladder does allow a
real provider answer to supersede `UNCONFIRMED` if one ever arrives.

There is no resend button. A human-controlled resend, with a fresh idempotency
key, is deliberately left to a later phase.

---

## 10. Message templates

Added in Phase K. A template is the only message WhatsApp will deliver once the
24-hour customer service window has closed.

### LeadFlow does not create or approve templates

This is the whole shape of the feature. Templates are written and submitted in
**Meta** — WhatsApp Manager → Message templates — and Meta approves or rejects
them, usually within a few minutes to a day. LeadFlow only ever **reads** that
list. There is no endpoint that creates a template, and no way to mark one
approved locally; `status` on every row is a copy of Meta's answer.

A status LeadFlow does not recognise is stored as `DISABLED`, not as approved.
Failing closed is deliberate: an unknown value must never become permission to
message a customer.

### Loading them

Settings → Channel integrations → WhatsApp → **Refresh templates**.

```
POST /api/v1/channel-integrations/whatsapp/templates/sync   # org.update
GET  /api/v1/channel-integrations/whatsapp/templates        # org.view
```

Sync calls `GET /{whatsapp-business-account-id}/message_templates`, replaces the
cached list and deletes anything Meta no longer returns. The list is **cached,
not fetched live** — otherwise every conversation opened would cost a provider
call, and a Meta outage would take replying down rather than serving a slightly
stale list.

Sync is explicit and manual. Nothing polls Meta.

Reading the list needs `org.view`, which every role including SALES_REP holds:
choosing a template is the ordinary case. Refreshing needs `org.update`, because
it spends the organization's credential.

### Which templates can actually be sent

Both must be true:

| | |
|---|---|
| `status` is `APPROVED` | Meta refuses anything else outright |
| `supported` is `true` | LeadFlow can render it correctly |

Everything else is **shown but not offered**, with a reason. Hiding a rejected
template would leave an owner wondering where the one they wrote went.

Supported in this phase:

- TEXT body, with `{{n}}` parameters
- TEXT header, with `{{n}}` parameters
- Footer text and button labels — shown in the preview, informational only

Not supported, and refused with a reason:

- IMAGE / VIDEO / DOCUMENT / LOCATION headers
- Any component type LeadFlow does not recognise (carousels, and whatever Meta
  adds next)
- A template with no body

An unrecognised component makes the whole template unsupported rather than being
silently dropped — dropping it would send a customer half a message.

### Parameters

`{{1}}`, `{{2}}` … in the template text. The picker asks for one value per
**distinct** placeholder: `{{1}}` appearing twice still takes one value, and it
is substituted in both places.

Validated against the **stored definition**, never against anything the browser
claims, and re-checked server-side even though the UI checks first. Rejected:

- the wrong number of values
- a blank or whitespace-only value — it reaches the customer as a gap in a
  sentence, and a delivered WhatsApp message cannot be corrected
- newlines, tabs or carriage returns — Meta rejects these anyway
- anything over 1024 characters

The conversation timeline stores the **rendered** text — what the customer
actually received — not the template name, which they never saw. The name and
the submitted values are kept in the message's metadata.

### Sending one

```
POST /api/v1/conversations/:id/template-messages     # lead.update
{
  "templateName": "order_ready",
  "language": "en_US",
  "bodyParameters": ["Rahul", "A-1024"],
  "headerParameters": [],
  "idempotencyKey": "<uuid>"
}
```

A **separate endpoint** from `POST :id/messages`, deliberately. It reuses the
identical machinery — the same authorization, the same conversation visibility,
the same idempotency key, the same claim-before-send ordering, the same message
table and timeline — and differs in exactly two ways: it checks
`canSendTemplate` instead of `canSend`, and its content comes from the stored
definition rather than from typed text.

### There is no automatic fallback

**A free-form send refused because the window closed stays refused.** It returns
409 and nothing reaches Meta. It does not quietly become a template.

This is a product decision, not an oversight. A template can reach a customer
who has not written for weeks and is billed on most plans, so it must be
something a person chose — not something that happened because a colleague
mistimed a reply. Folding the two into one endpoint would put that fallback one
`if` away, which is why they are two.

Equally, nothing selects a template on the user's behalf, and no AI writes one.

### When a template stops working

| At Meta | What LeadFlow does |
|---|---|
| Paused / rejected / disabled | Still listed, with that status, not sendable. The send is refused before Meta is called |
| Deleted | Disappears on the next **Refresh templates** |
| Edited and re-approved | The new text appears on the next refresh |
| Revoked since the last sync | The send reaches Meta and is refused; the message is marked `FAILED` with "It may no longer be approved — refresh the template list" |

The cache going stale therefore costs a failed send, never an unauthorised one.
Meta re-checks approval on every send regardless of what we stored.

### Still to be done in Meta

Nothing beyond the ordinary: create the templates, get them approved, and make
sure the tenant's access token carries `whatsapp_business_management`. LeadFlow
needs no additional app review or permission for templates.

### Not implemented

Media headers, interactive buttons in a send, template creation or editing,
approval status polling, bulk or broadcast sending, campaign scheduling,
Instagram and Facebook templates (neither platform has the concept), and
HUMAN_AGENT tags.
