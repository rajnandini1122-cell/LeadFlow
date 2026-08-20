import { Link } from 'react-router-dom';
import { formatCurrencyCompact, formatDueDate } from '../../lib/format';
import {
  Avatar,
  Card,
  CardHeader,
  DueBadge,
  EmptyState,
  ErrorNotice,
  PageHeader,
  PhaseNote,
  PriorityBadge,
  SkeletonRows,
  StatTile,
  StatusBadge,
} from '../../components/ui';
import { useAuth } from '../auth/auth-context';
import { bucketLeads, useLeads, type LeadSummary } from '../leads/use-leads';

/**
 * Dashboard, per spec §24 — deliberately not a BI tool.
 *
 * The layout answers "what do I do next?" before "how are we doing?": overdue
 * work sits at the top, and the metrics sit below it.
 */
export function DashboardPage(): React.JSX.Element {
  const { user } = useAuth();
  const leads = useLeads();

  if (leads.isPending) {
    return (
      <>
        <PageHeader title="Loading…" />
        <Card>
          <SkeletonRows rows={6} />
        </Card>
      </>
    );
  }

  if (leads.isError) {
    return (
      <Card>
        <ErrorNotice message="The leads service did not respond. Is the API running?" />
      </Card>
    );
  }

  const b = bucketLeads(leads.data.items);
  const firstName = user?.fullName.split(' ')[0] ?? '';

  return (
    <>
      <PageHeader
        title={`${greeting()}, ${firstName}`}
        subtitle={
          b.overdue.length > 0
            ? `${b.overdue.length} follow-${b.overdue.length === 1 ? 'up is' : 'ups are'} overdue. Start there.`
            : b.today.length > 0
              ? `${b.today.length} follow-${b.today.length === 1 ? 'up' : 'ups'} due today.`
              : 'Nothing overdue. Your pipeline is current.'
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Overdue"
          value={b.overdue.length}
          tone={b.overdue.length > 0 ? 'danger' : 'success'}
          hint={b.overdue.length > 0 ? 'Needs attention now' : 'All clear'}
        />
        <StatTile
          label="Due today"
          value={b.today.length}
          tone={b.today.length > 0 ? 'warning' : 'default'}
          hint="Scheduled for today"
        />
        <StatTile
          label="Active pipeline"
          value={formatCurrencyCompact(b.pipelineValue)}
          hint={`${b.active.length} open leads`}
        />
        <StatTile
          label="Conversion"
          value={`${b.conversionRate}%`}
          tone="success"
          hint={`${b.won.length} won · ${b.lost.length} lost`}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader
              title="Next actions"
              subtitle="Overdue first, then due today"
              action={
                <Link to="/follow-ups" className="text-xs font-medium text-slate-500 hover:text-slate-900">
                  View all →
                </Link>
              }
            />
            {[...b.overdue, ...b.today].length === 0 ? (
              <EmptyState
                icon="✓"
                title="Nothing due"
                description="Every active lead has a follow-up scheduled for a future date."
              />
            ) : (
              <ul className="divide-y divide-slate-100">
                {[...b.overdue, ...b.today].slice(0, 7).map((lead) => (
                  <LeadRow key={lead.id} lead={lead} />
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Pipeline by stage" subtitle="Open leads only" />
            <div className="p-5">
              <PipelineBar leads={b.active} />
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Recently added" />
            {b.all.length === 0 ? (
              <EmptyState title="No leads yet" description="Seed the database to see demo data." />
            ) : (
              <ul className="divide-y divide-slate-100">
                {[...b.all]
                  .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
                  .slice(0, 5)
                  .map((lead) => (
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

          <PhaseNote phase="Phase 4">
            These figures are computed in the browser from one page of leads.
            Server-side aggregation and team-level metrics arrive with the
            dashboard API.
          </PhaseNote>
        </div>
      </div>
    </>
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
function PipelineBar({ leads }: { leads: LeadSummary[] }): React.JSX.Element {
  const stages = ['NEW', 'CONTACTED', 'QUALIFIED', 'FOLLOW_UP', 'QUOTATION_SENT', 'NEGOTIATION'] as const;
  const colours: Record<string, string> = {
    NEW: 'bg-sky-400',
    CONTACTED: 'bg-cyan-400',
    QUALIFIED: 'bg-violet-400',
    FOLLOW_UP: 'bg-amber-400',
    QUOTATION_SENT: 'bg-orange-400',
    NEGOTIATION: 'bg-fuchsia-400',
  };

  const counts = stages.map((stage) => ({
    stage,
    count: leads.filter((lead) => lead.status === stage).length,
  }));
  const total = counts.reduce((sum, entry) => sum + entry.count, 0);

  if (total === 0) {
    return <p className="text-sm text-slate-500">No open leads.</p>;
  }

  return (
    <div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-slate-100">
        {counts.map(({ stage, count }) =>
          count === 0 ? null : (
            <div
              key={stage}
              className={colours[stage]}
              style={{ width: `${(count / total) * 100}%` }}
              title={`${stage}: ${count}`}
            />
          ),
        )}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
        {counts.map(({ stage, count }) => (
          <div key={stage} className="flex items-center gap-2">
            <span className={`h-2 w-2 shrink-0 rounded-full ${colours[stage]}`} aria-hidden />
            <dt className="flex-1 truncate text-xs text-slate-600">
              <StatusBadge status={stage} />
            </dt>
            <dd className="text-xs font-semibold tabular-nums text-slate-900">{count}</dd>
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
