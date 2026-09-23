import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  formatCurrency,
  formatDate,
  formatDateTime,
  formatDueDate,
  formatRelative,
  humanise,
  telHref,
  whatsappHref,
} from '../../lib/format';
import {
  Avatar,
  Card,
  CardHeader,
  DueBadge,
  EmptyState,
  ErrorNotice,
  PriorityBadge,
  SkeletonRows,
  StatusBadge,
} from '../../components/ui';
import { useAuth } from '../auth/auth-context';
import { LeadConversationsCard } from '../omnichannel/lead-conversations-card';
import { WebsiteEnquiryPanel } from '../intakes/website-enquiry-panel';
import { useLead, type LeadActivity } from './use-leads';
import {
  useAddNote,
  useArchiveLead,
  useLeadActivities,
  useLeadFollowUps,
  useLogActivity,
  type FollowUp,
} from './use-lead-mutations';
import {
  AssignLeadDialog,
  ChangeStatusDialog,
  CompleteFollowUpDialog,
  EditLeadDialog,
  RescheduleFollowUpDialog,
  ScheduleFollowUpDialog,
} from './lead-dialogs';

/**
 * The most important screen in the product (spec §15).
 *
 * Everything needed before picking up the phone, in one view: who to call, what
 * was said last, and what is owed next — with the actions inline rather than
 * behind a separate edit mode.
 */
