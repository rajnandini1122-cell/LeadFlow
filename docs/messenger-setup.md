# Instagram DMs and Facebook Messenger — setup and operation

LeadFlow captures Instagram Direct Messages and Facebook Messenger messages,
matches them to contacts and leads, and shows them in the same inbox and review
queue as every other channel. **Inbound only** — replying from LeadFlow is not
implemented for either, and the UI says so rather than offering a composer that
cannot send.

Both are documented together because they are the same Meta protocol under two
names: the same webhook envelope, the same signature scheme, the same
millisecond timestamps, the same echo semantics. LeadFlow implements them with
one shared adapter and two channel descriptors.

Every value here is a placeholder. Do not commit real credentials.

---

## 1. What you need from Meta

| Thing | Where it comes from | Scope |
|---|---|---|
| App Secret | App dashboard → Settings → Basic | The whole deployment |
| Verify token | You invent it | The whole deployment |
| Instagram professional account ID | App dashboard → Instagram → API setup | Per tenant |
| Linked Facebook Page ID | Page settings → Linked accounts | Per tenant (optional) |
| Facebook Page ID | Page → About → Page transparency | Per tenant |
| Access token | The Page token your app was granted | Per tenant |

For **Facebook Messenger** specifically the business needs:

- a Facebook **Page** they administer
- the Meta app subscribed to that Page's `messages` webhook field
- `pages_messaging` and `pages_manage_metadata` granted

For Messenger the Page *is* the account — there is no second identifier.

### Account requirements

Instagram messaging does not work on a personal account. The business needs:

- an Instagram **professional** account (Business or Creator)
- that account **linked to a Facebook Page** they administer
- **"Allow access to messages"** switched on in the Instagram app, under
  Settings → Messages and story replies → Connected tools
- the Meta app granted `instagram_basic` and `instagram_manage_messages`

Missing any of these produces a token that authenticates but returns nothing
useful — which is why setup verifies the account rather than trusting the form.

---

## 2. Environment variables

```bash
# Meta app secret for the Instagram product.
INSTAGRAM_APP_SECRET=<from the Meta app dashboard>
INSTAGRAM_VERIFY_TOKEN=<openssl rand -hex 32>

# Meta app secret for the Messenger product.
FACEBOOK_APP_SECRET=<from the Meta app dashboard>
FACEBOOK_VERIFY_TOKEN=<openssl rand -hex 32>
```

These are **separate** from the WhatsApp values, and from each other, because
the three products can live in three different Meta apps. If yours share one
app, set the same secret in each — the config says which secret guards which
endpoint rather than assuming, and a leak of one then compromises only one.

`CREDENTIAL_ENCRYPTION_KEY` and `WHATSAPP_API_VERSION` are shared and already
documented in [whatsapp-setup.md](./whatsapp-setup.md).

With `INSTAGRAM_APP_SECRET` unset, **every** delivery is rejected. That is
deliberate: an endpoint that waves requests through because it was misconfigured
is worse than one that is down.

---

## 3. Webhook URL

```
https://<your-api-host>/api/v1/webhooks/instagram
https://<your-api-host>/api/v1/webhooks/facebook
```

A path per product, because Meta configures a callback URL per product and each
carries its own secret.

- **Instagram → Configuration → Webhooks** — paste the Instagram URL and verify
  token, subscribe to **`messages`**.
- **Messenger → Settings → Webhooks** — paste the Facebook URL and verify token,
  subscribe to **`messages`**, then subscribe the app to the specific Page.

Each endpoint checks the envelope's `object` field: an Instagram payload
delivered to the Facebook endpoint is refused rather than ingested under the
wrong channel.

---

## 4. Connecting a tenant

**Settings → Channels → Instagram** or **Facebook Messenger → Connect**, as an
owner or administrator. Enter the account identifier — an Instagram professional
account ID, or a Facebook Page ID — and the access token.

1. The token is encrypted (AES-256-GCM) and stored; status becomes `CONNECTING`.
2. LeadFlow reads the account back from the Graph API.
3. Success → `CONNECTED`, with the `@username` as the display name.
   Failure → `ERROR`, with a short non-secret reason.

**`CONNECTED` is never written without a successful call to Meta.**

One account can belong to only one LeadFlow organization per channel, enforced
by a global unique constraint on `(channel, provider_account_id)`. Connecting
one already claimed returns `409` without revealing who holds it.

---

## 5. How a DM finds its tenant

