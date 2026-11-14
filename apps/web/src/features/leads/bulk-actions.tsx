import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LEAD_BULK_LIMIT,
  LEAD_PRIORITIES,
  LEAD_STATUSES,
  type LeadBulkResult,
  type LeadPriority,
  type LeadStatus,
} from '@leadflow/api-types';
import { ApiError, apiGet, apiPost } from '../../lib/api-client';
import { humanise } from '../../lib/format';

/**
 * Which leads a bulk action means.
 *
 *   ids    the rows the person ticked (any page they loaded)
 *   query  every lead matching the current filters, minus rows unticked —
 *          resolved on the server with the person's own visibility
 *
 * `snapshotAt` is when the selection began: a lead changed after it is skipped
 * by the server as a conflict instead of being overwritten.
 */
export type LeadSelection =
  | { mode: 'ids'; ids: Set<string>; snapshotAt: string }
  | { mode: 'query'; excluded: Set<string>; snapshotAt: string };

export function selectionCount(selection: LeadSelection | null, total: number | null): number {
  if (!selection) return 0;
  return selection.mode === 'ids'
    ? selection.ids.size
    : Math.max(0, (total ?? 0) - selection.excluded.size);
}

export function isSelected(selection: LeadSelection | null, id: string): boolean {
  if (!selection) return false;
  return selection.mode === 'ids' ? selection.ids.has(id) : !selection.excluded.has(id);
}

/** Ticks or unticks one row, starting a selection when there is none. */
export function toggleSelection(selection: LeadSelection | null, id: string): LeadSelection | null {
  const now = new Date().toISOString();
  if (!selection) return { mode: 'ids', ids: new Set([id]), snapshotAt: now };
  if (selection.mode === 'ids') {
    const ids = new Set(selection.ids);
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    return ids.size === 0 ? null : { ...selection, ids };
  }
  const excluded = new Set(selection.excluded);
  if (excluded.has(id)) excluded.delete(id);
  else excluded.add(id);
  return { ...selection, excluded };
}

type Action = 'SET_STATUS' | 'SET_PRIORITY' | 'SCHEDULE_FOLLOW_UP' | 'ASSIGN';

const ACTION_LABELS: Record<Action, string> = {
  SET_STATUS: 'Change stage',
  ASSIGN: 'Assign owner',
  SET_PRIORITY: 'Set priority',
  SCHEDULE_FOLLOW_UP: 'Schedule follow-up',
};

/** WON needs a customer and a value per deal, so it is never offered in bulk. */
const BULK_STATUSES = LEAD_STATUSES.filter((s) => s !== 'WON');

/**
 * The bar shown while leads are selected: choose one change, PREVIEW what the
 * server would do to each lead, then apply it to exactly those leads. One
 * request; the server applies the same rules as a single edit.
 */
export function BulkActionBar({
  selection,
  total,
  filters,
  canAssign,
  onClear,
  onSelectAllMatching,
}: {
  selection: LeadSelection;
  total: number | null;
  filters: Record<string, unknown>;
  canAssign: boolean;
  onClear: () => void;
  onSelectAllMatching: () => void;
}): React.JSX.Element {
  const count = selectionCount(selection, total);
  const [action, setAction] = useState<Action | null>(null);
  const matchingTooMany = (total ?? 0) > LEAD_BULK_LIMIT;

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="sticky top-2 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-slate-900 bg-slate-900 px-3 py-2 text-sm text-white shadow-lg"
    >
      <span aria-live="polite" className="font-semibold">
        {count} selected
      </span>
      {selection.mode === 'ids' && total !== null && total > selection.ids.size && (
        <button
          type="button"
          onClick={onSelectAllMatching}
          disabled={matchingTooMany}
          title={
            matchingTooMany ? `Narrow the filters to ${LEAD_BULK_LIMIT} leads or fewer` : undefined
          }
          className="rounded px-2 py-1 text-xs underline decoration-dotted underline-offset-2 hover:bg-white/10 disabled:no-underline disabled:opacity-60"
        >
          {matchingTooMany
            ? `${total} match — narrow to ${LEAD_BULK_LIMIT} to select all`
            : `Select all ${total} matching`}
        </button>
      )}
      <span className="mx-1 hidden h-5 w-px bg-white/20 sm:block" />
      {(['SET_STATUS', 'ASSIGN', 'SET_PRIORITY', 'SCHEDULE_FOLLOW_UP'] as const)
        .filter((a) => a !== 'ASSIGN' || canAssign)
        .map((a) => (
          <button
            key={a}
            type="button"
            onClick={() => setAction(a)}
            className="min-h-9 rounded-lg bg-white/10 px-3 py-1 text-xs font-medium hover:bg-white/20"
          >
            {ACTION_LABELS[a]}
          </button>
        ))}
      <button
        type="button"
        onClick={onClear}
        className="ml-auto rounded px-2 py-1 text-xs hover:bg-white/10"
      >
        Clear
      </button>
      {action && (
        <BulkDialog
          action={action}
          selection={selection}
          count={count}
          filters={filters}
          onClose={(done) => {
            setAction(null);
            if (done) onClear();
          }}
        />
      )}
    </div>
  );
}

