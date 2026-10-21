import { useState } from 'react';
import type { LeadStatus } from '@leadflow/api-types';
import { useSearchParams } from 'react-router-dom';
import { Link } from 'react-router-dom';
import {
  formatCurrencyCompact,
  formatDateTime,
  formatDueDate,
  humanise,
  telHref,
  whatsappHref,
} from '../../lib/format';
import {
  Avatar,
  Card,
  DueBadge,
  EmptyState,
  ErrorNotice,
  PageHeader,
  SkeletonRows,
  StatusBadge,
} from '../../components/ui';
import { useAuth } from '../auth/auth-context';
import {
  useFollowUps,
  type FollowUp,
  type FollowUpBucket,
} from '../leads/use-lead-mutations';
import {
  CompleteFollowUpDialog,
  RecordAttemptDialog,
  RescheduleFollowUpDialog,
} from '../leads/lead-dialogs';

/** What the queue asks for per bucket. A full page means there may be more. */
const BUCKET_LIMIT = 200;

/**
 * The count shown on a tab.
 *
 * The tab counted the rows it had fetched, so a bucket of 340 overdue
 * follow-ups read "200" — understating exactly the number a manager watches.
 * A full page is shown as "200+" rather than as a total it does not have.
 */
function bucketCount(rows: number): string {
  return rows >= BUCKET_LIMIT ? `${BUCKET_LIMIT}+` : String(rows);
}

/**
 * Follow-up centre.
 *
 * Buckets come from the API, computed in the ORGANIZATION's timezone. Deriving
 * them in the browser would use the viewer's clock, so a manager travelling
 * would see a different "today" from the team they are managing.
 */
export function FollowUpsPage(): React.JSX.Element {
  const { can } = useAuth();
  /*
   * The bucket comes from the URL when one is given.
   *
   * The dashboard tiles link straight to a bucket, so "Due today" has to open
   * the today tab rather than the default. It also makes the tab shareable and
   * survives a reload, which a useState-only tab does not.
   */
  const [params, setParams] = useSearchParams();
  const requested = params.get('bucket');
  const bucket: FollowUpBucket = isBucket(requested) ? requested : 'overdue';
  const setBucket = (next: FollowUpBucket): void => {
    // `replace`, so flicking between tabs does not fill the back button with
    // steps the user has to press through to leave the page.
    setParams(next === 'overdue' ? {} : { bucket: next }, { replace: true });
  };

  const [completing, setCompleting] = useState<FollowUp | null>(null);
  const [rescheduling, setRescheduling] = useState<FollowUp | null>(null);
  /*
   * "No answer" straight from the queue.
   *
   * The queue is where an agent works through calls, but logging a missed one
   * meant opening the lead, finding the button and coming back. Held as one
   * object so the dialog receives a stable reference.
   */
  const [attempting, setAttempting] = useState<{ id: string; status: LeadStatus } | null>(null);

  const overdue = useFollowUps('overdue');
  const today = useFollowUps('today');
  const upcoming = useFollowUps('upcoming');
  const completed = useFollowUps('completed');

  const buckets: { key: FollowUpBucket; label: string; query: typeof overdue; danger?: boolean }[] =
    [
      { key: 'overdue', label: 'Overdue', query: overdue, danger: true },
      { key: 'today', label: 'Today', query: today },
      { key: 'upcoming', label: 'Upcoming', query: upcoming },
      { key: 'completed', label: 'Completed', query: completed },
    ];

  const active = buckets.find((entry) => entry.key === bucket) ?? buckets[0]!;
  const overdueCount = overdue.data?.length ?? 0;

  return (
    <>
      <PageHeader
        title="Follow-ups"
        subtitle={
          overdue.isPending
            ? 'Loading…'
            : overdueCount > 0
              ? `${bucketCount(overdueCount)} overdue — these are the leads at risk of being forgotten`
              : 'Nothing overdue. Every active lead has a future follow-up.'
        }
      />

      <div className="mb-4 flex flex-wrap gap-1.5" role="tablist" aria-label="Follow-up buckets">
        {buckets.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={bucket === entry.key}
            onClick={() => setBucket(entry.key)}
            className={`rounded-lg px-3.5 py-2 text-sm font-medium transition ${
              bucket === entry.key
                ? 'bg-slate-900 text-white'
                : 'bg-white text-slate-600 ring-1 ring-slate-200 ring-inset hover:bg-slate-50'
            }`}
          >
            {entry.label}
            <span
              className={`ml-2 rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
                bucket === entry.key
                  ? 'bg-white/20 text-white'
                  : entry.danger && (entry.query.data?.length ?? 0) > 0
                    ? 'bg-red-100 text-red-700'
                    : 'bg-slate-100 text-slate-500'
              }`}
            >
              {entry.query.isPending ? '…' : bucketCount(entry.query.data?.length ?? 0)}
            </span>
          </button>
        ))}
      </div>

      <Card>
        {active.query.isPending ? (
          <SkeletonRows rows={5} />
        ) : active.query.isError ? (
          <ErrorNotice message="Could not load follow-ups." />
        ) : (active.query.data?.length ?? 0) === 0 ? (
          <EmptyState
            icon={active.key === 'overdue' ? '✓' : '○'}
            title={
              active.key === 'overdue'
                ? 'Nothing overdue'
                : active.key === 'today'
                  ? 'Nothing left today'
                  : active.key === 'upcoming'
                    ? 'Nothing scheduled ahead'
                    : 'Nothing completed yet'
            }
            description={
              active.key === 'overdue'
                ? 'Every open follow-up is scheduled for now or later.'
                : 'Follow-ups appear here as their dates arrive.'
            }
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {(active.query.data ?? []).map((followUp) => (
              <FollowUpRow
                key={followUp.id}
                followUp={followUp}
                showActions={active.key !== 'completed'}
                canComplete={can('followup.complete')}
                canReschedule={can('followup.create')}
                canLogAttempt={can('lead.update')}
                onComplete={() => setCompleting(followUp)}
                onReschedule={() => setRescheduling(followUp)}
                onNoAnswer={() =>
                  setAttempting({ id: followUp.leadId, status: followUp.leadStatus as LeadStatus })
                }
              />
            ))}
          </ul>
        )}
      </Card>

      <CompleteFollowUpDialog
        followUp={completing}
        open={completing !== null}
        onClose={() => setCompleting(null)}
      />
      <RescheduleFollowUpDialog
        followUp={rescheduling}
        open={rescheduling !== null}
        onClose={() => setRescheduling(null)}
      />
      {attempting && (
        <RecordAttemptDialog
          lead={attempting}
          open
          initialAttempt="CALL_NOT_ANSWERED"
          onClose={() => setAttempting(null)}
        />
      )}
    </>
  );
}

