# LeadFlow — sales lifecycle, call outcomes and the sales workspace

Branch `feat/leadflow-sales-workspace`, stacked on `release/leadflow-stabilization`.
Written 2026-10-24. **Nothing here has been deployed or run against production.**

## 1. Assessment (Phase 0)

### Architecture

| Layer | What it is |
|---|---|
| API | NestJS 11, `apps/api`. Every lead and follow-up write goes through `FollowUpsService` and `LeadMutationsService`. |
| Data | PostgreSQL through Prisma 7. Tenant scoping is applied to reads by a Prisma extension. Follow-ups are rows; `leads.next_follow_up_at` mirrors the earliest open follow-up, and a CHECK constraint (`leads_active_requires_followup`) requires one on every open lead. |
| Worker | Same image with `WORKER_ENABLED=true`; it flips `UPCOMING → DUE → OVERDUE` and sends reminders. It is not changed here. |
| Web | React 19 + TanStack Query, `apps/web`, served by the API. Display uses the organization timezone (`lib/format.ts`); input is read in the organization timezone (`lib/zoned-input.ts`, added in the stabilization branch). |
| Deploy | Railway auto-deploys GitHub `main` (API, worker, migration runner). |

### Confirmed defects addressed by this branch

| # | Defect | Where | Root cause |
|---|---|---|---|
| L1 | "No answer" on the **Complete** dialog completed the follow-up. A missed call left every queue and counted as work done. | `lead-dialogs.tsx` `OUTCOMES` | Outcome was free text on the *completion* path; nothing distinguished an attempt from a result. |
| L2 | **Call** logged "call completed" when the dial button was pressed, before anyone answered. | `lead-detail-page.tsx` `QuickActions` | Logging was attached to the tel: link. "Contacted" therefore meant "somebody pressed a button". |
| L3 | No structured outcome, so "who didn't answer?", "who is awaiting a response?" and "when did we last speak?" were unanswerable. | schema | No columns, no rules. |
| L4 | The Completed tab sorted by **scheduled** time, oldest first, with a 200-row limit, so the newest completions were cut off. | `follow-ups.repository.ts` `list` | A single `orderBy: scheduledAt asc` was used for every bucket. |
| L5 | Tab counts were the length of a capped page ("200" for 340). The stabilization branch showed "200+"; this branch shows true totals. | `follow-ups-page.tsx` | There was no count endpoint. |
| L6 | The reschedule timeline entry was `Rescheduled to 2026-10-24T05:30:00.000Z`: a UTC ISO string with no starting point. | `follow-ups.repository.ts` | The description was built from `toISOString()`. |
| L7 | A rescheduled follow-up was displayed as "Cancelled". | `lead-detail-page.tsx` | `rescheduledToId` was never exposed. |
| L8 | The lead list showed a name and a stage only, with no last contact, next action or actions. | `leads-page.tsx` | The summary contract had no such fields. |

The earlier stabilization defects (reassignment, idempotency, per-lead locking, timezone input, customer
follow-ups) are fixed on the base branch; see `docs/release/leadflow-stabilization/README.md`.

### Decisions and assumptions

- **`FOLLOW_UP` stays a stage**, for compatibility with existing data. It is no longer set by anything
  operational: scheduling, missed calls and reschedules never move the stage. (Nothing in the codebase set it
  automatically before this change either.)
- **Due Today and Overdue are derived** from `scheduledAt` against the organization timezone, not stored.
  **Rescheduled** is `CANCELLED` + `rescheduledToId` (auditable chain), displayed as "Rescheduled".
- **Overdue and Today are disjoint**: earlier-today work is Overdue. Tomorrow and This week are filters
  *inside* Upcoming. This avoids double-counting the day's work.
- **"Not interested" / "No current requirement" keep a next action by default** (+90 / +30 days),
  because an open lead must have one (DB constraint). Closing as Lost is the explicit alternative.
- **Quotations and samples** use existing structures (stage `QUOTATION_SENT`/`NEGOTIATION`, the last
  outcome). No new commercial module was introduced.
- **No backfill** of `last_contacted_at`: historical "call completed" entries were written on dial clicks
  (L2) and are not evidence of contact.

## 2. Lifecycle specification

### Sales stages (unchanged set; new movement rules)

`NEW → CONTACTED → QUALIFIED → (FOLLOW_UP) → QUOTATION_SENT → NEGOTIATION → WON | LOST`

| Rule | Enforced in |
|---|---|
| Moves only forward through a call outcome; never backwards. | `FollowUpsService.recordOutcome` |
| The first *reached* outcome moves `NEW → CONTACTED`. | same |
| `QUALIFIED` only through an explicit "Mark qualified", on an outcome that allows it, from `NEW`/`CONTACTED`/`FOLLOW_UP`. | same |
| `LOST` through "close", only on an outcome that offers it, with a reason. | same + `leads.lost_reason` |
| WON is final; LOST reopens only to an active stage (existing rule). | `lead-status.ts` |
| A missed call, a retry or a reschedule never changes the stage. | same; asserted in tests |

### Call outcomes (`packages/api-types/src/call-outcomes.ts`, one table for API and web)

| Outcome | Reached | Worked follow-up | Default next | Requirement | Qualify | Close |
|---|---|---|---|---|---|---|
| Connected — requirement available | yes | completed | +2 days | ✓ | ✓ | |
| Interested — sample requested | yes | completed | +3 days | ✓ | ✓ | |
| Interested — quotation requested | yes | completed | +1 day | ✓ | ✓ | |
| Awaiting customer response | yes | completed | +3 days | | | |
| Connected — call back later | yes | completed | +1 day | | | |
| Connected — no current requirement | yes | completed | +30 days | | | ✓ |
| Not interested | yes | completed | +90 days | | | ✓ |
| Not answered | no | **retry** | +2 h | | | |
| Busy | no | **retry** | +1 h | | | |
| Switched off / unreachable | no | **retry** | +1 day | | | |
| Wrong number | no | **retry** | +1 day | | | ✓ |

