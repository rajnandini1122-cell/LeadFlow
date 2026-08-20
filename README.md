# LeadFlow — WhatsApp-First Sales CRM for Indian SMEs

**No lead left behind.**

Every active lead has an owner, a status, a full activity history, and a next
action. Multi-tenant SaaS: one deployment, many organizations, complete data
isolation between them.

> **Status: Phase 1 (Foundation) complete.** Authentication, multi-tenancy,
> users, organizations and read-only leads are built and tested. Lead CRM
> (Phase 2) and the follow-up engine (Phase 6) are not yet implemented — see
> [Roadmap](#roadmap).

---

## Quick start

Prerequisites: **Node 24+**, **npm 11+**. (Java 21 additionally for Android, in
Phase 1b.)

```bash
npm install
npm run build -w packages/api-types
```

### 1. Choose a database and cache

Three supported options — pick one and set `DATABASE_URL` / `REDIS_URL`
accordingly.

| Option | Use when | Postgres | Redis |
|---|---|---|---|
| **Managed** (recommended) | Normal development | [Neon](https://neon.tech) free tier | [Upstash](https://upstash.com) free tier |
| **Docker** | You have Docker installed | `docker compose -f infrastructure/docker/docker-compose.yml up -d` | same |
| **In-process** | No Docker, offline, quick check | `node scripts/local-db.mjs` | not provided — the API degrades gracefully without Redis |

`scripts/local-db.mjs` runs **real Postgres 17** compiled to WebAssembly
(PGlite) and serves it over the Postgres wire protocol, so migrations, triggers
and constraints behave exactly as in production. It accepts one connection at a
time, so it is for development and tests only. See [docs/runbook.md](docs/runbook.md).

### 2. Configure

```bash
cp .env.example apps/api/.env
```

Fill in `DATABASE_URL`, `DIRECT_DATABASE_URL`, `REDIS_URL`, and generate both
JWT secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

> `DIRECT_DATABASE_URL` must be the **unpooled** endpoint. Prisma Migrate takes
> advisory locks and runs DDL, neither of which survives a transaction-mode
> pooler. On Neon these are two different hostnames.

### 3. Migrate, seed, run

```bash
npm run db:migrate -w apps/api
npm run db:seed    -w apps/api

npm run dev:api      # http://localhost:3000  (docs at /api/docs)
npm run dev:web      # http://localhost:5173
npm run dev:worker   # background worker (idle until Phase 6)
```

Sign in with `owner@cravion.test` and the password printed by the seed.
The seed creates **two** organizations so tenant isolation can be exercised by
hand.

### 4. Verify

```bash
npm run lint
npm run typecheck
npm run test     -w apps/api   # unit
npm run test:e2e -w apps/api   # e2e, incl. the mandatory isolation suite
```

---

## Architecture

Multi-tenant **modular monolith** — deliberately not microservices (see
[docs/architecture.md](docs/architecture.md) for the reasoning and the
extraction path).

```
Android (Phase 1b)   Web console        Super admin (Phase 6)
        │                 │                     │
        └─────────────────┼─────────────────────┘
                          ▼
                    Backend API  ──────┐
                          │            │  same codebase,
             ┌────────────┼──────┐     │  separate process
             ▼            ▼      ▼     ▼
        PostgreSQL     Redis    S3   Worker ──► FCM / WhatsApp
```

| Path | What |
|---|---|
| [apps/api](apps/api) | NestJS modular monolith. `main.ts` serves HTTP, `worker.ts` runs queues |
| [apps/web](apps/web) | React 19 + Vite + Tailwind 4 management console |
| [apps/worker](apps/worker) | Thin entry re-exporting the API's worker bootstrap |
| [apps/android](apps/android) | Kotlin + Compose sales app — **Phase 1b** |
| [packages/api-types](packages/api-types) | Error codes, domain enums and contracts shared by API and web |
| [infrastructure](infrastructure) | Docker Compose, deployment, monitoring |
| [docs](docs) | Architecture, database, tenancy, runbook |

### Technology

TypeScript **5.9.3** · NestJS 11 · Prisma 7 · PostgreSQL 17 · Redis 8 +
BullMQ · React 19 · Vite 8 · Tailwind 4.

> **TypeScript is pinned to 5.9.3, not the latest 7.x.** TypeScript 7 is the
> Go-based native compiler and ships no programmatic compiler API, so
> `nest build`, the Swagger CLI plugin and `ts-jest` do not run on it. Revisit
> when 7.1 ships its API and NestJS adopts it.

---

## Tenant isolation

The most important property of this system. Three layers:

1. **Server-derived context** — tenant identity comes from a signed token,
   re-validated against live membership on every request. Client-supplied
   `organizationId` fields are stripped before any handler sees them.
2. **Prisma client extension** — automatically scopes every tenant-owned query,
   and **throws rather than running unscoped** if context is missing.
3. **The mandatory test suite** — Organization A can never reach Organization
   B's data. Runs in CI on every commit.

Read [docs/tenancy.md](docs/tenancy.md) before touching data access.

---

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Auth, multi-tenancy, users, organizations | ✅ Done |
| 1b | Android app scaffold (needs Android Studio) | ⬜ Next |
| 2 | Lead CRM: create, update, assign, duplicate detection | ⬜ |
| 5 | Activity timeline | ⬜ |
| 6 | **Follow-up engine** — the core promise | ⬜ |
| 8 | Push notifications (FCM) | ⬜ |
| 9 | Web management console (full) | ⬜ |
| 10 | WhatsApp integration | ⬜ |
| 12 | Staging deployment | ⬜ |

Deliberately **excluded** from the MVP: AI features, custom pipeline builder,
quotation engine, payments, advanced BI, iOS, microservices, Kubernetes.

---

## Contributing

- Business logic belongs in services, never controllers or Compose UI.
- Prisma is touched only in `*.repository.ts` — enforced by ESLint.
- Never `eslint --fix` the API with `consistent-type-imports` enabled; it
  rewrites DI imports to `import type` and silently breaks Nest's injector.
- Do not commit secrets. `.env` is git-ignored; `.env.example` is the template.
