import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { LeadStatus } from '@leadflow/api-types';
import { formatDateTime, formatDueDate, humanise, telHref, whatsappHref } from '../../lib/format';
import { Avatar, Card, DueBadge, EmptyState, ErrorNotice, SkeletonRows, StatusBadge } from '../../components/ui';
import { OutcomeBadge } from '../../components/outcome-badge';
import { useAuth } from '../auth/auth-context';
import { useFollowUps, type FollowUp, type FollowUpBucket } from '../leads/use-lead-mutations';
import { CompleteFollowUpDialog, RescheduleFollowUpDialog } from '../leads/lead-dialogs';
import { LogOutcomeDialog, type LogOutcomeLead } from '../leads/log-outcome-dialog';

/**
 * One follow-up list, with its actions and dialogs — the Follow-ups page and
 * the "My work" workspace render the same thing, so they cannot drift apart.
 *
 * A LEAD row's actions are the call itself: Call, Log outcome, Reschedule.
 * "Log outcome" replaces "Complete" there because a call has an outcome, not
 * just an end — and "No answer" must not complete anything. A CUSTOMER row has
 * no lead behind it, so it keeps Complete.
 */

export const BUCKET_COPY: Record<FollowUpBucket, { label: string; empty: string; hint: string }> = {
  overdue: { label: 'Overdue', empty: 'Nothing overdue', hint: 'Every open follow-up is scheduled for now or later.' },
  today: { label: 'Today', empty: 'Nothing left today', hint: 'Follow-ups due later today appear here.' },
  tomorrow: { label: 'Tomorrow', empty: 'Nothing tomorrow', hint: 'Tomorrow’s scheduled calls appear here.' },
  week: { label: 'This week', empty: 'Nothing else this week', hint: 'The rest of this week, after today.' },
  upcoming: { label: 'Upcoming', empty: 'Nothing scheduled ahead', hint: 'Everything from tomorrow onwards.' },
  awaiting: {
    label: 'Awaiting response',
    empty: 'Nobody owes you an answer',
    hint: 'Leads whose last call left them to reply, or with a quotation out.',
  },
  completed: { label: 'Completed', empty: 'Nothing completed yet', hint: 'Finished follow-ups, newest first.' },
  completed_today: { label: 'Done today', empty: 'Nothing completed today', hint: 'Follow-ups finished today.' },
};

export function FollowUpQueue({ bucket }: { bucket: FollowUpBucket }): React.JSX.Element {
  const { can } = useAuth();
  const query = useFollowUps(bucket);

  const [completing, setCompleting] = useState<FollowUp | null>(null);
  const [rescheduling, setRescheduling] = useState<FollowUp | null>(null);
  /** Held as one object so the dialog receives a STABLE reference. */
  const [logging, setLogging] = useState<{ lead: LogOutcomeLead; followUpId: string } | null>(null);

  const finished = bucket === 'completed' || bucket === 'completed_today';
  const copy = BUCKET_COPY[bucket];

  return (
    <>
      <Card>
        {query.isPending ? (
          <SkeletonRows rows={5} />
        ) : query.isError ? (
          <ErrorNotice message="Could not load follow-ups." />
        ) : (query.data?.length ?? 0) === 0 ? (
          <EmptyState icon={bucket === 'overdue' ? '✓' : '○'} title={copy.empty} description={copy.hint} />
        ) : (
          <ul className="divide-y divide-slate-100">
            {(query.data ?? []).map((followUp) => (
              <FollowUpRow
                key={followUp.id}
                followUp={followUp}
                showActions={!finished}
                canLogOutcome={can('lead.update')}
                canComplete={can('followup.complete')}
                canReschedule={can('followup.create')}
                onLogOutcome={() => {
                  if (!followUp.leadId) return;
                  setLogging({
                    lead: {
                      id: followUp.leadId,
                      name: followUp.leadName ?? 'this lead',
                      status: (followUp.leadStatus ?? 'NEW') as LeadStatus,
                    },
                    followUpId: followUp.id,
                  });
                }}
                onComplete={() => setCompleting(followUp)}
                onReschedule={() => setRescheduling(followUp)}
              />
            ))}
          </ul>
        )}
      </Card>

      <CompleteFollowUpDialog followUp={completing} open={completing !== null} onClose={() => setCompleting(null)} />
      <RescheduleFollowUpDialog followUp={rescheduling} open={rescheduling !== null} onClose={() => setRescheduling(null)} />
      {logging && (
        <LogOutcomeDialog
          lead={logging.lead}
          followUpId={logging.followUpId}
          open
          onClose={() => setLogging(null)}
        />
      )}
    </>
  );
}

