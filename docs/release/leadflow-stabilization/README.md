# LeadFlow stabilization — release notes and runbook

Prepared 2026-10-21. **Nothing here has been pushed, deployed or run against production.**

Railway auto-deploys LeadFlow from GitHub `main`, with a separate migration-runner
service (see commit `d909b89`). **Merging to `main` is a production deploy and runs
migrations.** Every step below that touches GitHub or production needs explicit approval.

## Two branches, in the order they should ship

| Branch | Base | Commits | Migrations | What it fixes |
|---|---|---|---|---|
| `hotfix/followup-request-body` | `main` @ `d909b89` (= production) | `87dabc0`, `de444fc` | none | **Critical.** Every Complete and Reschedule submitted from a dialog is rejected today. |
| `release/leadflow-stabilization` | `feat/intake-hardening-and-traceability` @ `7c49470` | `35f2440`, `4ad9ad0`, `ee6fce3`, `c359e4e`, `4edece8` + docs | 2 (from the base branch) | Everything below, plus the 7 unreleased base-branch commits. |

The hotfix is web-only and independent. Shipping it first ends the production outage of
Complete/Reschedule without waiting for migrations. The release branch already contains the
same fix. Verified with `git merge-tree`: exactly one textual conflict, in
`apps/web/src/features/leads/use-lead-mutations.ts` — take the release side. The hotfix test asserts URL and body only, so it passes against both implementations (checked).

## Production baseline (read-only evidence)

Production runs `main` @ `d909b89`, migrations through `20260930090000`:

- Routes added only by the 7 base-branch commits return **404** in production
  (`/leads/import/batches`, `/leads/import/mappings`, `/leads/:id/attempts`,
  `/leads/:id/deactivate`, `/integrations/admin-control/leads`), while routes on `main` return
  **401**. A control path returns 404.
- Process uptime at 2026-10-21 04:24 UTC was 1,711,000 s, i.e. a start at about 2026-10-01 10:38 IST,
  about 1h45m after `d909b89` (an empty commit made to trigger the migration runner).
- `origin/main` = local `main` = `d909b89`. The base branch is **not on GitHub**.

This is strong inference, not proof. Railway's deployment record is the proof (see blockers).

## What the release branch changes

| Commit | Change |
|---|---|
| `35f2440` | Reassignment moves the previous owner's open follow-ups to the new owner, and gives a newly assigned lead a queue row at its existing date. Not Answered, Schedule, Complete and Reschedule each run as one transaction, hold the lead's row lock, and accept an `Idempotency-Key` (a replay returns the original result). `GET /leads?unassigned=true`. |
| `4ad9ad0` | Web: no `leadId` in request bodies (the critical bug), datetime inputs in the organization timezone, one key per dialog opening, **No answer** in the queue, reschedule presets, "Unassigned only" filter, "200+" counts. |
| `ee6fce3` | Customer-account follow-ups: a retried Complete/Reschedule returns the first result instead of 409 (keyed via an attributed audit entry, 24 h window), and queue/daily-report rows link to `/customers/:id` instead of `/leads/null`. |
| `c359e4e` | Deterministic race tests (row locks held from a second connection). They fail on `7c49470` and pass here. |
| `4edece8` | Migration `20261013` wrapped in `BEGIN/COMMIT` with `lock_timeout = 5s` (see below). |

There is no schema change in any stabilization commit.

## Migrations (both come from the base branch; neither is applied in production)

`prisma migrate deploy` does **not** wrap a migration in a transaction. This was verified: a
failing statement left the earlier ones applied, and Prisma then refused further deploys (P3018).

| Migration | What it does | Can it fail? | Locks (measured, PG 17, 200,000 leads / 123 MB) | Old code compatible | Rollback |
|---|---|---|---|---|---|
| `20261002090000_lead_email_duplicate_guard` | One `CREATE UNIQUE INDEX` on `(organization_id, lower(email))` | **Yes**, if two live, unacknowledged leads share an email (any case). Single statement, so all-or-nothing. | SHARE (blocks writes, reads continue): 0.49 s | Yes | `DROP INDEX leads_org_email_uniq` |
| `20261013090000_lead_address_deactivation_import_batches` | Nullable columns, widened CHECKs, drop/re-create both duplicate indexes, 2 new tables | Not on data. Can fail on a lock wait (5 s timeout), and then **rolls back completely**. | Wrapped: `leads` locked for reads and writes for **2.2 s** in total | Yes: new columns are nullable and CHECKs only widen | Before use: drop the added columns, tables and constraints, then restore the old CHECK and indexes. Once deactivation or import batches hold data, rolling back loses that data. Treat this as forward-only. |

Rehearsed against real PostgreSQL 17 from production's schema, with `leads` held by another
session: `20261013` timed out and rolled back fully, with both duplicate indexes intact and no new
columns or tables. Then `prisma migrate resolve --rolled-back 20261013090000_lead_address_deactivation_import_batches`
and a redeploy applied it cleanly, with all rows intact and `migrate status` up to date.