function BulkDialog({
  action,
  selection,
  count,
  filters,
  onClose,
}: {
  action: Action;
  selection: LeadSelection;
  count: number;
  filters: Record<string, unknown>;
  onClose: (done: boolean) => void;
}): React.JSX.Element {
  const client = useQueryClient();
  const [status, setStatus] = useState<LeadStatus | ''>('');
  const [priority, setPriority] = useState<LeadPriority | ''>('');
  const [owner, setOwner] = useState('');
  const [when, setWhen] = useState('');
  const [lostReason, setLostReason] = useState('');
  const users = useQuery({
    queryKey: ['leads', 'assignable-users'],
    queryFn: () => apiGet<{ id: string; fullName: string }[]>('/leads/assignable-users'),
    enabled: action === 'ASSIGN',
  });

  /*
   * Preview resolves the selection (ticked rows, or all matching minus the
   * unticked); apply then names exactly the leads that preview listed, with the
   * preview's server-side snapshot, so nothing unreviewed is ever changed.
   */
  const body = (previewed: LeadBulkResult | null): Record<string, unknown> => ({
    dryRun: previewed === null,
    selection: previewed
      ? { ids: previewed.items.map((item) => item.id), snapshotAt: previewed.snapshotAt }
      : selection.mode === 'ids'
        ? { ids: [...selection.ids], snapshotAt: selection.snapshotAt }
        : { query: filters, excludeIds: [...selection.excluded], snapshotAt: selection.snapshotAt },
    ...(action === 'ASSIGN'
      ? { assignedToId: owner }
      : {
          action,
          ...(action === 'SET_STATUS' ? { status } : {}),
          ...(action === 'SET_STATUS' && status === 'LOST'
            ? { lostReason: lostReason.trim() }
            : {}),
          ...(action === 'SET_PRIORITY' ? { priority } : {}),
          ...((action === 'SCHEDULE_FOLLOW_UP' || (action === 'SET_STATUS' && status !== 'LOST')) &&
          when
            ? { nextFollowUpAt: new Date(when).toISOString() }
            : {}),
        }),
  });
  const path = action === 'ASSIGN' ? '/leads/bulk/assign' : '/leads/bulk';
  // One key per preview: applying the same preview twice is applied once.
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const preview = useMutation({
    mutationFn: () => apiPost<LeadBulkResult>(path, body(null)),
    onSuccess: () => setIdempotencyKey(crypto.randomUUID().replace(/-/g, '')),
  });
  const apply = useMutation({
    mutationFn: () =>
      apiPost<LeadBulkResult>(path, body(preview.data!), {
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['leads'] }),
  });

  const ready =
    action === 'SET_STATUS'
      ? status !== '' && (status !== 'LOST' || lostReason.trim().length >= 3)
      : action === 'SET_PRIORITY'
        ? priority !== ''
        : action === 'ASSIGN'
          ? owner !== ''
          : when !== '';
  const result = apply.data ?? preview.data;
  const error = apply.error ?? preview.error;
  const field = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 text-slate-900 sm:items-center sm:p-4"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl">
        <h2 id="bulk-title" className="text-base font-semibold">
          {ACTION_LABELS[action]} · {count} {count === 1 ? 'lead' : 'leads'}
        </h2>
        {!apply.data && (
          <div className="mt-4 space-y-3 text-sm">
            {action === 'SET_STATUS' && (
              <>
                <label className="block">
                  New stage
                  <select
                    value={status}
                    onChange={(e) => {
                      setStatus(e.target.value as LeadStatus);
                      preview.reset();
                    }}
                    className={field}
                  >
                    <option value="">Choose…</option>
                    {BULK_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {humanise(s)}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="text-xs text-slate-500">
                  Won is set one lead at a time, so each win records its customer and value.
                </p>
                {status === 'LOST' && (
                  <label className="block">
                    Why were they lost?
                    <input
                      value={lostReason}
                      onChange={(e) => {
                        setLostReason(e.target.value);
                        preview.reset();
                      }}
                      className={field}
                    />
                  </label>
                )}
              </>
            )}
            {action === 'SET_PRIORITY' && (
              <label className="block">
                Priority
                <select
                  value={priority}
                  onChange={(e) => {
                    setPriority(e.target.value as LeadPriority);
                    preview.reset();
                  }}
                  className={field}
                >
                  <option value="">Choose…</option>
                  {LEAD_PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {humanise(p)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {action === 'ASSIGN' && (
              <label className="block">
                New owner
                <select
                  value={owner}
                  onChange={(e) => {
                    setOwner(e.target.value);
                    preview.reset();
                  }}
                  className={field}
                >
                  <option value="">Choose…</option>
                  {(users.data ?? []).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.fullName}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {(action === 'SCHEDULE_FOLLOW_UP' ||
              (action === 'SET_STATUS' && status !== '' && status !== 'LOST')) && (
              <label className="block">
                {action === 'SCHEDULE_FOLLOW_UP'
                  ? 'Next follow-up'
                  : 'Next follow-up (needed for leads that have none)'}
                <input
                  type="datetime-local"
                  value={when}
                  onChange={(e) => {
                    setWhen(e.target.value);
                    preview.reset();
                  }}
                  className={field}
                />
              </label>
            )}
          </div>
        )}

        {result && <BulkResultView result={result} />}
        {error && (
          <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error instanceof ApiError ? error.message : 'Could not complete the change.'}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onClose(Boolean(apply.data))}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50"
          >
            {apply.data ? 'Done' : 'Cancel'}
          </button>
          {!apply.data &&
            (preview.data && preview.data.summary.willChange > 0 ? (
              <button
                type="button"
                disabled={apply.isPending}
                onClick={() => apply.mutate()}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {apply.isPending ? 'Applying…' : `Apply to ${preview.data.summary.willChange}`}
              </button>
            ) : (
              <button
                type="button"
                disabled={!ready || preview.isPending}
                onClick={() => preview.mutate()}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {preview.isPending ? 'Checking…' : 'Preview changes'}
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}

function BulkResultView({ result }: { result: LeadBulkResult }): React.JSX.Element {
  const s = result.summary;
  const problems = result.items.filter(
    (i) => i.outcome === 'REFUSED' || i.outcome === 'CONFLICT' || i.outcome === 'UNCHANGED',
  );
  return (
    <div className="mt-4 space-y-2 text-sm" aria-label={result.dryRun ? 'Preview' : 'Result'}>
      <p
        className={`rounded-lg px-3 py-2 ${result.dryRun ? 'bg-slate-50 text-slate-800' : 'bg-emerald-50 text-emerald-900'}`}
      >
        {result.dryRun
          ? `${s.willChange} will change`
          : `${s.changed} ${s.changed === 1 ? 'lead' : 'leads'} changed`}
        {s.unchanged ? ` · ${s.unchanged} already set` : ''}
        {s.refused ? ` · ${s.refused} can't change` : ''}
        {s.conflicts ? ` · ${s.conflicts} changed by someone else` : ''}
      </p>
      {problems.length > 0 && (
        <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
          {problems.map((p) => (
            <li key={p.id} className="rounded border border-slate-200 px-2 py-1">
              <span className="font-medium">{p.name ?? 'Lead'}</span>
              <span className="text-slate-500"> — {p.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