function FollowUpRow({
  followUp,
  showActions,
  canComplete,
  canReschedule,
  canLogAttempt,
  onComplete,
  onReschedule,
  onNoAnswer,
}: {
  followUp: FollowUp;
  showActions: boolean;
  canComplete: boolean;
  canReschedule: boolean;
  canLogAttempt: boolean;
  onComplete: () => void;
  onReschedule: () => void;
  onNoAnswer: () => void;
}): React.JSX.Element {
  const tel = telHref(followUp.mobile);
  const whatsapp = whatsappHref(followUp.mobile);

  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-3.5 transition hover:bg-slate-50">
      <Avatar name={followUp.leadName} />

      <Link to={`/leads/${followUp.leadId}`} className="group min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium text-slate-900 group-hover:underline">
            {followUp.leadName}
          </p>
          <StatusBadge status={followUp.leadStatus as never} />
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
            {humanise(followUp.type)}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs text-slate-500">
          {followUp.companyName ? `${followUp.companyName} · ` : ''}
          {followUp.assignedTo.fullName}
          {followUp.title ? ` · ${followUp.title}` : ''}
        </p>
      </Link>

      <div className="text-right">
        {followUp.completedAt ? (
          <>
            <p className="text-xs text-slate-500">{followUp.outcome ?? 'Completed'}</p>
            <p className="text-[11px] text-slate-400">{formatDateTime(followUp.completedAt)}</p>
          </>
        ) : (
          <DueBadge iso={followUp.scheduledAt} label={formatDueDate(followUp.scheduledAt)} />
        )}
      </div>

      {showActions && (
        <div className="flex flex-wrap gap-1.5">
          <a
            href={tel ?? undefined}
            aria-disabled={!tel}
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
          {canLogAttempt && followUp.leadId && (
            <button
              type="button"
              onClick={onNoAnswer}
              aria-label={`No answer from ${followUp.leadName} — log the attempt and set a retry`}
              className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-800 transition hover:bg-amber-100"
            >
              No answer
            </button>
          )}
          {canComplete && (
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

export { formatCurrencyCompact };

/** Narrows a query-string value to a real bucket. Anything else falls back. */
function isBucket(value: string | null): value is FollowUpBucket {
  return value === 'overdue' || value === 'today' || value === 'upcoming' || value === 'completed';
}