**Retry** means the follow-up is superseded by the retry. It is never completed: the work is still owed.
**Completed** means the follow-up is marked done with the outcome. In every case **exactly one** open
follow-up remains afterwards, unless the lead was closed. A *reached* outcome sets `last_contacted_at`;
every outcome sets `last_outcome` and `last_outcome_at`.

### Follow-up states and queue membership (organization timezone; Asia/Kolkata for CRAVION)

| View | Rule |
|---|---|
| Overdue | open, `scheduledAt < now` |
| Today | open, `now ≤ scheduledAt < tomorrow 00:00` |
| Tomorrow | open, within tomorrow's calendar day |
| This week | open, tomorrow 00:00 → next Monday 00:00 (empty on a Sunday) |
| Upcoming | open, `scheduledAt ≥ tomorrow 00:00` |
| Awaiting response | open, lead not closed, and last outcome = Awaiting response **or** stage = Quotation sent |
| Completed / Done today | `COMPLETED`, newest first; Done today = `completedAt` within today |
| New leads | lead `NEW` and never reached (`last_contacted_at` null) |
| Unassigned | lead with no owner; managers only, since it can hold no follow-up row |

One predicate (`bucketWhere`) serves every list, count, dashboard tile and workspace tile.

## 3. UI changes

| Screen | Before | After |
|---|---|---|
| Landing | Dashboard (management overview) | **My work today**: 6–7 clickable tiles, each opening its list |
| Lead list | name, stage, value, due date | last contact + outcome, latest interaction, next action + lateness, owner, priority; Call / Log outcome / Reschedule / History; cards on phones; Work filters |
| Follow-ups | 4 tabs, page-length counts, Complete / No answer | 7 tabs with true totals; Call / **Log outcome** / Reschedule; customer rows keep Complete |
| Lead detail | Call logged on dial; No answer / Call back later; next action = a date | Call opens the outcome dialog; Next action shows what, when, by whom, with controls; Commercial details; "Last spoke" |
| Every save | silent | toast confirmation; errors stay in the dialog |

## 4. API changes (all additive, backward compatible)

| Change | Notes |
|---|---|
| `POST /leads/:id/outcomes` | New. Idempotent (`Idempotency-Key`), one transaction under the lead row lock. |
| `GET /follow-ups/counts`, `GET /workspace/summary` | New. |
| `GET /follow-ups?bucket=` | Adds `tomorrow`, `week`, `awaiting`, `completed_today`. |
| `GET /leads` | Adds `fresh`, `awaiting`, `lastOutcome` filters. Rows add `lastOutcome`, `lastOutcomeAt`, `lastContactedAt`, `latestActivity`, `nextAction`. |
| Follow-up view | Adds `leadLastOutcome`, `leadLastOutcomeAt`, `rescheduledToId`. |
| `POST /leads/:id/attempts` | Unchanged contract; now also records the last outcome. |

## 5. Database

Migration `20261023090000_lead_call_outcomes_and_requirement`:

- five nullable `leads` columns with no default;
- one index `(organization_id, last_outcome, assigned_to)`;
- one transaction with `lock_timeout = 5s`;
- no backfill, no data change.

Drift-checked against `schema.prisma`. **Rollback** (before outcomes are logged, nothing is lost):
`DROP INDEX leads_organization_id_last_outcome_assigned_to_idx`, then `ALTER TABLE leads DROP COLUMN …`
for the five columns. Once outcomes exist, the timeline keeps each call in `lead_activities.metadata` regardless.

Requires the stabilization branch's two migrations first (`20261002…`, `20261013…`). See that branch's runbook
for the duplicate-email preflight and backup requirements.

## 6. Manual acceptance checklist

Use a test organization set to Asia/Kolkata.

1. **Landing:** sign in. You land on *My work today*, the tiles show numbers, and clicking each tile shows a list whose length matches the tile.
2. **Overdue → Not answered:** open an overdue row and choose *Log outcome → Not answered*, retry *In 2 hours*. A toast confirms. Overdue drops by 1 and Today rises by 1. The stage is unchanged. The timeline shows "Not answered". The lead's *Last contact* says "Not reached yet".
3. **Today → Reschedule to tomorrow:** reschedule a follow-up due today at 2 pm to *Tomorrow 11 am*. It leaves Today and appears under Tomorrow and Upcoming. The timeline reads "Rescheduled from … 2:00 pm to … 11:00 am", and the old row shows "Rescheduled". Refresh the page: nothing reverts.
4. **Completing:** log *Connected — call back later* on a NEW lead. The stage becomes Contacted, the follow-up shows Done, exactly one new follow-up exists, and Completed today rises by 1.
5. **Requirement:** log *Connected — requirement available* with product, quantity and date, and tick *Mark qualified*. The stage becomes Qualified, and Commercial details shows all three.
6. **Awaiting:** log *Awaiting customer response*. The lead appears under Awaiting response (workspace tile, Follow-ups tab, Leads → Work filter).
7. **Not interested → close:** choose *Close the lead as Lost*. The lead becomes Lost with reason "Not interested", and no open follow-up remains.
8. **Double-click:** double-click *Save* in the outcome dialog. Exactly one timeline entry is created.
9. **Reassignment:** reassign a lead with a pending follow-up. The new owner sees it in *My work*; the previous owner no longer does.
10. **Counts:** every Follow-ups tab number equals the rows in that tab. The dashboard's overdue count equals the Overdue tab.
11. **Phone width:** *My work*, Leads (cards) and the outcome dialog are usable at 390 px.
