import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LEAD_STATUSES, type LeadBulkResult, type LeadStatus } from '@leadflow/api-types';
import { ApiError, apiPost } from '../../lib/api-client';
import { formatRelative, humanise } from '../../lib/format';
import { PriorityBadge } from '../../components/ui';
import type { LeadSummary } from './use-leads';

/**
 * The pipeline as columns. Moving a card is a real stage change made through
 * the bulk API for that one lead — preview, then apply — so the server's
 * pipeline rules decide, exactly as for any other edit:
 *
 *   Won     opens the lead (a win records its customer and value there)
 *   Lost    asks for the reason first
 *   other   needs a next follow-up if the lead has none; the server says so
 *
 * Drag and drop on desktop; "Move to…" on every card for keyboard and touch.
 */
export function LeadKanban({
  leads,
  counts,
  onOpen,
}: {
  leads: LeadSummary[];
  /** Server totals per stage for the current view (cards show loaded leads). */
  counts: Partial<Record<LeadStatus, number>>;
  onOpen: (id: string) => void;
}): React.JSX.Element {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [dragging, setDragging] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [losing, setLosing] = useState<{ lead: LeadSummary } | null>(null);
  const [reason, setReason] = useState('');

  const move = useMutation({
    mutationFn: async ({
      lead,
      to,
      lostReason,
    }: {
      lead: LeadSummary;
      to: LeadStatus;
      lostReason?: string;
    }) => {
      const params = { action: 'SET_STATUS', status: to, ...(lostReason ? { lostReason } : {}) };
      const preview = await apiPost<LeadBulkResult>('/leads/bulk', {
        ...params,
        dryRun: true,
        selection: { ids: [lead.id], snapshotAt: new Date().toISOString() },
      });
      const item = preview.items[0];
      if (!item || item.outcome !== 'WILL_CHANGE') {
        throw new Error(item?.reason ?? 'This move is not allowed.');
      }
      const result = await apiPost<LeadBulkResult>(
        '/leads/bulk',
        { ...params, selection: { ids: [lead.id], snapshotAt: preview.snapshotAt } },
        { headers: { 'Idempotency-Key': crypto.randomUUID().replace(/-/g, '') } },
      );
      const done = result.items[0];
      if (done?.outcome !== 'CHANGED')
        throw new Error(done?.reason ?? 'The move did not go through.');
      return { lead, to };
    },
    onSuccess: ({ lead, to }) => {
      setMessage({ tone: 'ok', text: `${lead.name} moved to ${humanise(to)}.` });
      void client.invalidateQueries({ queryKey: ['leads'] });
    },
    onError: (error) =>
      setMessage({
        tone: 'error',
        text:
          error instanceof ApiError || error instanceof Error ? error.message : 'The move failed.',
      }),
  });

  const requestMove = (lead: LeadSummary, to: LeadStatus) => {
    setMessage(null);
    if (lead.status === to) return;
    if (to === 'WON') {
      navigate(`/leads/${lead.id}`);
      return;
    }
    if (to === 'LOST') {
      setLosing({ lead });
      setReason('');
      return;
    }
    move.mutate({ lead, to });
  };

  return (
    <div className="space-y-2">
      {message && (
        <p
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={`rounded-lg px-3 py-2 text-sm ${message.tone === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}
        >
          {message.text}
        </p>
      )}
      <div className="flex snap-x gap-3 overflow-x-auto pb-3" aria-label="Pipeline">
        {LEAD_STATUSES.map((stage) => {
          const cards = leads.filter((l) => l.status === stage);
          const closed = stage === 'WON' || stage === 'LOST';
          return (
            <section
              key={stage}
              aria-label={`${humanise(stage)} column`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const lead = leads.find((l) => l.id === dragging);
                setDragging(null);
                if (lead) requestMove(lead, stage);
              }}
              className={`flex w-[85vw] max-w-72 shrink-0 snap-start flex-col rounded-xl sm:w-64 ${closed ? 'bg-slate-100/60' : 'bg-slate-100'}`}
            >
              <header className="flex items-center justify-between px-3 py-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                  {humanise(stage)}
                </h3>
                <span className="rounded-full bg-white px-2 text-xs font-semibold tabular-nums text-slate-700">
                  {counts[stage] ?? cards.length}
                </span>
              </header>
              <ul className="flex min-h-24 flex-col gap-2 px-2 pb-2">
                {cards.map((lead) => (
                  <li
                    key={lead.id}
                    draggable={!closed}
                    onDragStart={() => setDragging(lead.id)}
                    className="rounded-lg bg-white p-2.5 text-sm shadow-sm ring-1 ring-slate-200"
                  >
                    <button
                      type="button"
                      onClick={() => onOpen(lead.id)}
                      className="block w-full text-left"
                    >
                      <span className="block truncate font-medium text-slate-900">{lead.name}</span>
                      <span className="block truncate text-xs text-slate-500">
                        {lead.companyName ?? lead.leadNumber} ·{' '}
                        {lead.assignedTo?.fullName ?? 'Unassigned'}
                      </span>
                    </button>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <PriorityBadge priority={lead.priority} />
                      {lead.nextAction && (
                        <span
                          className={`text-[11px] ${lead.nextAction.isOverdue ? 'font-semibold text-red-700' : 'text-slate-500'}`}
                        >
                          {lead.nextAction.isOverdue ? 'Overdue · ' : ''}
                          {formatRelative(lead.nextAction.scheduledAt)}
                        </span>
                      )}
                    </div>
                    {!closed && (
                      <label className="mt-1.5 block text-[11px] text-slate-500">
                        <span className="sr-only">Move {lead.name} to</span>
                        <select
                          value=""
                          disabled={move.isPending}
                          onChange={(e) =>
                            e.target.value && requestMove(lead, e.target.value as LeadStatus)
                          }
                          className="w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-[11px]"
                        >
                          <option value="">Move to…</option>
                          {LEAD_STATUSES.filter((s) => s !== stage).map((s) => (
                            <option key={s} value={s}>
                              {humanise(s)}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </li>
                ))}
                {cards.length === 0 && (
                  <li className="px-1 py-4 text-center text-xs text-slate-400">No leads here</li>
                )}
              </ul>
            </section>
          );
        })}
      </div>

      {losing && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="lost-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
        >
          <form
            className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl"
            onSubmit={(e) => {
              e.preventDefault();
              move.mutate({ lead: losing.lead, to: 'LOST', lostReason: reason.trim() });
              setLosing(null);
            }}
          >
            <h2 id="lost-title" className="font-semibold">
              Mark {losing.lead.name} as lost
            </h2>
            <label className="mt-3 block text-sm">
              Why was it lost?
              <input
                autoFocus
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setLosing(null)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={reason.trim().length < 3}
                className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50"
              >
                Mark lost
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
