import { Link, useParams } from 'react-router-dom';
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
  PhaseNote,
  PriorityBadge,
  SkeletonRows,
  StatusBadge,
} from '../../components/ui';
import { useLead, type LeadActivity } from './use-leads';

/**
 * The most important screen in the product (spec §15).
 *
 * Everything a salesperson needs before picking up the phone, in one view:
 * who to call, what was said last, and when the next action is due.
 */
export function LeadDetailPage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const lead = useLead(id);

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
        <ErrorNotice message="This lead does not exist, or belongs to another organization." />
      </Card>
    );
  }

  const data = lead.data;
  const tel = telHref(data.mobile);
  const whatsapp = whatsappHref(data.mobile);

  return (
    <>
      <Link
        to="/leads"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 transition hover:text-slate-900"
      >
        ← Back to leads
      </Link>

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

            {/* Spec §16: for the MVP these open the device dialer and WhatsApp. */}
            <div className="flex flex-wrap gap-2 border-t border-slate-100 px-5 py-3">
              <a
                href={tel ?? undefined}
                aria-disabled={!tel}
                className={`flex-1 rounded-lg px-4 py-2 text-center text-sm font-medium transition sm:flex-none ${
                  tel
                    ? 'bg-slate-900 text-white hover:bg-slate-800'
                    : 'pointer-events-none bg-slate-100 text-slate-400'
                }`}
              >
                Call
              </a>
              <a
                href={whatsapp ?? undefined}
                target="_blank"
                rel="noreferrer"
                aria-disabled={!whatsapp}
                className={`flex-1 rounded-lg px-4 py-2 text-center text-sm font-medium transition sm:flex-none ${
                  whatsapp
                    ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                    : 'pointer-events-none bg-slate-100 text-slate-400'
                }`}
              >
                WhatsApp
              </a>
              <span className="flex-1 rounded-lg border border-slate-200 px-4 py-2 text-center text-sm text-slate-400 sm:flex-none">
                Update lead · Phase 2
              </span>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Activity timeline"
              subtitle={`${data.activities.length} recorded ${data.activities.length === 1 ? 'event' : 'events'}`}
            />
            {data.activities.length === 0 ? (
              <EmptyState title="No activity yet" description="Calls and messages appear here." />
            ) : (
              <Timeline activities={data.activities} />
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Next follow-up" />
            <div className="p-5">
              {data.nextFollowUpAt ? (
                <>
                  <DueBadge
                    iso={data.nextFollowUpAt}
                    label={formatDueDate(data.nextFollowUpAt)}
                  />
                  <p className="mt-2 text-sm text-slate-900">
                    {formatDateTime(data.nextFollowUpAt)}
                  </p>
                </>
              ) : (
                <p className="text-sm text-slate-500">
                  {data.status === 'WON' || data.status === 'LOST'
                    ? 'None — this lead is closed.'
                    : 'None scheduled.'}
                </p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Details" />
            <dl className="divide-y divide-slate-100 text-sm">
              <Detail label="Mobile" value={data.mobile} mono />
              <Detail label="Company" value={data.companyName} />
              <Detail
                label="Owner"
                value={data.assignedTo?.fullName ?? 'Unassigned'}
              />
              <Detail label="Created" value={formatDate(data.createdAt)} />
            </dl>
          </Card>

          <PhaseNote phase="Phase 6">
            Completing and rescheduling follow-ups, plus the reminders that make
            them impossible to miss, arrive with the follow-up engine.
          </PhaseNote>
        </div>
      </div>
    </>
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

/** Colour-codes the event so the timeline is scannable without reading it. */
const ACTIVITY_TONE: Record<string, string> = {
  LEAD_CREATED: 'bg-sky-100 text-sky-700',
  LEAD_ASSIGNED: 'bg-slate-100 text-slate-600',
  CALL_COMPLETED: 'bg-emerald-100 text-emerald-700',
  CALL_NOT_ANSWERED: 'bg-amber-100 text-amber-700',
  WHATSAPP_SENT: 'bg-emerald-100 text-emerald-700',
  NOTE_ADDED: 'bg-slate-100 text-slate-600',
  STATUS_CHANGED: 'bg-violet-100 text-violet-700',
  LEAD_WON: 'bg-emerald-100 text-emerald-700',
  LEAD_LOST: 'bg-rose-100 text-rose-700',
};

function Timeline({ activities }: { activities: LeadActivity[] }): React.JSX.Element {
  return (
    <ol className="relative space-y-5 p-5">
      {activities.map((activity, index) => (
        <li key={activity.id} className="relative flex gap-3 pl-1">
          {/* Connector, omitted on the last item so the line does not dangle. */}
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
