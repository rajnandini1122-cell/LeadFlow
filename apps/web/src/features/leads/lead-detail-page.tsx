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
import { useLead, type LeadActivity, type LeadDetail } from './use-leads';
import { LogOutcomeDialog } from './log-outcome-dialog';
import { OutcomeBadge } from '../../components/outcome-badge';
import { LeadAttachmentsCard, latestQuotation } from './lead-attachments-card';
import { LeadCustomerCard } from './lead-customer-card';
import { useLeadAttachments } from './use-lead-attachments';
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
  DeactivateLeadDialog,
  ReactivateLeadDialog,
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
    'edit' | 'status' | 'assign' | 'schedule' | 'deactivate' | 'reactivate' | null
  >(null);
  /**
   * Which failed-attempt button opened the dialog, so it starts on that answer.
   *
   * Separate from `dialog` because the attempt dialog is opened from two
   * buttons that mean different things, and reopening it should not silently
   * keep the previous one's selection.
   */
  /** The outcome dialog, and the follow-up it is working when opened from one. */
  const [logging, setLogging] = useState<{ followUpId?: string } | null>(null);
  const [completing, setCompleting] = useState<FollowUp | null>(null);
  const [rescheduling, setRescheduling] = useState<FollowUp | null>(null);
  const [activityLimit, setActivityLimit] = useState(25);
  const [notice, setNotice] = useState<string | null>(null);

  const lead = useLead(id);
  const activities = useLeadActivities(id, activityLimit);
  const followUps = useLeadFollowUps(id);
  const archive = useArchiveLead(id ?? '');
  /*
   * The deactivation mutations live in the DIALOGS, not here.
   *
   * Both need a form — a required reason, and a follow-up date — so they follow
   * the same shape as every other lead mutation on this page rather than being
   * a `window.confirm` like Archive. Archive can get away with a confirm
   * because it takes no input; that is also why it records nothing.
   */

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
  // The next action is the earliest open follow-up — what the queue shows too.
  const nextFollowUp =
    [...openFollowUps].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))[0] ?? null;
  const outcomeLead = { id: data.id, name: data.name, status: data.status };

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

            {data.deactivatedAt && (
              <DeactivatedBanner
                at={data.deactivatedAt}
                reason={data.deactivationReason}
                canReactivate={can('lead.deactivate')}
                onReactivate={() => setDialog('reactivate')}
              />
            )}

            <ContactDetails lead={data} />

            <QuickActions
              lead={data}
              closed={closed}
              onLogged={setNotice}
              onLogOutcome={() => setLogging(nextFollowUp ? { followUpId: nextFollowUp.id } : {})}
            />

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
              {can('lead.deactivate') && !data.deactivatedAt && (
                <ActionButton onClick={() => setDialog('deactivate')}>Deactivate</ActionButton>
              )}
              {can('lead.deactivate') && data.deactivatedAt && (
                <ActionButton onClick={() => setDialog('reactivate')}>Reactivate</ActionButton>
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

          {/* Quotations sent, invoices, POs, photos — where the commercial evidence lives. */}
          <LeadAttachmentsCard leadId={data.id} canEdit={can('lead.update')} />

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
              {nextFollowUp ? (
                <>
                  <p className="text-sm font-medium text-slate-900">
                    {nextFollowUp.title ?? `${humanise(nextFollowUp.type)} the customer`}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <DueBadge iso={nextFollowUp.scheduledAt} label={formatDueDate(nextFollowUp.scheduledAt)} />
                    <span className="text-sm text-slate-700">{formatDateTime(nextFollowUp.scheduledAt)}</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {humanise(nextFollowUp.type)} · {nextFollowUp.assignedTo.fullName}
                  </p>
                  {!closed && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {can('lead.update') && (
                        <button
                          type="button"
                          onClick={() => setLogging({ followUpId: nextFollowUp.id })}
                          className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-slate-800"
                        >
                          Log outcome
                        </button>
                      )}
                      {can('followup.create') && (
                        <button
                          type="button"
                          onClick={() => setRescheduling({ ...nextFollowUp, leadName: data.name })}
                          className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                        >
                          Reschedule
                        </button>
                      )}
                    </div>
                  )}
                </>
              ) : data.nextFollowUpAt ? (
                <>
                  <DueBadge iso={data.nextFollowUpAt} label={formatDueDate(data.nextFollowUpAt)} />
                  <p className="mt-2 text-sm text-slate-900">{formatDateTime(data.nextFollowUpAt)}</p>
                  <p className="mt-1 text-xs text-amber-700">
                    Not in anyone’s queue — assign an owner so it is worked.
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
            <CardHeader
              title="Follow-ups"
              /*
               * "0 open" beside a next-action date read as a bug, and often
               * was one — four paths set the date and created no follow-up.
               * That is fixed at the source; what remains legitimately is an
               * UNASSIGNED lead, where no follow-up can exist because
               * `assigned_user_id` is NOT NULL. Saying so beats a bare zero
               * that looks like data loss.
               */
              subtitle={
                openFollowUps.length === 0 && data.nextFollowUpAt && !data.assignedTo
                  ? 'Nobody owns this lead yet, so nothing is queued'
                  : `${openFollowUps.length} open`
              }
            />
            {followUps.isPending ? (
              <SkeletonRows rows={2} />
            ) : (followUps.data ?? []).length === 0 ? (
              <EmptyState
                icon="◷"
                title={data.assignedTo ? 'Nothing scheduled' : 'Not assigned'}
                description={
                  data.assignedTo
                    ? 'Schedule the next action so this lead is not forgotten.'
                    : 'A follow-up belongs to somebody. Assign this lead and its next action joins their queue.'
                }
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
                          ? followUp.rescheduledToId
                            ? 'Rescheduled'
                            : 'Cancelled'
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
                        {can('lead.update') && (
                          <button
                            type="button"
                            onClick={() => setLogging({ followUpId: followUp.id })}
                            className="rounded-lg bg-slate-900 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-slate-800"
                          >
                            Log outcome
                          </button>
                        )}
                        {can('followup.create') && (
                          <button
                            type="button"
                            onClick={() => setRescheduling({ ...followUp, leadName: data.name })}
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

          <CommercialDetails lead={data} />

          <LeadCustomerCard lead={data} canLink={can('account.create')} />

          <Card>
            <CardHeader title="Details" />
            <dl className="divide-y divide-slate-100 text-sm">
              <Detail label="Mobile" value={data.mobile} mono />
              <Detail label="Company" value={data.companyName} />
              <Detail label="Owner" value={data.assignedTo?.fullName ?? 'Unassigned'} />
              <Detail
                label="Last spoke"
                value={
                  data.lastContactedAt
                    ? `${formatDateTime(data.lastContactedAt)} (${formatRelative(data.lastContactedAt)})`
                    : 'Not reached yet'
                }
              />
              <Detail label="Created" value={formatDate(data.createdAt)} />
            </dl>
          </Card>
        </div>
      </div>

      <EditLeadDialog lead={data} open={dialog === 'edit'} onClose={() => setDialog(null)} />
      <ChangeStatusDialog lead={data} open={dialog === 'status'} onClose={() => setDialog(null)} />
      <AssignLeadDialog lead={data} open={dialog === 'assign'} onClose={() => setDialog(null)} />
      <DeactivateLeadDialog
        lead={data}
        open={dialog === 'deactivate'}
        onClose={() => setDialog(null)}
      />
      <ReactivateLeadDialog
        lead={data}
        open={dialog === 'reactivate'}
        onClose={() => setDialog(null)}
      />
      <LogOutcomeDialog
        lead={outcomeLead}
        followUpId={logging?.followUpId}
        open={logging !== null}
        onClose={() => setLogging(null)}
      />
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
 * Call, WhatsApp, log the outcome, and a note.
 *
 * THE CALL BUTTON NO LONGER LOGS A CALL. It recorded "call completed" on the
 * click, before anyone had answered — so every unanswered dial became a
 * completed call and "contacted" meant "somebody pressed a button". It now
 * opens the dialler and the outcome dialog together; the call is recorded when
 * the agent says how it went.
 */
function QuickActions({
  lead,
  closed,
  onLogged,
  onLogOutcome,
}: {
  lead: { id: string; mobile: string | null };
  closed: boolean;
  onLogged: (message: string) => void;
  /** Opens the "How did the call go?" dialog. */
  onLogOutcome: () => void;
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
          onClick={() => tel && !closed && onLogOutcome()}
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
        {!closed && (
          <button
            type="button"
            onClick={onLogOutcome}
            className="flex-1 rounded-lg border border-slate-900 px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-50 sm:flex-none"
          >
            Log call outcome
          </button>
        )}
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
  DOCUMENT_ATTACHED: 'bg-orange-100 text-orange-700',
  DOCUMENT_REMOVED: 'bg-slate-100 text-slate-600',
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


/**
 * Says plainly that this record is not live work, and why.
 *
 * At the top of the lead rather than in a corner: somebody who opens a
 * deactivated lead and does not notice will waste a call on it, and the whole
 * point of the state is that the record should not be worked.
 */
function DeactivatedBanner({
  at,
  reason,
  canReactivate,
  onReactivate,
}: {
  at: string;
  reason: string | null;
  canReactivate: boolean;
  onReactivate: () => void;
}): React.JSX.Element {
  return (
    <div className="mx-5 mb-4 rounded-lg bg-amber-50 px-4 py-3">
      <p className="text-sm font-medium text-amber-900">
        This lead is deactivated and is not in the pipeline.
      </p>
      <p className="mt-0.5 text-xs text-amber-800">
        {reason ? `${reason} · ` : ''}
        {formatDate(at)}
      </p>
      {canReactivate && (
        <button
          type="button"
          onClick={onReactivate}
          className="mt-2 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 transition hover:bg-amber-100"
        >
          Reactivate it
        </button>
      )}
    </div>
  );
}

/**
 * How to reach this customer, and where they are.
 *
 * THE ADDRESS IS HERE because until this release it could not be: `leads` held
 * only `city`, so an imported address was dropped. Showing it is what lets
 * somebody verify an import actually landed correctly — the counts said
 * "created 2,000" either way.
 *
 * Each field renders only when it has a value: a column of dashes on a lead
 * captured from a two-field web form buries the three things that do have
 * values.
 */
function ContactDetails({ lead }: { lead: LeadDetail }): React.JSX.Element | null {
  const address = [
    lead.addressLine1,
    lead.addressLine2,
    lead.city,
    lead.state,
    lead.postalCode,
    lead.country,
  ].filter(Boolean);

  if (!lead.mobile && !lead.email && address.length === 0) return null;

  return (
    <dl className="grid gap-x-6 gap-y-2 border-t border-slate-100 px-5 py-3 text-sm sm:grid-cols-3">
      {lead.mobile && <DetailField label="Mobile" value={lead.mobile} />}
      {lead.email && <DetailField label="Email" value={lead.email} />}
      {address.length > 0 && (
        <div className="sm:col-span-3">
          <dt className="text-xs text-slate-500">Address</dt>
          {/* Joined for reading, but each part is stored in its own column —
              which is what makes "every customer in Maharashtra" answerable. */}
          <dd className="text-slate-800">{address.join(', ')}</dd>
        </div>
      )}
    </dl>
  );
}

function DetailField({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="truncate text-slate-800">{value}</dd>
    </div>
  );
}

/**
 * What the customer wants to buy, and how far it has got.
 *
 * Built from fields that already exist — the product, the enquiry text, the
 * estimated value, the stage — plus the quantity and purchase date a call can
 * now record. No new commercial module: quotation and sample status are read
 * from the stage and the last call, which is where this CRM already keeps them.
 */
function CommercialDetails({ lead }: { lead: LeadDetail }): React.JSX.Element {
  const quotation =
    lead.status === 'QUOTATION_SENT'
      ? 'Sent — awaiting the customer'
      : lead.status === 'NEGOTIATION'
        ? 'In negotiation'
        : lead.status === 'WON'
          ? 'Accepted (won)'
          : lead.lastOutcome === 'QUOTATION_REQUESTED'
            ? 'Requested — to be sent'
            : 'Not yet';
  const sample = lead.lastOutcome === 'SAMPLE_REQUESTED' ? 'Requested on the last call' : null;
  // The quotation itself, when one was attached: what was quoted, and when.
  const quoted = latestQuotation(useLeadAttachments(lead.id).data);

  return (
    <Card>
      <CardHeader title="Commercial details" />
      <dl className="divide-y divide-slate-100 text-sm">
        <Detail label="Product" value={lead.product?.name ?? null} />
        <Detail label="Requirement" value={lead.productInterest ?? null} />
        <Detail label="Quantity" value={lead.requirementQuantity ?? null} />
        <Detail
          label="Expected purchase"
          value={lead.expectedPurchaseDate ? formatDate(`${lead.expectedPurchaseDate}T12:00:00Z`) : null}
        />
        <Detail label="Estimated value" value={lead.estimatedValue ? formatCurrency(lead.estimatedValue) : null} />
        <Detail label="Quotation" value={quotation} />
        {quoted && (
          <Detail
            label="Latest quotation"
            value={`${quoted.amount !== null ? `${formatCurrency(quoted.amount)} · ` : ''}${formatDate(quoted.createdAt)} · ${quoted.fileName}`}
          />
        )}
        <Detail label="Sample" value={sample} />
        {/* How it ended — the first thing anyone opening a closed lead needs. */}
        {lead.status === 'WON' && (
          <Detail
            label="Won"
            value={[lead.wonValue ? formatCurrency(lead.wonValue) : null, lead.wonAt ? formatDate(lead.wonAt) : null]
              .filter(Boolean)
              .join(' · ') || 'Won'}
          />
        )}
        {lead.status === 'LOST' && (
          <Detail
            label="Lost"
            value={[lead.lostReason, lead.lostAt ? formatDate(lead.lostAt) : null].filter(Boolean).join(' · ') || 'Lost'}
          />
        )}
      </dl>
      {lead.lastOutcome && (
        <div className="border-t border-slate-100 px-5 py-3">
          <p className="mb-1 text-xs text-slate-500">Last call</p>
          <OutcomeBadge outcome={lead.lastOutcome} at={lead.lastOutcomeAt} />
        </div>
      )}
    </Card>
  );
}
