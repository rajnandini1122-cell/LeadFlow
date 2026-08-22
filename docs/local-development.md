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

| Email | Role |
|---|---|
| `owner@northwind.example` | OWNER |
| `admin@northwind.example` | ADMIN |
| `manager@northwind.example` | MANAGER |
| `tomas@northwind.example` | SALES_REP |
| `owner@meridian.example` | OWNER of a second organization |

Sign in as the Northwind owner and open **Inbox**. It is empty until a channel
delivers something — §9 shows how to make that happen without Meta.

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
