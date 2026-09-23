# Running LeadFlow locally

Everything here works with no cloud account, no Docker and no Meta app. The
omnichannel features can be exercised end to end without a real provider.

Prerequisites: Node 24 and npm 11. Nothing else.

---

## 1. Install

```bash
cd idea001
npm install
```

## 2. Configure

```bash
cp .env.example apps/api/.env
```

Then set three values in `apps/api/.env`. Everything else has a working default.

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/postgres?sslmode=disable
DIRECT_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/postgres?sslmode=disable

# Any two distinct strings of 32+ characters.
JWT_ACCESS_SECRET=local-development-access-secret-not-for-production
JWT_REFRESH_SECRET=local-development-refresh-secret-different-value
```

Leave every `WHATSAPP_*`, `INSTAGRAM_*` and `FACEBOOK_*` value empty unless you
have a real Meta app. Empty means those webhooks **reject everything**, which is
the correct behaviour — see §8.

## 3. Start the database

```bash
npm run db:local
```

PostgreSQL 17 compiled to WebAssembly (PGlite), listening on `127.0.0.1:5433`,
with data under `.tmp/pgdata`. **Leave this running in its own terminal.**

Two things about it are worth knowing before they surprise you:

- **It serves one connection at a time.** `DATABASE_POOL_MAX=1` is set for that
  reason. Running `prisma migrate` while the API is up will fail — stop the API
  first.
- **Only run one copy.** Two processes on port 5433 fight over the same data
  directory and produce confusing `ConnectionClosed` errors.

## 4. Migrate and seed

```bash
npm run db:migrate:deploy
npm run db:seed
```

## 5. Start the API

```bash
npm run dev:api          # http://localhost:3000
```

**Do not run `npm run build` while this is running.** `nest build` begins with
`rimraf dist`, which deletes the compiled app out from under the running
process. Use `npm run typecheck` instead; tests are safe.

## 6. Start the web app

```bash
npm run dev:web          # http://localhost:5173
```

Vite proxies `/api` to `localhost:3000`, so no CORS configuration is needed.

## 7. Log in

Every seeded account uses the same password:

```
Password: ChangeMe!2026
```

**Northwind Supply** — the main demo organization, with conversations:

| Email | Role | Sees |
|---|---|---|
| `owner@northwind.example` | OWNER | everything in Northwind |
| `admin@northwind.example` | ADMIN | everything in Northwind |
| `manager@northwind.example` | MANAGER | the team's leads and conversations |
| `sofia@northwind.example` | SALES_REP | only her own |
| `tomas@northwind.example` | SALES_REP | only his own |

**Meridian Foods** — a second tenant, in another country and currency. It has leads
but deliberately **no** conversations, so an empty inbox there is obviously correct
rather than obviously broken:

| Email | Role |
|---|---|
| `owner@meridian.example` | OWNER |
| `manager@meridian.example` | MANAGER |
| `rohan@meridian.example` | SALES_REP |
| `sana@meridian.example` | SALES_REP |

### What the seed creates

| | |
|---|---|
| Leads | 26 across all eight statuses, with overdue / due-today / upcoming follow-ups |
| Contacts | one per lead, plus 7 from conversations |
| Conversations | 7 — 3 WhatsApp, 2 Instagram, 2 Facebook Messenger |
| Messages | 16, covering SENT, DELIVERED, READ, FAILED and UNCONFIRMED |
| Attachments | a PDF on an outbound message, an image on an inbound one |
| Templates | 4 WhatsApp templates: 2 sendable, 1 pending, 1 approved-but-unsupported |
| Link states | 4 linked, 2 unlinked, 1 review-required |

Sign in as the Northwind owner and open **Inbox** — it has data immediately. Then sign
in as `sofia@northwind.example` and look again: a sales rep sees a genuinely smaller
set, because the visibility policy is real and the demo data runs through it.

### The seeded channels are NOT connected

Every seeded integration is `DISCONNECTED` with no stored credential, on purpose.
Marking one CONNECTED would tell an owner their WhatsApp number is live when no
provider integration exists — and somebody who believes that stops checking their
phone. So the conversations are fully browsable and **nothing can actually be sent**.
§9 shows how to exercise the real ingestion path without Meta.

---

## 8. About Redis

Redis is **not required** for local development, and the API does not need it to
start.

You will see this repeatedly in the log:

```
ERROR [RedisService] Redis error: connect ECONNREFUSED 127.0.0.1:6379
```

**That is expected, not a defect.** Redis backs two optimisations — the
access-token deny list, so logout takes effect immediately rather than after the
15-minute token expiry, and the membership cache. Both degrade deliberately: a
cache miss is treated as "not cached", never as "not authorised", and
`enableOfflineQueue: false` makes commands fail fast rather than hang. The only
visible difference without Redis is that a logged-out access token stays
technically valid until it expires.

Run one if the noise bothers you, or if you are testing logout revocation:

```bash
docker run -p 6379:6379 redis:8-alpine
```

---

## 9. Testing omnichannel without Meta

Channel integrations are ordinary database rows, so a conversation can be
delivered without any provider account. This exercises the real pipeline —
signature verification, tenant resolution, identity resolution, lead matching,
the review queue — not a mock of it.

**Step 1.** Put a shared secret in `apps/api/.env` and restart the API:

```bash
WHATSAPP_APP_SECRET=local-test-secret
WHATSAPP_VERIFY_TOKEN=local-verify-token
CREDENTIAL_ENCRYPTION_KEY=<node -e "console.log(require('crypto').randomBytes(32).toString('base64'))">
```

**Step 2.** Connect a number. In the app: **Settings → Channels → WhatsApp →
Connect**. The server will try to verify against Meta and land in `ERROR`, which
is correct — you have no real credentials. For local testing, set the row to
`CONNECTED` directly:

```bash
npm run db:studio -w apps/api
```

Set `channel_integrations.status = CONNECTED`, `enabled = true`, and
`provider_account_id` to any value you will reuse below, e.g. `1234567890`.

**Step 3.** Deliver a signed message:

```bash
BODY='{"object":"whatsapp_business_account","entry":[{"id":"1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"phone_number_id":"1234567890"},"contacts":[{"profile":{"name":"Rahul"},"wa_id":"447700900123"}],"messages":[{"from":"447700900123","id":"wamid.local1","timestamp":"1756000000","type":"text","text":{"body":"Need pricing for 500kg onion powder"}}]}}]}]}'

SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "local-test-secret" | awk '{print $2}')

curl -X POST http://localhost:3000/api/v1/webhooks/whatsapp \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: sha256=$SIG" \
  --data-raw "$BODY"
```

`--data-raw` matters: the signature covers the exact bytes, so anything that
re-encodes the JSON produces a different HMAC and a legitimate `403`.

**Step 4.** In the app, open **Inbox** and **Leads → Channel review**. The
message appears, flagged as a potential lead because it contains "pricing" and
"kg". From there, create a lead or link it to an existing one — both go through
the ordinary lead flow.

Change the signature by one character and repeat: the request is rejected and
nothing is written. That is the check the endpoint exists on.

Instagram and Facebook work the same way against
`/api/v1/webhooks/instagram` and `/api/v1/webhooks/facebook`, with their own
secrets and their own payload shapes — see
[messenger-setup.md](./messenger-setup.md).

---

## 9a. Testing media locally

Media needs no extra setup — no object storage, no S3, no new environment
variable. Nothing is ever downloaded at ingestion time.

**Inbound.** Add a media message to the payload from §9 instead of a text one:

```json
"messages":[{"from":"447700900123","id":"wamid.local2",
  "timestamp":"1756000000","type":"image",
  "image":{"id":"media-abc","mime_type":"image/jpeg","caption":"Is this the one?"}}]
```

Sign and post it exactly as before. The conversation shows an image
attachment, and the caption becomes the message text. **Opening it will fail
locally** — the download calls Meta with a media id that does not exist — and
that is correct: LeadFlow stores a reference, not a copy.

**Outbound.** Attach a file in the composer and send. The upload is validated
from its bytes before anything is sent, so you can watch the rejections work
without any Meta credentials at all:

- rename a `.exe` to `.jpg` → rejected, because content detection reads the
  real bytes rather than the browser's Content-Type
- attach a 6MB image on WhatsApp → rejected, the per-kind limit is 5MB
- attach a PDF on Instagram → rejected, that channel does not carry documents

The send itself will then fail at Meta, visibly. Nothing pretends otherwise.

**Limits, as implemented:**

| Channel | Image | Video | Audio | Document |
|---|---|---|---|---|
| WhatsApp | 5MB | 16MB | 16MB | 16MB |
| Messenger | 16MB | 16MB | 16MB | 16MB |
| Instagram | 8MB | 16MB | 16MB | not supported |

Accepted formats are JPEG, PNG, MP4, 3GP, AAC/M4A/MP3/OGG and PDF. Office
formats are **not** accepted: a `.docx` is a ZIP, and recognising "this is a
ZIP" would let anything zipped through.

---

## 9b. Testing WhatsApp templates

Templates are the only message WhatsApp will deliver once the 24-hour window has
closed, so testing them means closing it. Locally that is one SQL statement.

**Step 1 — load some templates.** Sync calls Meta, so there are two options:

- *With Meta credentials:* connect WhatsApp with a **WhatsApp Business Account
  ID** and a token carrying `whatsapp_business_management`, then use
  **Settings → Channel integrations → WhatsApp → Refresh templates**.
- *Without them:* insert a row directly. This is a cache, so a hand-written row
  behaves exactly like a synced one.

```sql
INSERT INTO whatsapp_templates
  (organization_id, integration_id, name, language, category, status,
   components, supported, header_parameter_count, body_parameter_count)