```
POST /api/v1/webhooks/instagram
  ↓ HMAC-SHA256 over the raw body        reject → 403, nothing written
  ↓ parse (entries, messaging events)    unreadable events counted, others continue
  ↓ entry.id → integration               unknown → 200, no tenant chosen
  ↓ enabled? status CONNECTED?           no → 200, nothing written
  ↓ existing ingestion service           ← everything below predates Instagram
  ↓ identity resolution, lead matching
  ↓ inbox / review queue / lead timeline
```

`entry.id` is the business's Instagram account ID or Facebook Page ID. Nothing
in the payload names an organization, and nothing in it would be trusted if it
did.

A customer who messages two different Pages of the same organization gets two
conversations, because the account id is part of the conversation key. Merging
them would put one Page's correspondence into another's.

---

## 6. Supported and unsupported message types

| Arrives as | Stored as |
|---|---|
| Text DM | `TEXT` with content |
| Image / video / audio / file | Its real type, **content `null`** |
| Story reply, share, unknown type | `OTHER`, content `null` |
| Echo of our own message | Ignored |
| Reaction, read receipt, deletion | Ignored |

An attachment is recorded with its real type and no content rather than being
labelled text. A shared reel stored as a text message would appear on a lead's
timeline as though the customer had written nothing.

**No media is downloaded or proxied.** The conversation records that something
arrived and when.

Echoes matter more than they look: both channels reflect the business's own
outgoing messages back on the same webhook, which WhatsApp does not. Ingesting
one would create a conversation with the business as the customer and could open
a lead against itself.

---

## 7. Identity — what is deliberately not done

Neither channel discloses **a phone number or an email**. Identity resolution
therefore matches on the provider-scoped sender ID and nothing else. A sender
nobody has seen before resolves to **nobody**, and the conversation goes to the
review queue for a person to decide.

LeadFlow will **not** guess that an Instagram handle, a Messenger sender and a
WhatsApp number are the same person, however similar the display names — and it
does not treat identical-looking scoped ids on two channels as evidence either,
since they come from different products. A false identity merge puts one
customer's messages permanently inside another customer's history, and there is
no undo. A duplicate identity is the cheaper mistake.

Linking an Instagram conversation to an existing lead is available in the review
queue — as a human decision, which is the correct place for it.

---

## 8. Why there is no reply box

Outbound is not implemented for either channel. `canSend` is false and the
drawer shows *"Replying from LeadFlow is not available for this channel yet."*

That is enforced by the API, not by hiding a button: `POST
/conversations/:id/messages` refuses both with `409`.

Messenger's rules differ from WhatsApp's — a different window, a different
permission set, and human-agent handover semantics — so outbound is its own
piece of work rather than a flag flip.

---

## 9. Everything else is shared

Both channels use the same conversation and message tables, the same
[conversation visibility policy](../apps/api/src/modules/omnichannel/conversation-visibility.ts),
the same potential-lead keyword rules, the same review queue and the same
inbox filters. There is no channel-specific CRM behaviour anywhere, and neither
phase added a database migration — `ChannelType` already had both values and
`ChannelIntegration` already stored what they need.

Disabling the integration stops new messages being acted on and keeps every
conversation, message and lead exactly where it is.

---

## 10. Known limitations

- **Inbound text only** in practice; other types are recorded but not rendered.
- **No media**, sent or received.
- **No cross-channel identity linking** without a human deciding.
- **No outbound**, so a conversation cannot be answered from LeadFlow.
- **Story mentions and shares** land as `OTHER` with no content, which reads as
  a blank entry in the conversation. Honest, but not informative.
- **Sender usernames are not stored** as a contact identity until a person
  links the conversation to a contact.
- **Messenger handover protocol** (`standby` events) is not implemented; a
  conversation controlled by another app is not ingested.

---

## 11. Diagnosing

| Symptom | Cause |
|---|---|
| Meta cannot verify the URL | Verify token mismatch, or the URL is not reachable |
| Every delivery returns 403 | The matching `*_APP_SECRET` unset or wrong |
| 200 but nothing appears | Account not connected, integration disabled, or status is not `CONNECTED` |
| Setup fails with "does not recognise that account" | Not a professional account / not linked to the Page, or the token is not for that Page |
| Setup fails with "rejected the access token" | Token expired, or missing `instagram_manage_messages` / `pages_messaging` |
| Messages appear under no lead | Working as intended — neither channel gives a phone number, so an unknown sender goes to the review queue |

Logs record the integration ID, organization ID, provider message ID and an
error category. They never record access tokens, app secrets, verify tokens or
message bodies.
