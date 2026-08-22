import { Link } from 'react-router-dom';
import type { LeadStatus } from '@leadflow/api-types';
import { formatCurrencyCompact, formatDueDate, humanise } from '../../lib/format';
import {
  Avatar,
  Card,
  CardHeader,
  DueBadge,
  EmptyState,
  ErrorNotice,
  PageHeader,
  PriorityBadge,
  SkeletonRows,
  StatTile,
  StatusBadge,
} from '../../components/ui';
import { useAuth } from '../auth/auth-context';
import type { LeadSummary } from '../leads/use-leads';
import { useDashboard, type DashboardSummary } from './use-dashboard';

/**
 * Dashboard, per spec §24 — deliberately not a BI tool.
 *
 * The layout answers "what do I do next?" before "how are we doing?": overdue
 * work sits at the top, and the metrics sit below it.
 *
 * Every figure comes from the API, aggregated over the whole dataset and
 * bucketed in the organization's timezone.
 */
export function DashboardPage(): React.JSX.Element {
  const { user } = useAuth();
  const dashboard = useDashboard();

  if (dashboard.isPending) {
    return (
      <>
        <PageHeader title="Loading…" />
        <Card>
          <SkeletonRows rows={6} />
        </Card>
      </>
    );
  }

  if (dashboard.isError) {
    return (
      <Card>
        <ErrorNotice message="The dashboard did not respond. Is the API running?" />
      </Card>
    );
  }

  const data = dashboard.data;
  const firstName = user?.fullName.split(' ')[0] ?? '';
  const { overdue, dueToday } = data.followUps;

  return (
    <>
      <PageHeader
        title={`${greeting()}, ${firstName}`}
        subtitle={
          overdue > 0
            ? `${overdue} follow-${overdue === 1 ? 'up is' : 'ups are'} overdue. Start there.`
            : dueToday > 0
              ? `${dueToday} follow-${dueToday === 1 ? 'up' : 'ups'} due today.`
              : 'Nothing overdue. Your pipeline is current.'
        }
        action={<ScopeNote scope={data.scope} timezone={data.timezone} />}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {/*
          * The follow-up tiles link to the list that contains them. A count
          * with no way through to the work is a dead end.
          */}
        <StatTile
          label="Overdue"
          value={overdue}
          tone={overdue > 0 ? 'danger' : 'success'}
          hint={overdue > 0 ? 'Needs attention now' : 'All clear'}
          {...(overdue > 0 ? { to: '/follow-ups?bucket=overdue' } : {})}
        />
        <StatTile
          label="Due today"
          value={dueToday}
          tone={dueToday > 0 ? 'warning' : 'default'}
          hint={`${data.followUps.upcoming} scheduled later`}
          to="/follow-ups?bucket=today"
        />
        {/* A total, not a queue — but the open leads behind it are one. */}
        <StatTile
          label="Active pipeline"
          value={formatCurrencyCompact(data.pipeline.activeValue)}
          hint={`${data.pipeline.activeCount} open leads`}
          to="/leads"
        />
        <StatTile
          label="Conversion"
          value={`${data.outcomes.conversionRate}%`}
          tone="success"
          hint={`${data.outcomes.won} won · ${data.outcomes.lost} lost`}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader
              title="Next actions"
              subtitle="Overdue first, then due today"
              action={
                <Link
                  to="/follow-ups"
                  className="text-xs font-medium text-slate-500 hover:text-slate-900"
                >
                  View all →
                </Link>
              }
            />
            {data.nextActions.length === 0 ? (
              <EmptyState
                icon="✓"
                title="Nothing due"
                description="Every active lead has a follow-up scheduled for a future date."
              />
            ) : (
              <ul className="divide-y divide-slate-100">
                {data.nextActions.map((lead) => (
                  <LeadRow key={lead.id} lead={lead} />
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Pipeline by stage"
              subtitle={`Open leads only · ${data.pipeline.activeCount} total`}
            />
            <div className="p-5">
              <PipelineBar stages={data.pipeline.byStage} />
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="This week" />
            <dl className="divide-y divide-slate-100">
              <Metric label="New leads" value={String(data.outcomes.newThisWeek)} />
              <Metric label="Won value" value={formatCurrencyCompact(data.outcomes.wonValue)} />
              <Metric
                label="Contacts"
                value={String(data.contacts)}
                to="/contacts"
              />
            </dl>
          </Card>

          <Card>
            <CardHeader title="Recently added" />
            {data.recent.length === 0 ? (
              <EmptyState title="No leads yet" description="Add a lead or import a CSV file." />
            ) : (
              <ul className="divide-y divide-slate-100">
                {data.recent.map((lead) => (
                  <li key={lead.id} className="px-5 py-3">
                    <Link to={`/leads/${lead.id}`} className="group block">
                      <p className="truncate text-sm font-medium text-slate-900 group-hover:underline">
                        {lead.name}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-slate-500">{lead.companyName}</p>
                      <div className="mt-1.5">
                        <StatusBadge status={lead.status} />
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

/**
 * Says whose numbers these are.
 *
 * A sales rep sees only their own pipeline, so an unlabelled "12 open leads"
 * would read as the whole company's.
 */
function ScopeNote({
  scope,
  timezone,
}: {
  scope: DashboardSummary['scope'];
  timezone: string;
}): React.JSX.Element {
  return (
    <span className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-[11px] text-slate-500">
      {scope === 'OWN' ? 'Your leads' : 'Whole team'} · {timezone}
    </span>
  );
}

function Metric({
  label,
  value,
  to,
}: {
  label: string;
  value: string;
  to?: string;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between px-5 py-3">
      <dt className="text-sm text-slate-600">
        {to ? (
          <Link to={to} className="hover:text-slate-900 hover:underline">
            {label}
          </Link>
        ) : (
          label
        )}
      </dt>
      <dd className="text-sm font-semibold tabular-nums text-slate-900">{value}</dd>
    </div>
  );
}

function LeadRow({ lead }: { lead: LeadSummary }): React.JSX.Element {
  return (
    <li>
      <Link
        to={`/leads/${lead.id}`}
        className="flex items-center gap-3 px-5 py-3 transition hover:bg-slate-50"
      >
        <Avatar name={lead.name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium text-slate-900">{lead.name}</p>
            <PriorityBadge priority={lead.priority} />
          </div>
          <p className="mt-0.5 truncate text-xs text-slate-500">
            {lead.companyName}
            {lead.assignedTo ? ` · ${lead.assignedTo.fullName}` : ''}
          </p>
        </div>
        <div className="hidden shrink-0 text-right sm:block">
          <p className="text-sm font-medium tabular-nums text-slate-900">
            {formatCurrencyCompact(lead.estimatedValue)}
          </p>
          <div className="mt-1">
            <DueBadge iso={lead.nextFollowUpAt} label={formatDueDate(lead.nextFollowUpAt)} />
          </div>
        </div>
      </Link>
    </li>
  );
}

/** Proportional stage bar — shows pipeline shape without a charting library. */
function PipelineBar({
  stages,
}: {
  stages: { status: LeadStatus; count: number; value: string }[];
}): React.JSX.Element {
  const colours: Record<string, string> = {
    NEW: 'bg-sky-400',
    CONTACTED: 'bg-cyan-400',
    QUALIFIED: 'bg-violet-400',
    FOLLOW_UP: 'bg-amber-400',
    QUOTATION_SENT: 'bg-orange-400',
    NEGOTIATION: 'bg-fuchsia-400',
  };

  const total = stages.reduce((sum, stage) => sum + stage.count, 0);

  if (total === 0) {
    return <p className="text-sm text-slate-500">No open leads.</p>;
  }

  return (
    <div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-slate-100">
        {stages.map((stage) =>
          stage.count === 0 ? null : (
            <div
              key={stage.status}
              className={colours[stage.status]}
              style={{ width: `${(stage.count / total) * 100}%` }}
              title={`${humanise(stage.status)}: ${stage.count}`}
            />
          ),
        )}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
        {stages.map((stage) => (
          <div key={stage.status} className="flex items-center gap-2">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${colours[stage.status]}`}
              aria-hidden
            />
            <dt className="flex-1 truncate text-xs text-slate-600">
              <StatusBadge status={stage.status} />
            </dt>
            <dd className="text-xs font-semibold tabular-nums text-slate-900">{stage.count}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}
