# Production deployment — PR #11 → #12 → #13

Nothing here runs without the owner's explicit approval at each gate. One PR per
deployment; never two at once.

## Status (2026-10-25)

| Gate 0 item | Status |
|---|---|
| 0.1 Read-only preflight | **BLOCKED — admin credentials unavailable.** The `leadflow_preflight` role ([`preflight-role.sql`](./preflight-role.sql)) is reviewed and tested but not created; creating it needs the Railway `postgres` password. No credential was reset, rotated or changed. |
| 0.2 Backup | Procedure verified locally; production backup not taken (owner decision pending). |
| 0.3 Baseline probes | Production answers "Before" on every probe. |
| 0.4 CI | 5/5 green on #11 `e9b004b`, #12 `aa77731`, #13 `4fbe945`; all three CLEAN. |
| 0.5 Log watcher | Owner to arrange. |

### Upgrade rehearsal (local PostgreSQL 17, no production contact)

A database at production's level (`c60e614`), seeded with leads, follow-ups,
activities and users, was upgraded the way Railway will do it:

| Stage | Result |
|---|---|
| #11 migrations (`prisma migrate deploy`) | 7.1 s; every row count preserved; `--after=11` no STOP |
| #11 code on it | API smoke 9/9, including `/leads/import/batches` |
| Rollback: `c60e614` code on the post-#11 schema | 8/8 |
| #12 migrations | 5.9 s; every existing row count preserved; `--after=12` no STOP |
| Final code (#13 `4fbe945`) on the post-#12 schema | 12/12, including `/workspace/summary`, attachments, overdue queue |
| Rollback: #11 code on the post-#12 schema | 9/9 |
| Rollback: `c60e614` code on the post-#12 schema | 8/8 |

Every smoke includes a real write cycle (create a lead, add a note, archive it).

**Known schema drift (P2, not a blocker).** `prisma migrate diff` reports 8 items
after the upgrade, all from #11's `20261013090000` migration: foreign-key
`ON UPDATE` actions, the sort direction of one index, and two indexes
(`leads_import_batch_idx`, `leads_org_deactivated_idx`) that the migration makes
partial while `schema.prisma` declares them plain `@@index`. The drift is
identical on a fresh database and on the upgraded one, and the behaviour is the
same. Align `schema.prisma` in a later PR; never edit the applied migration.

## How production deploys (verified 2026-10-25)

| Fact | Evidence |
|---|---|
| Railway **auto-deploys every push to `main`** | Merge `c60e614` at 15:09:38 UTC → Railway deployment record 15:09:43 UTC (GitHub deployments API, `railway-app[bot]`) |
| Migrations run in a **separate migration-runner service**, also auto-deployed from `main`, running `prisma migrate deploy` from **its own new build** | Commits `cc32d0a` / `d909b89`: the runner reran an old image ("No pending migrations") until a new build existed |
| The API image does **not** migrate | `infrastructure/deployment/Dockerfile` → `CMD node apps/api/dist/main.js` |
| The API and the runner deploy **in parallel**, so new API code can start seconds before its migrations finish | Two independent services; Railway does not order them |
| Changing a Railway **variable** redeploys that service at the **same** commit | Railway behaviour; no new migrations run |

Confirm in the Railway dashboard before step 1 (not visible from the repository):
1. the migration runner's start command is `prisma migrate deploy` (or `npm run db:migrate:deploy`);
2. Auto Deploy is on for the API, the worker and the runner;
3. the runner uses the **direct** (unpooled) database URL.

**Merge method: "Create a merge commit".** Not squash. PR #12 is based on #11's
branch, and #13 on #12's. A squash rewrites history and makes the next PR's diff
re-include the previous PR.

## Gate 0 — before the first merge

| # | Check | Command | Pass |
|---|---|---|---|
| 0.1 | Read-only preflight | `PREFLIGHT_DATABASE_URL=… node scripts/production-preflight.mjs` | Exit 0, **no STOP** |
| 0.2 | Backup taken **and verified** (or risk explicitly accepted in writing) | see "Backup" below | `RESTORE VERIFIED` |
| 0.3 | Baseline | `curl -s https://leadflow.cravionventures.com/health` and the probes below | `/health` 200; probes match "Before" |
| 0.4 | CI | `gh pr checks 11` | 5/5 SUCCESS at `e9b004b` |
| 0.5 | Someone can watch Railway logs for 30 minutes | — | — |

### Backup (verified procedure)

Proven end to end on 2026-10-25 against PostgreSQL 17:
- 40 tables and 577 rows restored identically;
- a deliberately damaged restore was rejected.

Use client tools **of the production server's major version or newer**. The
preflight prints `server_version` as P0b; locally, `C:\Program Files\PostgreSQL\17\bin`
is 17.11.

```bash
# 1. Dump. Read-only for production; takes only ACCESS SHARE locks.
pg_dump --format=custom --no-owner --no-privileges \
        --file=leadflow-prod-$(date +%Y%m%d-%H%M).dump "$PROD_DATABASE_URL"

# 2. Archive is readable; record its fingerprint.
pg_restore --list leadflow-prod-*.dump | grep -c "TABLE DATA"
sha256sum leadflow-prod-*.dump

# 3. Restore into a scratch LOCAL database (never production).
createdb leadflow_restore_check
pg_restore --no-owner --no-privileges --exit-on-error -d leadflow_restore_check leadflow-prod-*.dump

# 4. Prove it: exact row counts of every table and the migration history.
#    The source is only read.
SOURCE_DATABASE_URL="$PROD_DATABASE_URL" \
RESTORED_DATABASE_URL=postgresql://…/leadflow_restore_check \
node scripts/verify-restore.mjs        # must print RESTORE VERIFIED
```

Run steps 1 and 4 back to back. Rows written in between show up as small
differences in busy tables. If that happens, repeat the comparison during a quiet
moment.

Store the dump off Railway, in two places, with its SHA-256. The dump contains
customer data, so treat it as such.

### Probes (read-only, unauthenticated)

```bash
P=https://leadflow.cravionventures.com/api/v1
for u in leads leads/import/batches workspace/summary leads/00000000-0000-7000-8000-000000000000/attachments; do
  echo "$u $(curl -s -o /dev/null -w '%{http_code}' $P/$u)"; done
```

| Route | Before | After #11 | After #12 / #13 |
|---|---|---|---|
| `leads` | 401 | 401 | 401 |
| `leads/import/batches` | 404 | **401** | 401 |
| `workspace/summary` | 404 | 404 | **401** |
| `leads/{id}/attachments` | 404 | 404 | **401** |

#13 has no new route. Check its web bundle instead:

```bash
E=$(curl -s https://leadflow.cravionventures.com/ | grep -o 'assets/index-[^"]*\.js' | head -1)
curl -s https://leadflow.cravionventures.com/$E | grep -c "Waiting for connection"   # 0 before #13, 1 after
```

## Step 1 — PR #11 (stabilization; migrations 20261002, 20261013)

1. **Owner approves the merge.** Merge #11 with a merge commit.
2. Watch, within 10 minutes:
   - a new Railway deployment record for the merge SHA
     (`gh api repos/rajnandini1122-cell/LeadFlow/deployments?per_page=3`), status `success`;
   - the runner log shows both migrations applied, then
     "All migrations have been successfully applied";
   - `/health` is 200 with a small `uptime` (the new process);
   - the probes match "After #11".
3. `PREFLIGHT_DATABASE_URL=… node scripts/production-preflight.mjs --after=11` → exit 0.
4. Smoke test in the web app (owner account): sign in, My work loads, open a lead,
   log one real call outcome, reschedule one follow-up, and check the queue counts
   move.

**STOP conditions.** Do not continue; consider rollback.
- **The runner log shows a failed migration.** `20261002` aborts on duplicate emails
  (preflight F should have caught it); `20261013` can time out on a lock and rolls
  back fully. Prisma then refuses further deploys until the failure is resolved
  (`prisma migrate resolve`), which needs a separate approval.
- **`/health` isn't 200 within 10 minutes,** or the API restarts repeatedly.
- **5xx errors continue after the runner reports success.** A burst *before* it
  reports success is the expected parallel-deploy window. Wait for the runner.
- **Sign-in fails,** queues are empty when they shouldn't be, or counts don't move
  after an action.
- **The `--after=11` preflight reports STOP.**

**Rollback.**
- In Railway, redeploy the API's previous deployment (`c60e614`), then the
  worker's.
- The schema stays. Every migration is additive, and the old code runs on it.
- Restore the database from the backup only if data is damaged, and only with
  approval.

## Step 2 — PR #12 (sales workspace; migrations 20261023, 20261024090000, 20261024091000)

1. Retarget and refresh. **Owner approves the merge.**
   ```bash
   gh pr edit 12 --base main
   gh pr view 12 --json files --jq '.files[].path'   # only #12's changes
   ```
   GitHub may also retarget it automatically when #11's branch is deleted.
2. Wait for CI to pass 5/5 on the retargeted PR, then merge it with a merge commit.
3. Watch exactly as in step 1. The runner applies three migrations. The enum
   migration (`20261024090000`) runs outside a transaction by design.
4. Run `--after=12` → exit 0. Check the probes show "After #12".
5. Smoke test:
   - open My work and check the tile counts against the lists;
   - log an outcome and check it moves the lead to the right queue;
   - attach a small PDF to a test lead as a quotation, marked sent, and check the
     stage becomes Quotation sent;
   - remove that file.

STOP and rollback are the same as step 1. The previous deployment is the #11 merge.

## Step 3 — production CORS for the Android app (configuration only)

Read the API service's current `CORS_ORIGINS` in Railway. Today it allows the web
origin `https://leadflow.cravionventures.com`, and none of the other origins
probed. Then append the app's WebView origin, **keeping every existing value**:

```
CORS_ORIGINS=<current value>,https://localhost
```

The value is comma-separated, spaces are trimmed, and matching is exact (scheme
and host, no trailing slash). `https://localhost` is the origin the app's pages
run under on the phone. Verified on the device: the app sends
`Origin: https://localhost`. The **API it calls** remains
`https://leadflow.cravionventures.com`. Saving redeploys the API at the same
commit.

Check:

```bash
for o in https://leadflow.cravionventures.com https://localhost; do
  curl -s -D - -o /dev/null -X OPTIONS -H "Origin: $o" -H "Access-Control-Request-Method: POST" \
    https://leadflow.cravionventures.com/api/v1/auth/login | grep -i '^access-control-allow-origin'; done
# both lines must echo their own origin; the web app must still sign in
```

**STOP** if the web origin is no longer echoed. Restore the previous value.

## Step 4 — PR #13 (Android and web fixes; no migrations)

1. `gh pr ready 13`, then `gh pr edit 13 --base main`.
2. Wait for CI 5/5. **Owner approves**, then merge with a merge commit.
3. The runner should log "No pending migrations to apply". `/health` returns 200,
   and the bundle probe returns 1.
4. Smoke test: My work, an outcome, the offline banner (switch a laptop's Wi-Fi off
   for a moment), sign-out and sign-in.

## Step 5 — signed Android APK (after step 4)

1. Create the release key (`docs/android.md`, "Release signing"). Keep it outside
   the repository and back it up in two places.
2. Build:
   ```bash
   VITE_API_BASE_URL=https://leadflow.cravionventures.com npm run android:release -w apps/web
   ```
   It runs with the four `LEADFLOW_UPLOAD_*` variables set. Check:
   - `apkanalyzer files cat --file /assets/public/build-info.json` shows
     `apiOrigin: https://leadflow.cravionventures.com` and a clean `sourceCommit`;
   - `apksigner verify --print-certs` shows the release certificate.
3. **Real-device test** on at least one physical Android phone. Uninstall any old
   LeadFlow first, because the signing identity changes. Then:
   - sign in;
   - My work counts match the web;
   - Call opens the dialer;
   - log an outcome;
   - reschedule;
   - attach a photo and a PDF;
   - Back button;
   - force-close and reopen (still signed in);
   - airplane mode during a save;
   - sign out.
4. Distribute only after that passes and the owner approves. `npm run android:publish`
   refuses an APK that has no API address, points at this machine, or doesn't raise
   the version code.