SELECT o.id, ci.id, 'order_ready', 'en_US', 'UTILITY', 'APPROVED',
       '{"header":null,
         "body":{"text":"Hi {{1}}, your order {{2}} is ready.",
                 "parameterCount":2},
         "footer":"Reply STOP to opt out","buttons":[]}'::jsonb,
       true, 0, 2
FROM organizations o
JOIN channel_integrations ci
  ON ci.organization_id = o.id AND ci.channel = 'WHATSAPP'
WHERE o.slug = 'northwind';
```

**Step 2 — close the window.** Age the customer's last inbound message past 24
hours:

```sql
UPDATE messages
SET sent_at = now() - interval '25 hours',
    created_at = now() - interval '25 hours'
WHERE direction = 'INCOMING'
  AND conversation_id = '<conversation-uuid>';
```

**Step 3 — look at the conversation.** The composer is gone and the reason says
the 24-hour window has closed. A **Send a template** button is there instead.
Both facts matter: free-form is genuinely refused, and there is still a way out.

Worth trying while you are here:

- type a reply through the API directly — `POST /conversations/:id/messages`
  returns **409** and nothing reaches Meta. There is no automatic fallback to a
  template, by design
- choose the template and leave a value blank → refused before sending
- fill both values → the preview substitutes them, `{{1}}` and `{{2}}` disappear
- set the row's `status` to `PAUSED` and reload → it is no longer offered
- set `supported` to `false` → same, with the reason shown in settings

Without real credentials the send itself fails at Meta, visibly, and the message
is marked `FAILED` with the reason. Nothing pretends otherwise, and nothing
retries on its own.

---

## 10. Testing with a real WhatsApp number

You need a Meta app, a WhatsApp Business number and a public HTTPS URL. Full
setup is in [whatsapp-setup.md](./whatsapp-setup.md). The short version:

```bash
cloudflared tunnel --url http://localhost:3000
```

Register `https://<tunnel>/api/v1/webhooks/whatsapp` in the Meta app with your
verify token, subscribe to `messages`, then connect the number through
**Settings → Channels**. Verification will now succeed and the status becomes
`CONNECTED` on its own.

---

## 10b. Android

The Android app is this same web application packaged with Capacitor. Build it with:

```bash
npm run android:build      # builds the web bundle, syncs, then assembles a debug APK
npm run android:publish    # copies it to the home page download card
```

Full setup, the API-address requirement and troubleshooting are in
[android.md](./android.md).

---

## 11. Quality gates

```bash
npm run lint
npm run typecheck
npm run test -w apps/api      # unit
npm run test -w apps/web
npm run test:e2e -w apps/api  # spins up its own throwaway database
npm run build                 # stop the API first
```

The E2E suite creates and migrates a fresh database on every run, so it also
proves the migration chain applies cleanly from zero.

---

## 12. When something is wrong

| Symptom | Cause |
|---|---|
| `Can't reach database server at 127.0.0.1:5433` | The database terminal is not running, or two copies are fighting |
| `P1017 ConnectionClosed` | Two processes on port 5433 — kill both, start one |
| API 502 through the web app | The API is not running; check for a `rimraf dist` from a stray `npm run build` |
| Repeating `Redis error: ECONNREFUSED` | Expected without Redis — see §8 |
| Webhook returns 403 | The relevant `*_APP_SECRET` is unset or does not match what you signed with |
| Webhook returns 200 but nothing appears | Integration not `CONNECTED`, disabled, or the account id does not match |
| `prisma migrate` fails while the API runs | PGlite serves one connection — stop the API first |
