# apps/worker

The background worker is a **separate process**, as spec §27 requires — but it
is built from `apps/api`, not from its own source tree.

```
apps/api/src/worker.ts   ->   dist/worker.js   ->   node dist/worker.js
```

## Why not a separate workspace?

The worker needs the same Prisma client, the same domain services and the same
tenant-context plumbing as the API. A separate workspace would force either
duplicating all three or extracting them into a shared package that only these
two consume — and the two copies would drift, which is precisely the failure the
follow-up engine cannot afford.

A second entrypoint gives the required process separation with none of the
duplication:

- it binds no port and serves no HTTP;
- it scales independently of the API;
- it can be split into its own service later without touching business logic.

## Running

```bash
npm run dev:worker          # from the repo root, watch mode
node apps/api/dist/worker.js  # production
```

## Status

Phase 1 boots the DI container and holds. The BullMQ processors listed in
spec §11 — `FOLLOW_UP`, `NOTIFICATION`, `WHATSAPP`, `WEBHOOK_PROCESSOR`,
`IMPORT`, `REPORT` — are registered in Phase 6.

Queue connections come from `RedisService.createQueueConnection()`, which is
separate from the cache connection: BullMQ requires
`maxRetriesPerRequest: null` and its own offline-queue semantics, the opposite
of what the cache wants.
