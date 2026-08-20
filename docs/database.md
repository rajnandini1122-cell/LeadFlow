# Database design

PostgreSQL 17. UUIDv7 primary keys, `timestamptz` everywhere, `snake_case` in
the database and `camelCase` in TypeScript via Prisma `@map`.

## Business invariants enforced in SQL

These cannot be expressed in `schema.prisma`, so they live in raw SQL inside the
migration — and are asserted by
[schema-invariants.e2e-spec.ts](../apps/api/test/schema-invariants.e2e-spec.ts)
so that a future generated migration cannot silently drop one.

### "No lead left behind"

```sql
ALTER TABLE leads ADD CONSTRAINT leads_active_requires_followup CHECK (
  deleted_at IS NOT NULL
  OR status IN ('WON','LOST')
  OR next_follow_up_at IS NOT NULL
);
```

The product promise as a database guarantee. Every writer is bound by it — API,
worker, CSV import, a future integration, or a human with `psql` — not merely
the code paths someone remembered to guard.

### Duplicate lead detection

```sql
CREATE UNIQUE INDEX leads_org_mobile_uniq ON leads (organization_id, mobile)
  WHERE mobile IS NOT NULL AND deleted_at IS NULL AND status <> 'LOST';
```

Partial, because a genuinely lost enquiry may legitimately return later, and
soft-deleted rows must not block re-creation. Uniqueness is **per tenant**: two
SMEs may both be talking to the same person.

The API checks first and returns `DUPLICATE_LEAD` with the existing id so the
client can offer "Open existing lead"; the index is the backstop for the race
between two concurrent creates.

### Append-only timeline

A `BEFORE UPDATE` trigger on `lead_activities` raises `restrict_violation`.
Spec §9: *do not destroy historical business activity*. Enforced in the database
so a bug, a bad migration, or a careless console session cannot rewrite sales
history.

### uuidv7()

A SQL function generating time-ordered UUIDs: take a v4, overlay the leading six
bytes with the Unix millisecond timestamp, flip the version nibble from 4 to 7.
`set_bit` indexes bits LSB-first within each byte, so the version nibble of byte
6 occupies indices 52–55 and going from `0100` to `0111` means setting bits 52
and 53.

Skipped if a `uuidv7()` already exists, so upgrading to Postgres 18 adopts the
built-in with no migration.

## Tables

### Identity and tenancy — Phase 1 ✅

| Table | Notes |
|---|---|
| `organizations` | The tenant. `timezone` defaults to `Asia/Kolkata` |
| `organization_settings` | Follow-up escalation thresholds — config, not code |
| `users` | **Global**, not tenant-scoped. See below |
| `organization_users` | The tenancy join. Unique on `(organization_id, user_id)` |
| `roles` | System roles have `organization_id = NULL` and are shared |
| `permissions`, `role_permissions` | Guards check permissions, not role names |
| `sessions` | One row per issued refresh token; `family_id` links rotations |
| `audit_logs` | Append-only. Nullable tenant — a failed login may have none |

> **`users` is global by design.** One person with one email can belong to
> several organizations — normal for an SME's accountant or an external
> consultant. Tenancy lives entirely in `organization_users`, which is why the
> access token is scoped to a single organization and multi-org users get an
> org-selection step at login.
>
> The consequence: `prisma.user.update()` is **not** tenant-scoped. Always
> confirm membership through `organization_users` first. See
> [tenancy.md](tenancy.md).

### CRM — schema Phase 1 ✅, logic Phase 2

`leads` and `lead_activities` are migrated in Phase 1 so tenant isolation is
proven against a real business table rather than only identity tables, which
have special-case handling. Phase 1 exposes them read-only.

`lead_notes`, `lead_assignments` and `follow_ups` arrive with their phases.

### Communication and platform — Phases 8–10

`whatsapp_accounts`, `whatsapp_conversations`, `whatsapp_messages`
(`provider_message_id` unique for webhook idempotency), `notifications`
(`dedupe_key` unique for send idempotency), `notification_preferences`, `plans`,
`subscriptions`, `usage_records`.

## Indexes

Every tenant index is **`organization_id`-first**. That leading column is what
makes the tenant predicate selective rather than a filter applied after a scan.

```
leads             (organization_id, status)
                  (organization_id, assigned_to, status)
                  (organization_id, next_follow_up_at)
                  (organization_id, mobile)
                  (organization_id, created_at DESC)
                  leads_org_mobile_uniq      partial, unique
                  leads_followup_sweep_idx   partial, NOT org-first — see below
lead_activities   (organization_id, lead_id, created_at DESC)
organization_users (user_id) / (organization_id, status)
sessions          (refresh_token_hash) unique / (user_id, revoked_at) / (family_id)
audit_logs        (organization_id, created_at DESC)
```

`leads_followup_sweep_idx` is deliberately **not** organization-first: the
Phase 6 worker scans across tenants for due follow-ups. It is partial, excluding
terminal leads, which would otherwise come to dominate the index.

## Migrations

```bash
npm run db:migrate -w apps/api          # development
npm run db:migrate:deploy -w apps/api   # staging / production
```

Never modify a production schema by hand.

> **Migrations use `DIRECT_DATABASE_URL`**, the unpooled endpoint. Prisma
> Migrate takes advisory locks and runs DDL, neither of which survives a
> transaction-mode pooler. Configured in `prisma.config.ts`.

### Prisma drift warning

Prisma does not model CHECK constraints, partial indexes or triggers. A future
`prisma migrate dev` may generate a migration that **drops** the objects above.
Always read generated migrations before applying them. The schema-invariants
suite is the safety net if a review misses one.