**Encoding:** `20261002` contains a non-ASCII character (⚠️) in a comment. It fails on a database
whose encoding is not UTF-8. This was observed on a local WIN1252 cluster. Check production's
encoding (step 3 below).

## Data-repair files (none executed)

- `01-repair-preview.sql`: read-only, inside a `READ ONLY` transaction that is rolled back. It reports:
  - **A.** follow-ups owed by a lead's previous owner (proven from `lead.assigned` audit entries);
  - **B.** follow-ups owed by members who are no longer active;
  - **C.** assigned, dated leads with no queue row;
  - **D.** unassigned live leads;
  - **E.** a sanity check of the CHECK constraint;
  - **F.** the duplicate-email preflight for `20261002`.

  It returns ids and lead numbers only, never names, phones or emails. It is written for
  production's current schema.
- `02-repair-apply.DRAFT.sql`: repairs A and C only, logging every change to
  `repair_20261021_follow_ups`. **It ends in `ROLLBACK`**, so a person must change it to `COMMIT`.
  B and D are left to managers in the app.
- `03-repair-undo.DRAFT.sql`: reverses exactly the logged rows. Created follow-ups are
  cancelled, never deleted.

All three were validated on a PostgreSQL database migrated to production's schema, with one
planted case of each defect. The preview counted A=1, B=1, C=1, D=1, E=0, and F found the
case-insensitive duplicate. Apply as written changed nothing. Apply committed repaired A and C,
and the preview then showed 0. Undo committed restored every original row exactly. Inside the
read-only transaction, PostgreSQL refused a write.

## Test evidence (all on this machine, 2026-10-21)

| Run | Release `release/leadflow-stabilization` | Hotfix `hotfix/followup-request-body` |
|---|---|---|
| API e2e, **real PostgreSQL 17.10** (`CI_USE_EXTERNAL_DB=1`, as CI runs it) | 67/67 suites, 1,752 passed, 0 failed, **0 skipped** — on the final tip `4edece8` | 62/62 suites, 1,541 passed, 0 failed, 0 skipped |
| API e2e, PGlite | 67/67 suites, 1,743 passed, 7 skipped (real-PG-only) | 4/4 new contract tests |
| API unit (CI environment values) | 52/52 suites, 1,261 passed | 49/49 suites, 1,154 passed |
| Web (vitest) | 509 tests; 1 timing flake in `register-validation.test.tsx` under heavy load (untouched file, 3/3 on rerun) | 37 files, 432 passed |
| Typecheck, lint, production build | pass | pass |

The race tests were proven to discriminate on real PostgreSQL:

| Test | Result on this branch | Result on `7c49470` |
|---|---|---|
| "never overwrites a follow-up completed while 'no answer' was in flight" | passes 2/2 | fails 2/2 (`Received: "CANCELLED"`) |
| "logs 'no answer' only once it holds the lead" | passes 2/2 | fails 2/2 |
| "completes a follow-up only once it holds the lead" | passes 2/2 | fails 2/2 |
| "records ONE attempt when the same key arrives twice at once" | passes | fails 2/2 |
| "two agents reschedule at once" | passes | fails 1/2 |

The last one is timing-dependent, so it is a smoke test, not proof. The old `Promise.all`
"attempt races a completion" test passed on the pre-fix code 3/3 and was replaced.

## Runbook — each step needs approval

1. **Push** `hotfix/followup-request-body`, open a PR to `main`, and let CI pass (the e2e job runs on real PostgreSQL).
2. **Confirm the baseline** in Railway: the deployed commit for the API, worker and migration runner should be `d909b89`.
3. **Read-only checks on production:**
   - `SHOW server_encoding;` must return `UTF8`;
   - run `01-repair-preview.sql` and record the counts.
4. **Merge the hotfix**, which deploys it. Verify:
   - the new web bundle is served;
   - Complete and Reschedule work on a test organization.
5. **Push** `release/leadflow-stabilization` and open a PR to `main`. CI must pass, including the 5 real-PostgreSQL race tests.
6. **Before merging the release:**
   - section F of the preview must return no rows (otherwise resolve the duplicate emails in the app first);
   - take a backup or point-in-time-recovery marker;
   - choose a low-traffic window, because `leads` is locked for about 2 s.
7. **Merge the release.** Watch the migration runner: `20261002` and then `20261013` should apply, and `migrate status` should be clean. If `20261013` reports a lock timeout, nothing was applied. Run `migrate resolve --rolled-back …` and redeploy.
8. **Post-deploy:** health, readiness, logs, the deployed SHA, then the operator acceptance checklist.
9. **Data repair:** only after review of the preview counts and with written approval. Use 02 changed to `COMMIT`; 03 is the undo.

## Blockers to deployment

- No Railway access from this machine (no CLI, no token), so the deployed SHA can't be confirmed (step 2).
- No GitHub push credentials (`git ls-remote` works read-only; the base branch is local-only).
- The race tests have run on a local real PostgreSQL but not yet on CI. That needs step 5.
- The preview counts and encoding (step 3) need read-only production database access.