export function FollowUpRow({
  followUp,
  showActions,
  canLogOutcome,
  canComplete,
  canReschedule,
  onLogOutcome,
  onComplete,
  onReschedule,
}: {
  followUp: FollowUp;
  showActions: boolean;
  canLogOutcome: boolean;
  canComplete: boolean;
  canReschedule: boolean;
  onLogOutcome: () => void;
  onComplete: () => void;
  onReschedule: () => void;
}): React.JSX.Element {
  const tel = telHref(followUp.mobile);
  const whatsapp = whatsappHref(followUp.mobile);
  const isLead = followUp.leadId !== null;

  /*
   * A row is a LEAD follow-up or a CUSTOMER follow-up. The second links to the
   * customer and says that it is one — it used to link to /leads/null.
   */
  const target = followUp.leadId
    ? `/leads/${followUp.leadId}`
    : followUp.accountId
      ? `/customers/${followUp.accountId}`
      : null;
  const name = followUp.leadName ?? followUp.accountName ?? followUp.companyName ?? 'Follow-up';

  const summary = (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <p className="truncate text-sm font-medium text-slate-900 group-hover:underline">{name}</p>
        {followUp.leadStatus ? (
          <StatusBadge status={followUp.leadStatus as never} />
        ) : (
          <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[11px] font-medium text-indigo-700">Customer</span>
        )}
        <OutcomeBadge outcome={followUp.leadLastOutcome} at={followUp.leadLastOutcomeAt} />
      </div>
      <p className="mt-0.5 truncate text-xs text-slate-500">
        <span className="font-medium text-slate-700">{followUp.title ?? humanise(followUp.type)}</span>
        {isLead && followUp.companyName ? ` · ${followUp.companyName}` : ''}
        {` · ${followUp.assignedTo.fullName}`}
      </p>
    </>
  );

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3.5 transition hover:bg-slate-50 sm:px-5">
      <Avatar name={name} />

      {target ? (
        <Link to={target} className="group min-w-0 flex-1">
          {summary}
        </Link>
      ) : (
        <div className="min-w-0 flex-1">{summary}</div>
      )}

      <div className="text-right">
        {followUp.completedAt ? (
          <>
            <p className="text-xs text-slate-500">{followUp.outcome ?? 'Completed'}</p>
            <p className="text-[11px] text-slate-400">{formatDateTime(followUp.completedAt)}</p>
          </>
        ) : (
          <>
            <DueBadge iso={followUp.scheduledAt} label={formatDueDate(followUp.scheduledAt)} />
            <p className="mt-0.5 text-[11px] text-slate-400">{formatDateTime(followUp.scheduledAt)}</p>
          </>
        )}
      </div>

      {showActions && (
        <div className="flex w-full flex-wrap gap-1.5 sm:w-auto">
          <a
            href={tel ?? undefined}
            aria-disabled={!tel}
            // Dialling is not an outcome. The call is logged when the agent says
            // how it went, so the outcome dialog opens alongside the dialler.
            onClick={() => {
              if (tel && isLead && canLogOutcome) onLogOutcome();
            }}
            className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
              tel ? 'bg-slate-900 text-white hover:bg-slate-800' : 'pointer-events-none bg-slate-100 text-slate-400'
            }`}
          >
            Call
          </a>
          <a
            href={whatsapp ?? undefined}
            target="_blank"
            rel="noreferrer"
            aria-disabled={!whatsapp}
            className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
              whatsapp ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'pointer-events-none bg-slate-100 text-slate-400'
            }`}
          >
            WhatsApp
          </a>
          {isLead && canLogOutcome && (
            <button
              type="button"
              onClick={onLogOutcome}
              aria-label={`Log call outcome for ${name}`}
              className="rounded-lg border border-slate-900 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-900 transition hover:bg-slate-50"
            >
              Log outcome
            </button>
          )}
          {!isLead && canComplete && (
            <button
              type="button"
              onClick={onComplete}
              className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Complete
            </button>
          )}
          {canReschedule && (
            <button
              type="button"
              onClick={onReschedule}
              aria-label={`Reschedule follow-up for ${name}`}
              className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100"
            >
              Reschedule
            </button>
          )}
        </div>
      )}
    </li>
  );
}
