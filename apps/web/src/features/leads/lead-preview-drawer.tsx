import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { formatDateTime, formatRelative, humanise, telHref } from '../../lib/format';
import { DueBadge, PriorityBadge, StatusBadge } from '../../components/ui';
import { useLead } from './use-leads';

/**
 * A side panel with the lead's essentials, so a rep can check a lead without
 * leaving the list: contact, stage, owner, next action and recent history.
 * ↑ / ↓ move to the previous / next lead in the list; Esc closes.
 */
export function LeadPreviewDrawer({
  leadId,
  onClose,
  onPrevious,
  onNext,
}: {
  leadId: string;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
}): React.JSX.Element {
  const lead = useLead(leadId);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowUp' && onPrevious) onPrevious();
      if (e.key === 'ArrowDown' && onNext) onNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onPrevious, onNext]);

  const d = lead.data;
  const tel = d ? telHref(d.primaryContact?.mobile ?? d.mobile) : null;

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-label="Lead preview"
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-slate-200 bg-white shadow-2xl"
    >
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
        <button
          type="button"
          onClick={onPrevious}
          disabled={!onPrevious}
          aria-label="Previous lead"
          className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!onNext}
          aria-label="Next lead"
          className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30"
        >
          ↓
        </button>
        <span className="flex-1" />
        <Link
          to={`/leads/${leadId}`}
          className="rounded-lg px-3 py-1.5 text-xs font-medium text-sky-700 hover:bg-sky-50"
        >
          Open full page
        </Link>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close preview"
          className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto p-5 text-sm">
        {lead.isPending && <p className="text-slate-500">Loading…</p>}
        {lead.isError && <p className="text-red-700">This lead could not be loaded.</p>}
        {d && (
          <>
            <div>
              <h2 className="text-lg font-semibold text-slate-900">{d.name}</h2>
              <p className="text-slate-500">{d.companyName ?? d.leadNumber}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <StatusBadge status={d.status} />
                <PriorityBadge priority={d.priority} />
              </div>
            </div>

            <section aria-label="Next action" className="rounded-lg border border-slate-200 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Next action
              </p>
              {d.nextAction ? (
                <>
                  <p
                    className={`mt-1 font-medium ${d.nextAction.isOverdue ? 'text-red-700' : 'text-slate-900'}`}
                  >
                    {d.nextAction.title ?? humanise(d.nextAction.type)}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <DueBadge
                      iso={d.nextAction.scheduledAt}
                      label={formatRelative(d.nextAction.scheduledAt)}
                    />
                    <span className="text-xs text-slate-500">
                      {formatDateTime(d.nextAction.scheduledAt)}
                    </span>
                  </div>
                </>
              ) : (
                <p className="mt-1 text-amber-700">
                  {d.status === 'WON' || d.status === 'LOST'
                    ? 'Closed'
                    : 'No next action scheduled'}
                </p>
              )}
            </section>

            <section aria-label="Contact" className="space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Contact
              </p>
              {d.primaryContact && (
                <p className="font-medium text-slate-800">{d.primaryContact.name}</p>
              )}
              {(d.primaryContact?.mobile ?? d.mobile) && (
                <p>
                  {tel ? (
                    <a href={tel} className="text-sky-700 underline">
                      {d.primaryContact?.mobile ?? d.mobile}
                    </a>
                  ) : (
                    (d.primaryContact?.mobile ?? d.mobile)
                  )}
                </p>
              )}
              {d.email && <p className="break-all text-slate-700">{d.email}</p>}
              {[d.city, d.state, d.country].filter(Boolean).length > 0 && (
                <p className="text-slate-500">
                  {[d.city, d.state, d.country].filter(Boolean).join(', ')}
                </p>
              )}
              <p className="text-slate-500">Owner: {d.assignedTo?.fullName ?? 'Unassigned'}</p>
            </section>

            <section aria-label="Recent activity">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Recent activity
              </p>
              {d.activities.length === 0 ? (
                <p className="mt-1 text-slate-500">Nothing yet.</p>
              ) : (
                <ol className="mt-2 space-y-2 border-l border-slate-200 pl-3">
                  {d.activities.slice(0, 8).map((a) => (
                    <li key={a.id}>
                      <p className="text-slate-800">{a.description ?? humanise(a.type)}</p>
                      <p className="text-xs text-slate-400">
                        {formatRelative(a.createdAt)}
                        {a.performedBy ? ` · ${a.performedBy.fullName}` : ''}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