export function LeadDetailPage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();

  const [dialog, setDialog] = useState<
    'edit' | 'status' | 'assign' | 'schedule' | null
  >(null);
  const [completing, setCompleting] = useState<FollowUp | null>(null);
  const [rescheduling, setRescheduling] = useState<FollowUp | null>(null);
  const [activityLimit, setActivityLimit] = useState(25);
  const [notice, setNotice] = useState<string | null>(null);

  const lead = useLead(id);
  const activities = useLeadActivities(id, activityLimit);
  const followUps = useLeadFollowUps(id);
  const archive = useArchiveLead(id ?? '');

  if (lead.isPending) {
    return (
      <Card>
        <SkeletonRows rows={6} />
      </Card>
    );
  }

  if (lead.isError) {
    return (
      <Card>
        <ErrorNotice message="This lead does not exist, or you do not have access to it." />
      </Card>
    );
  }

  const data = lead.data;
  const closed = data.status === 'WON' || data.status === 'LOST';
  const openFollowUps = (followUps.data ?? []).filter((f) =>
    ['UPCOMING', 'DUE', 'OVERDUE'].includes(f.status),
  );

  return (
    <>
      <Link
        to="/leads"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 transition hover:text-slate-900"
      >
        ← Back to leads
      </Link>

      {notice && (
        <p
          role="status"
          aria-live="polite"
          className="mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {notice}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <div className="flex flex-wrap items-start gap-4 p-5">
              <Avatar name={data.name} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-lg font-semibold text-slate-900">{data.name}</h1>
                  <StatusBadge status={data.status} />
                  <PriorityBadge priority={data.priority} />
                </div>
                <p className="mt-1 text-sm text-slate-500">
                  <span className="font-mono text-xs text-slate-400">{data.leadNumber}</span>
                  {data.companyName ? ` · ${data.companyName}` : ''}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-slate-500">Estimated value</p>
                <p className="text-xl font-semibold tabular-nums text-slate-900">
                  {formatCurrency(data.estimatedValue)}
                </p>
              </div>
            </div>

            <QuickActions lead={data} onLogged={setNotice} />

            <div className="flex flex-wrap gap-2 border-t border-slate-100 px-5 py-3">
              {can('lead.update') && (
                <>
                  <ActionButton onClick={() => setDialog('edit')}>Edit details</ActionButton>
                  <ActionButton onClick={() => setDialog('status')}>Change status</ActionButton>
                </>
              )}
              {can('lead.assign') && (
                <ActionButton onClick={() => setDialog('assign')}>Reassign</ActionButton>
              )}
              {can('followup.create') && !closed && (
                <ActionButton onClick={() => setDialog('schedule')} primary>
                  + Follow-up
                </ActionButton>
              )}
              {can('lead.delete') && (
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm('Archive this lead? Its history is kept.')) {
                      archive.mutate(undefined, { onSuccess: () => void navigate('/leads') });
                    }
                  }}
                  className="ml-auto rounded-lg px-3 py-1.5 text-sm font-medium text-red-700 transition hover:bg-red-50"
                >
                  Archive
                </button>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Activity timeline"
              subtitle={
                activities.data
                  ? `${activities.data.items.length} shown${activities.data.hasMore ? ', more available' : ''}`
                  : 'Loading…'
              }
            />
            {activities.isPending ? (
              <SkeletonRows rows={4} />
            ) : activities.isError ? (
              <ErrorNotice message="Could not load the timeline." />
            ) : activities.data.items.length === 0 ? (
              <EmptyState title="No activity yet" description="Calls and notes appear here." />
            ) : (
              <>
                <Timeline activities={activities.data.items} />
                {activities.data.hasMore && (
                  <div className="border-t border-slate-100 p-3 text-center">
                    <button
                      type="button"
                      onClick={() => setActivityLimit((current) => current + 25)}
                      className="rounded-lg border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                    >
                      Load more
                    </button>
                  </div>
                )}
              </>
            )}
          </Card>

          {/*
            Renders nothing when this lead has no conversations, so every lead
            that predates omnichannel looks exactly as it did before.
          */}
          <LeadConversationsCard leadId={data.id} />

          {/*
            The customer's own words, for a lead that came from the website.
            Renders nothing for a lead somebody created by hand, so every
            existing lead looks exactly as it did before.
          */}
          <WebsiteEnquiryPanel leadId={data.id} />
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Next action"
              subtitle={closed ? 'This lead is closed' : undefined}
            />
            <div className="p-5">
              {data.nextFollowUpAt ? (
                <>
                  <DueBadge iso={data.nextFollowUpAt} label={formatDueDate(data.nextFollowUpAt)} />
                  <p className="mt-2 text-sm text-slate-900">
                    {formatDateTime(data.nextFollowUpAt)}
                  </p>
                </>
              ) : (
                <p className="text-sm text-slate-500">
                  {closed ? 'None — this lead is closed.' : 'None scheduled.'}
                </p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Follow-ups" subtitle={`${openFollowUps.length} open`} />
            {followUps.isPending ? (
              <SkeletonRows rows={2} />
            ) : (followUps.data ?? []).length === 0 ? (
              <EmptyState
                icon="◷"
                title="Nothing scheduled"
                description="Schedule the next action so this lead is not forgotten."
              />
            ) : (
              <ul className="divide-y divide-slate-100">
                {(followUps.data ?? []).map((followUp) => (
                  <li key={followUp.id} className="px-5 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm text-slate-900">{humanise(followUp.type)}</span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                          followUp.status === 'COMPLETED'
                            ? 'bg-emerald-50 text-emerald-700'
                            : followUp.status === 'CANCELLED'
                              ? 'bg-slate-100 text-slate-500'
                              : followUp.isOverdue
                                ? 'bg-red-50 text-red-700'
                                : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {followUp.status === 'CANCELLED'
                          ? 'Cancelled'
                          : followUp.status === 'COMPLETED'
                            ? 'Done'
                            : followUp.isOverdue
                              ? 'Overdue'
                              : 'Open'}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {formatDateTime(followUp.scheduledAt)}
                      {followUp.title ? ` · ${followUp.title}` : ''}
                    </p>
                    {followUp.outcome && (
                      <p className="mt-0.5 text-xs text-slate-600">{followUp.outcome}</p>
                    )}

                    {['UPCOMING', 'DUE', 'OVERDUE'].includes(followUp.status) && (
                      <div className="mt-2 flex gap-1.5">
                        {can('followup.complete') && (
                          <button
                            type="button"
                            onClick={() => setCompleting(followUp)}
                            className="rounded-lg bg-slate-900 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-slate-800"
                          >
                            Complete
                          </button>
                        )}
                        {can('followup.create') && (
                          <button
                            type="button"
                            onClick={() => setRescheduling(followUp)}
                            className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                          >
                            Reschedule
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Details" />
            <dl className="divide-y divide-slate-100 text-sm">
              <Detail label="Mobile" value={data.mobile} mono />
              <Detail label="Company" value={data.companyName} />
              <Detail label="Owner" value={data.assignedTo?.fullName ?? 'Unassigned'} />
              <Detail label="Created" value={formatDate(data.createdAt)} />
            </dl>
          </Card>
        </div>
      </div>

      <EditLeadDialog lead={data} open={dialog === 'edit'} onClose={() => setDialog(null)} />
      <ChangeStatusDialog lead={data} open={dialog === 'status'} onClose={() => setDialog(null)} />
      <AssignLeadDialog lead={data} open={dialog === 'assign'} onClose={() => setDialog(null)} />
      <ScheduleFollowUpDialog
        leadId={data.id}
        open={dialog === 'schedule'}
        onClose={() => setDialog(null)}
      />
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
    </>
  );
}

/**
 * Call, WhatsApp and note, logged in one step.
 *
 * The call buttons open the dialer AND record the attempt, because a CRM that
 * relies on someone coming back to log it separately ends up with no call
 * history at all.
 */
function QuickActions({
  lead,
  onLogged,
}: {
  lead: { id: string; mobile: string | null };
  onLogged: (message: string) => void;
}): React.JSX.Element {
  const log = useLogActivity(lead.id);
  const addNote = useAddNote(lead.id);
  const [note, setNote] = useState('');

  const tel = telHref(lead.mobile);
  const whatsapp = whatsappHref(lead.mobile);

  const record = (activityType: string, message: string): void => {
    log.mutate({ activityType }, { onSuccess: () => onLogged(message) });
  };

  return (
    <div className="space-y-3 border-t border-slate-100 px-5 py-3">
      <div className="flex flex-wrap gap-2">
        <a
          href={tel ?? undefined}
          aria-disabled={!tel}
          onClick={() => tel && record('CALL_COMPLETED', 'Call logged.')}
          className={`flex-1 rounded-lg px-4 py-2 text-center text-sm font-medium transition sm:flex-none ${
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
          onClick={() => whatsapp && record('WHATSAPP_OPENED', 'WhatsApp logged.')}
          className={`flex-1 rounded-lg px-4 py-2 text-center text-sm font-medium transition sm:flex-none ${
            whatsapp ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'pointer-events-none bg-slate-100 text-slate-400'
          }`}
        >
          WhatsApp
        </a>
        <button
          type="button"
          onClick={() => record('CALL_NOT_ANSWERED', 'Logged as no answer.')}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
        >
          No answer
        </button>
        <button
          type="button"
          onClick={() => record('CALL_BACK_LATER', 'Logged as call back later.')}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
        >
          Call back later
        </button>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!note.trim()) return;
          addNote.mutate(note, {
            onSuccess: () => {
              setNote('');
              onLogged('Note added.');
            },
          });
        }}
        className="flex gap-2"
      >
        <label htmlFor="quick-note" className="sr-only">
          Add a note
        </label>
        <input
          id="quick-note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Add a note…"
          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none transition focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
        />
        <button
          type="submit"
          disabled={!note.trim() || addNote.isPending}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
        >
          {addNote.isPending ? 'Saving…' : 'Add'}
        </button>
      </form>
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  primary,
}: {
  children: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
        primary
          ? 'bg-slate-900 text-white hover:bg-slate-800'
          : 'border border-slate-300 text-slate-700 hover:bg-slate-50'
      }`}
    >
      {children}
    </button>
  );
}

function Detail({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 px-5 py-2.5">
      <dt className="shrink-0 text-xs text-slate-500">{label}</dt>
      <dd className={`text-right text-sm text-slate-900 ${mono ? 'font-mono text-xs' : ''}`}>
        {value ?? '—'}
      </dd>
    </div>
  );
}

const ACTIVITY_TONE: Record<string, string> = {
  LEAD_CREATED: 'bg-sky-100 text-sky-700',
  LEAD_UPDATED: 'bg-slate-100 text-slate-600',
  LEAD_ASSIGNED: 'bg-slate-100 text-slate-600',
  LEAD_REASSIGNED: 'bg-blue-100 text-blue-700',
  CALL_COMPLETED: 'bg-emerald-100 text-emerald-700',
  CALL_NOT_ANSWERED: 'bg-amber-100 text-amber-700',
  CALL_BACK_LATER: 'bg-amber-100 text-amber-700',
  WHATSAPP_OPENED: 'bg-emerald-100 text-emerald-700',
  WHATSAPP_SENT: 'bg-emerald-100 text-emerald-700',
  NOTE_ADDED: 'bg-slate-100 text-slate-600',
  STATUS_CHANGED: 'bg-violet-100 text-violet-700',
  FOLLOW_UP_CREATED: 'bg-indigo-100 text-indigo-700',
  FOLLOW_UP_COMPLETED: 'bg-emerald-100 text-emerald-700',
  FOLLOW_UP_RESCHEDULED: 'bg-amber-100 text-amber-700',
  LEAD_WON: 'bg-emerald-100 text-emerald-700',
  LEAD_LOST: 'bg-rose-100 text-rose-700',
};

function Timeline({ activities }: { activities: LeadActivity[] }): React.JSX.Element {
  return (
    <ol className="relative space-y-5 p-5">
      {activities.map((activity, index) => (
        <li key={activity.id} className="relative flex gap-3 pl-1">
          {index < activities.length - 1 && (
            <span className="absolute top-7 left-[15px] h-full w-px bg-slate-200" aria-hidden />
          )}

          <span
            className={`relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
              ACTIVITY_TONE[activity.type] ?? 'bg-slate-100 text-slate-600'
            }`}
          >
            {activity.type.charAt(0)}
          </span>

          <div className="min-w-0 flex-1 pb-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <p className="text-sm font-medium text-slate-900">{humanise(activity.type)}</p>
              <time className="text-xs text-slate-400" title={formatDateTime(activity.createdAt)}>
                {formatRelative(activity.createdAt)}
              </time>
            </div>
            {activity.description && (
              <p className="mt-0.5 text-sm text-slate-600">{activity.description}</p>
            )}
            {activity.performedBy && (
              <p className="mt-1 text-xs text-slate-400">by {activity.performedBy.fullName}</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
