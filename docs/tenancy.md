# Tenant isolation

> The single most important document in this repository. A bug here is a data
> breach between paying customers, not a defect.

LeadFlow is multi-tenant: one deployment, many organizations. Every business
record belongs to exactly one organization, and no user may ever read or write
another organization's data.

## The rule

> Never trust `organization_id`, `user_id`, `role` or any permission coming from
> a client. Derive the security context from the authenticated server-side
> identity, on every request.

## Three layers

Isolation does not rest on remembering to add a `WHERE` clause.

### Layer 1 — Server-derived context

`JwtAuthGuard` ([jwt-auth.guard.ts](../apps/api/src/modules/auth/guards/jwt-auth.guard.ts)):

1. verify the JWT signature — proves the claims are ours and unforged;
2. check the Redis deny list — makes logout immediate rather than waiting out
   the 15-minute token lifetime;
3. **re-load the membership from the database** (cached 60s) — a suspended or
   demoted user must not ride out their remaining token;
4. reject if the user or organization is suspended;
5. populate `AsyncLocalStorage` via `nestjs-cls`.

Step 3 is the one commonly skipped. Without it, `role` and `org` are only as
fresh as the token.

**The token's `org` claim is not "client-supplied data".** It arrives on the
request, but the client cannot forge a server signature. It is nonetheless
re-validated on every request, because a signature proves origin, not currency.

`StripTenantFieldsInterceptor` deletes `organizationId`, `organization_id`,
`orgId`, `org_id`, `tenantId` and `tenant_id` from every body, query and route
parameter before validation. A client that sends one gets its **own**
organization and a logged warning — not an error, because erroring would reveal
whether the target organization exists.

> Express 5 exposes `req.query` as a lazy getter, so `delete` does not persist.
> The interceptor redefines the property instead. The cross-tenant suite caught
> this; without the fix the field reached the ValidationPipe.

### Layer 2 — Prisma client extension

[tenant-scope.extension.ts](../apps/api/src/common/prisma/tenant-scope.extension.ts)
injects `organizationId` into every query against a tenant-owned model — into
`where` for reads and targeted writes, into `data` for creates.

Two properties matter more than the mechanics:

- **It fails closed.** No context means a throw, never an unscoped query.
- **It cannot see raw SQL.** See "Known gaps".

`TENANT_SCOPED_MODELS` maps each model to its tenant column. `Organization` is
scoped by its own primary key — the organizations table has no
`organization_id`, but reading another tenant's row is just as much of a leak.

Deliberately **not** auto-scoped, each for a stated reason:

| Model | Why | How it is protected instead |
|---|---|---|
| `User` | Global by design — one person, many organizations | Always reached through `OrganizationUser` in `UsersRepository` |
| `Role`, `Permission`, `RolePermission` | System rows have `organization_id = NULL` and are shared | Read-only reference data |
| `AuditLog` | Nullable tenant — a failed login against an unknown email has none | `AuditRepository` sets the tenant explicitly |

> `User` being global is the subtlest trap in the codebase. `prisma.user.update({ where: { id } })`
> is **not** tenant-scoped. Every write to a user must first confirm membership
> through the scoped `organizationUser` table. `UsersRepository.updateMember`
> does this unconditionally, before any branch.

### Layer 3 — Tests

[tenant-isolation.e2e-spec.ts](../apps/api/test/tenant-isolation.e2e-spec.ts)
implements the mandatory test: Organization A can never read, list, modify or
enumerate Organization B. It runs in CI on every commit.

**Any new tenant-owned table must gain cases here at the same time it gains
endpoints.**

## Escaping the scope, deliberately

Some work is legitimately cross-tenant: login (which organizations does this
email belong to?), the follow-up sweep, super-admin tooling.

```ts
await tenantContext.runAsSystem(
  'login: resolve which organizations a user belongs to, before a tenant is known',
  async () => { /* ... */ },
);
```

`reason` is required, so every bypass is self-documenting and greppable.
Background jobs use `runWithTenant(principal, fn)` instead.

> **Both helpers await inside the ALS scope, and that is load-bearing.**
> Prisma query builders return **lazy** promises. Passing
> `() => prisma.x.findMany(...)` returns an unstarted promise; the scope exits,
> and the query then runs with no context. Awaiting inside forces execution to
> begin while the context is live. This was a real bug, caught by the
> fail-closed guard.

## Known gaps

**`$queryRaw` bypasses Layer 2.** The extension cannot see raw SQL. It is banned
by an ESLint `no-restricted-syntax` rule. If you genuinely need it:

1. put it in a `*.repository.ts`;
2. bind `organizationId` as an explicit parameter — never interpolate;
3. add a case to the cross-tenant suite;
4. disable the rule on that line only, with a comment.

This is the most likely way a leak gets introduced. Treat any PR that touches it
as a security review.

## Deliberately deferred: Postgres RLS

Row-Level Security is the strongest possible guarantee — the database refuses
cross-tenant reads regardless of application bugs. It is **not** in the MVP
because it needs `SET LOCAL app.current_org_id` inside a transaction on every
query, which interacts badly with transaction-mode connection poolers (Neon's
pooled endpoint) and adds real complexity.

The schema is built so RLS can be switched on later **with no application
change**: every tenant table already carries a non-null `organization_id`.
Revisit once the platform carries paying multi-tenant traffic.

## Review checklist

- [ ] Does any new table hold tenant data? Add it to `TENANT_SCOPED_MODELS`.
- [ ] Does any new query touch `User` or another non-scoped model directly?
- [ ] Any `$queryRaw`?
- [ ] Does a foreign id return **404**, never 403? (403 confirms existence.)
- [ ] Does a new mutating path invalidate the membership cache?
- [ ] Are there cross-tenant test cases for every new endpoint?
