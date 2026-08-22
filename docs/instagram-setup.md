# Instagram Direct Messages — setup and operation

LeadFlow captures Instagram DMs, matches them to contacts and leads, and shows
them in the same inbox and review queue as every other channel. **Inbound only** —
replying from LeadFlow is not implemented, and the UI says so rather than
offering a composer that cannot send.

Every value here is a placeholder. Do not commit real credentials.

---

## 1. What you need from Meta

| Thing | Where it comes from | Scope |
|---|---|---|
| App Secret | App dashboard → Settings → Basic | The whole deployment |
| Verify token | You invent it | The whole deployment |
| Instagram professional account ID | App dashboard → Instagram → API setup | Per tenant |
| Linked Facebook Page ID | Page settings → Linked accounts | Per tenant (optional) |
| Access token | The Page/Instagram token your app was granted | Per tenant |

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

# Any long random string. The SAME value goes into Meta's webhook setup.
INSTAGRAM_VERIFY_TOKEN=<openssl rand -hex 32>
```

These are **separate** from the WhatsApp values because the two products can
live in different Meta apps. If yours share one app, set the same secret in
both — the config says which secret guards which endpoint rather than assuming.

`CREDENTIAL_ENCRYPTION_KEY` and `WHATSAPP_API_VERSION` are shared and already
documented in [whatsapp-setup.md](./whatsapp-setup.md).

With `INSTAGRAM_APP_SECRET` unset, **every** delivery is rejected. That is
deliberate: an endpoint that waves requests through because it was misconfigured
is worse than one that is down.

---

## 3. Webhook URL

```
https://<your-api-host>/api/v1/webhooks/instagram
```

A different path from the WhatsApp webhook, because Meta configures a callback
URL per product and the two payloads share nothing but their envelope.

In the Meta app: **Instagram → Configuration → Webhooks**, paste the URL and
your verify token, then subscribe to the **`messages`** field.

---

## 4. Connecting a tenant

**Settings → Channels → Instagram → Connect**, as an owner or administrator.
Enter the professional account ID, optionally the Page ID, and the access token.

1. The token is encrypted (AES-256-GCM) and stored; status becomes `CONNECTING`.
2. LeadFlow reads the account back from the Graph API.
3. Success → `CONNECTED`, with the `@username` as the display name.
   Failure → `ERROR`, with a short non-secret reason.

**`CONNECTED` is never written without a successful call to Meta.**

One Instagram account can belong to only one LeadFlow organization, enforced by
a global unique constraint. Connecting one already claimed returns `409` without
revealing who holds it.

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

`entry.id` is the business's Instagram account ID. Nothing in the payload names
an organization, and nothing in it would be trusted if it did.

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

Echoes matter more than they look: Instagram reflects the business's own
outgoing messages back on the same webhook, which WhatsApp does not. Ingesting
one would create a conversation with the business as the customer and could open
a lead against itself.

---

## 7. Identity — what is deliberately not done

Instagram discloses **no phone number and no email**. Identity resolution
therefore matches on the Instagram-scoped sender ID and nothing else. A sender
nobody has seen before resolves to **nobody**, and the conversation goes to the
review queue for a person to decide.

LeadFlow will **not** guess that an Instagram handle is the same person as a
WhatsApp number, however similar the display name. A false identity merge puts
one customer's messages permanently inside another customer's history, and there
is no undo. A duplicate identity is the cheaper mistake.

Linking an Instagram conversation to an existing lead is available in the review
queue — as a human decision, which is the correct place for it.

---

## 8. Why there is no reply box

Instagram outbound is not implemented. `canSend` is false for every Instagram
conversation and the drawer shows *"Replying from LeadFlow is not available for
this channel yet."*

That is enforced by the API, not by hiding a button: `POST
/conversations/:id/messages` refuses an Instagram conversation with `409`.

Instagram's messaging rules differ from WhatsApp's — a different window, a
different permission set, and human-agent handover semantics — so outbound is
its own piece of work rather than a flag flip.

---

## 9. Everything else is shared

Instagram conversations use the same conversation and message tables, the same
[conversation visibility policy](../apps/api/src/modules/omnichannel/conversation-visibility.ts),
the same potential-lead keyword rules, the same review queue and the same
inbox filters. There is no Instagram-specific CRM behaviour anywhere, and no
schema was added for this phase.

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
- **Instagram username is not stored** as a contact identity until a person
  links the conversation to a contact.

---

## 11. Diagnosing

| Symptom | Cause |
|---|---|
| Meta cannot verify the URL | Verify token mismatch, or the URL is not reachable |
| Every delivery returns 403 | `INSTAGRAM_APP_SECRET` unset or wrong |
| 200 but nothing appears | Account not connected, integration disabled, or status is not `CONNECTED` |
| Setup fails with "does not recognise that account" | Not a professional account, or not linked to the Page |
| Setup fails with "rejected the access token" | Token expired, or missing `instagram_manage_messages` |
| DMs appear under no lead | Working as intended — Instagram gives no phone number, so an unknown sender goes to the review queue |

Logs record the integration ID, organization ID, provider message ID and an
error category. They never record access tokens, app secrets, verify tokens or
message bodies.
