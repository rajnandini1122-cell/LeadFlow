import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDateTime, formatDueDate, formatRelative, humanise, telHref } from '../../lib/format';
import { Avatar, DueBadge, PriorityBadge, StatusBadge } from '../../components/ui';
import { OutcomeBadge } from '../../components/outcome-badge';
import { useAuth } from '../auth/auth-context';
import { RescheduleFollowUpDialog } from './lead-dialogs';
import { LogOutcomeDialog, type LogOutcomeLead } from './log-outcome-dialog';
import type { LeadSummary } from './use-leads';

/**
 * A lead list a salesperson can WORK from.
 *
 * The old row showed a name and a stage, so "what happened last, and what do I
 * do next?" meant opening every lead. Each row now answers both — last contact
 * and its outcome, the latest interaction, the next action and whether it is
 * late — with the actions that move it on, without leaving the list.
 *
 * Desktop: a dense table-like grid. Phone: one card per lead, actions below.
 */
export function ActionableLeadList({ leads }: { leads: LeadSummary[] }): React.JSX.Element {
  const { can } = useAuth();
  const [logging, setLogging] = useState<{ lead: LogOutcomeLead; followUpId?: string } | null>(null);
  const [rescheduling, setRescheduling] = useState<{
    id: string;
    leadId: string;
    scheduledAt: string;
    leadName: string;
  } | null>(null);

  return (
    <>
      {/* Column headings — desktop only; cards carry their own labels. */}
      <div
        aria-hidden
        className="hidden border-b border-slate-100 px-5 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400 lg:grid lg:grid-cols-[minmax(0,2fr)_minmax(0,1.6fr)_minmax(0,1.6fr)_minmax(0,1.5fr)_auto] lg:gap-4"
      >
        <span>Lead</span>
        <span>Last contact</span>
        <span>Latest interaction</span>
        <span>Next action</span>
        <span className="text-right">Actions</span>
      </div>

      <ul className="divide-y divide-slate-100">
        {leads.map((lead) => (
          <ActionableLeadRow
            key={lead.id}
            lead={lead}
            canLogOutcome={can('lead.update')}
            canReschedule={can('followup.create')}
            onLogOutcome={() =>
              setLogging({
                lead: { id: lead.id, name: lead.name, status: lead.status },
                ...(lead.nextAction ? { followUpId: lead.nextAction.followUpId } : {}),
              })
            }
            onReschedule={() =>
              lead.nextAction &&
              setRescheduling({
                id: lead.nextAction.followUpId,
                leadId: lead.id,
                scheduledAt: lead.nextAction.scheduledAt,
                leadName: lead.name,
              })
            }
          />
        ))}
      </ul>

      {logging && (
        <LogOutcomeDialog lead={logging.lead} followUpId={logging.followUpId} open onClose={() => setLogging(null)} />
      )}
      <RescheduleFollowUpDialog followUp={rescheduling} open={rescheduling !== null} onClose={() => setRescheduling(null)} />
    </>
  );
}

/** What the agent should do next, in words — derived, never stored. */
export function nextActionText(lead: LeadSummary): { text: string; tone: 'danger' | 'warning' | 'muted' | 'default' } {
  if (lead.status === 'WON' || lead.status === 'LOST') return { text: `Closed — ${humanise(lead.status)}`, tone: 'muted' };
  if (!lead.assignedTo) return { text: 'Assign an owner', tone: 'warning' };
  if (!lead.nextAction) return { text: 'Schedule the next action', tone: 'warning' };
  const what = lead.nextAction.title ?? `${humanise(lead.nextAction.type)} the customer`;
  return { text: what, tone: lead.nextAction.isOverdue ? 'danger' : 'default' };
}

