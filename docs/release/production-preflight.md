# Production preflight — PR #11 → #12 → #13

Read-only checks to run before the first merge. Nothing here writes to production.

## 1. Already verified (2026-10-25, no database access needed)

| Check | Result | How |
|---|---|---|
| Deployed commit | `c60e614` (PR #10). Railway deployment status **success**, 2026-10-23 15:21 UTC | GitHub deployment record written by `railway-app[bot]` |
| API up | `GET https://leadflow.cravionventures.com/health` → `200 {"status":"ok"}`, uptime ≈ 39 h, consistent with that deploy | public endpoint |
| CORS for the Android app | **Missing.** The preflight from `https://localhost` gets no `Access-Control-Allow-Origin` | public endpoint, see docs/android.md |

## 2. Needs read access to the production database

Run both scripts with a read-only role if one exists:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/release/production-preflight.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/release/leadflow-stabilization/01-repair-preview.sql
```

Both run inside a `READ ONLY` transaction that is rolled back. PostgreSQL refuses any
write inside it; this was verified with a write probe. The script was checked against a
real PostgreSQL 17 at production's exact migration level (taken from commit
`c60e614`): every check returned its expected value. A seeded copy with planted
problems was used to confirm the checks fire.

| # | Check | Expected | If not |
|---|---|---|---|
| P1 | Database encoding | `UTF8` | Stop: `20261002` fails on non-UTF-8 |
| P2 | Last applied migration | `20260930090000_website_enquiry_classification`; 0 failed or rolled back; no `20261002`+ rows | Stop and investigate the history |
| P3 | Release objects already exist | all `false` | Stop: someone applied part of the release by hand |
| P4 | Live leads owned by non-active members | 0 rows | Reassign in the app first, or accept they stay out of queues |
| P5 | Open follow-ups on closed or deleted leads | 0 rows | Inflates overdue counts; list for cleanup (do not auto-delete) |
| P6 | Rows whose organization differs from their lead's | 0 in all three | **Stop**: an isolation breach to investigate before anything else |
| P7 | Table sizes | — | Used to estimate migration lock time |
| A–D | Stale ownership, former members, leads in no queue, unassigned (repair preview) | see that script | Decide on repair separately; repair scripts stay `ROLLBACK` |
| F | Duplicate emails (repair preview) | 0 rows | **Stop**: `20261002`'s unique index would fail |

### Production configuration to confirm, names only

From the Railway dashboard (or `railway variables`), confirm without copying values
anywhere:
- `NODE_ENV=production`;
- `CORS_ORIGINS` includes the web origin, plus `https://localhost` for the APK;
- `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` are set and differ (the API refuses to
  start otherwise);
- `DATABASE_URL` points at the production database;
- `WORKER_ENABLED` is true on the worker service only.

## 3. Migrating without a verified backup

You have deferred the backup. Here is what that means, so the risk is a decision and
not an accident:

| Migration | Changes data? | Failure mode | Undo |
|---|---|---|---|
| `20261002` unique email index | No | Fails if duplicates exist (P1/F catch it); all-or-nothing | `DROP INDEX` |
| `20261013` columns, tables, CHECKs | No | Lock-wait timeout → rolls back completely | Forward-only once used |
| `20261023` nullable outcome columns | No | Lock wait | Drop columns |
| `20261024090000` enum values | No | — | None needed (cannot drop enum values) |
| `20261024091000` new table | No | Lock wait | `DROP TABLE` (loses uploaded files) |

No migration deletes or rewrites existing rows, so the migrations themselves are
unlikely to lose data. The real exposure is everything afterwards. Once the new code
writes data (outcomes, attachments, reassignments), there's no restore point if a
defect damages records, and the only rollback is forward-fixing in code.

Recovery options, in order of preference:

1. **Take a logical backup.** It's free, read-only for production and takes minutes:
   ```bash
   pg_dump --format=custom --no-owner "$DATABASE_URL" -f leadflow-prod-$(date +%Y%m%d-%H%M).dump
   pg_restore --list leadflow-prod-*.dump | head   # proves the file is readable
   ```
   Store it off Railway.
2. **Railway volume backups.** Check in the dashboard whether backups are enabled for
   the Postgres service. Do not assume it.
3. **Code rollback without data restore.** Redeploy the previous Railway deployment.
   Every migration is additive, so `c60e614` runs on the newer schema.
4. **Per-migration undo SQL**, documented in each migration file and in
   `docs/leadflow/sales-lifecycle.md`.

Recommended minimum, if a full backup stays deferred: take option 1 immediately
before merging #11. It is the only one of these that can restore data.