function ActionableLeadRow({
  lead,
  canLogOutcome,
  canReschedule,
  onLogOutcome,
  onReschedule,
}: {
  lead: LeadSummary;
  canLogOutcome: boolean;
  canReschedule: boolean;
  onLogOutcome: () => void;
  onReschedule: () => void;
}): React.JSX.Element {
  const tel = telHref(lead.mobile);
  const closed = lead.status === 'WON' || lead.status === 'LOST';
  const next = nextActionText(lead);

  return (
    <li className="px-4 py-3.5 transition hover:bg-slate-50 sm:px-5 lg:grid lg:grid-cols-[minmax(0,2fr)_minmax(0,1.6fr)_minmax(0,1.6fr)_minmax(0,1.5fr)_auto] lg:items-center lg:gap-4">
      {/* Lead */}
      <Link to={`/leads/${lead.id}`} className="group flex min-w-0 items-center gap-3">
        <Avatar name={lead.name} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="truncate text-sm font-medium text-slate-900 group-hover:underline">{lead.name}</p>
            <StatusBadge status={lead.status} />
            <PriorityBadge priority={lead.priority} />
          </div>
          <p className="mt-0.5 truncate text-xs text-slate-500">
            {lead.companyName ?? <span className="font-mono text-slate-400">{lead.leadNumber}</span>}
            {lead.mobile ? ` · ${lead.mobile}` : ''}
            {` · ${lead.assignedTo?.fullName ?? 'Unassigned'}`}
          </p>
        </div>
      </Link>

      {/* Last contact */}
      <div className="mt-2 min-w-0 lg:mt-0">
        <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400 lg:hidden">Last contact</p>
        {lead.lastOutcome ? (
          <div className="flex flex-col items-start gap-0.5">
            <OutcomeBadge outcome={lead.lastOutcome} at={lead.lastOutcomeAt} />
            <span className="text-[11px] text-slate-500">
              {lead.lastContactedAt ? `Spoke ${formatRelative(lead.lastContactedAt)}` : 'Not reached yet'}
            </span>
          </div>
        ) : (
          <span className="text-xs text-slate-400">No calls logged</span>
        )}
      </div>

      {/* Latest interaction */}
      <div className="mt-2 min-w-0 lg:mt-0">
        <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400 lg:hidden">Latest interaction</p>
        {lead.latestActivity ? (
          <p className="line-clamp-2 text-xs text-slate-600" title={lead.latestActivity.description ?? undefined}>
            {lead.latestActivity.description ?? humanise(lead.latestActivity.type)}
            <span className="text-slate-400"> · {formatRelative(lead.latestActivity.at)}</span>
          </p>
        ) : (
          <span className="text-xs text-slate-400">—</span>
        )}
      </div>

      {/* Next action */}
      <div className="mt-2 min-w-0 lg:mt-0">
        <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400 lg:hidden">Next action</p>
        <p
          className={`truncate text-xs font-medium ${
            next.tone === 'danger'
              ? 'text-red-700'
              : next.tone === 'warning'
                ? 'text-amber-700'
                : next.tone === 'muted'
                  ? 'text-slate-400'
                  : 'text-slate-800'
          }`}
        >
          {next.text}
        </p>
        {lead.nextAction ? (
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <DueBadge iso={lead.nextAction.scheduledAt} label={formatDueDate(lead.nextAction.scheduledAt)} />
            <span className="text-[11px] text-slate-400">{formatDateTime(lead.nextAction.scheduledAt)}</span>
          </div>
        ) : (
          !closed &&
          lead.nextFollowUpAt && (
            <span className="text-[11px] text-slate-400">Due {formatDateTime(lead.nextFollowUpAt)} — not in anyone’s queue</span>
          )
        )}
      </div>

      {/* Actions */}
      <div className="mt-3 flex flex-wrap gap-1.5 lg:mt-0 lg:justify-end">
        {!closed && tel && (
          <a
            href={tel}
            onClick={() => canLogOutcome && onLogOutcome()}
            className="rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-white transition hover:bg-slate-800"
          >
            Call
          </a>
        )}
        {!closed && canLogOutcome && (
          <button
            type="button"
            onClick={onLogOutcome}
            aria-label={`Log call outcome for ${lead.name}`}
            className="rounded-lg border border-slate-900 px-2.5 py-1.5 text-xs font-semibold text-slate-900 transition hover:bg-slate-50"
          >
            Log outcome
          </button>
        )}
        {!closed && canReschedule && lead.nextAction && (
          <button
            type="button"
            onClick={onReschedule}
            aria-label={`Reschedule next action for ${lead.name}`}
            className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100"
          >
            Reschedule
          </button>
        )}
        <Link
          to={`/leads/${lead.id}`}
          className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100"
        >
          History
        </Link>
      </div>
    </li>
  );
}
