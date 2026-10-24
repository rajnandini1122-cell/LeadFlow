import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { LeadStatus } from '@leadflow/api-types';
import { formatCurrencyCompact, formattingContext, humanise } from '../../lib/format';
import { Card, CardHeader, EmptyState, ErrorNotice, PageHeader, SkeletonRows, StatTile } from '../../components/ui';
import { useAuth } from '../auth/auth-context';
import { useLeadsPage } from '../leads/use-leads';
import { useWorkspaceSummary } from '../leads/use-lead-mutations';
import { ActionableLeadList } from '../leads/actionable-lead-list';
import { NewLeadDialog } from '../leads/new-lead-dialog';
import { FollowUpQueue } from '../followups/follow-up-queue';
import { useDashboard, type DashboardSummary } from './use-dashboard';

/**
 * The dashboard: the state of the business on one screen, with the work one
 * click away.
 *
 * Laid out the way a sales manager reads a CRM home page:
 *   1. header with the primary actions (new lead, import, my work);
 *   2. one row of key numbers, each a link to the list behind it;
 *   3. today's priorities, with the call actions on every row;
 *   4. the pipeline by stage, and lead health;
 *   5. the newest leads, actionable.
 *
 * Every figure comes from the API, aggregated over the whole dataset in the
 * organization's timezone; the follow-up numbers share one predicate with the
 * queues, so a tile never disagrees with the list it opens.
 */
export function DashboardPage(): React.JSX.Element {
  const { user, can } = useAuth();
  const dashboard = useDashboard();
  const workspace = useWorkspaceSummary();
  const [newLeadOpen, setNewLeadOpen] = useState(false);

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
        <ErrorNotice message="The dashboard could not be loaded. Refresh to try again." />
      </Card>
    );
  }

  const data = dashboard.data;
  // The workspace numbers are secondary here: if they are missing or not the
  // expected shape, those tiles show "…" rather than taking the page down.
  const work = workspace.data?.followUps && workspace.data.leads ? workspace.data : undefined;
  const firstName = user?.fullName.split(' ')[0] ?? '';
  const { overdue, dueToday, upcoming } = data.followUps;

  return (
    <>
      <PageHeader
        title={`${greeting()}, ${firstName}`}
        subtitle={
          <span>
            {overdue > 0
              ? `${overdue} follow-${overdue === 1 ? 'up is' : 'ups are'} overdue — start there.`
              : dueToday > 0
                ? `${dueToday} follow-${dueToday === 1 ? 'up' : 'ups'} due today.`
                : 'Nothing overdue. Your pipeline is current.'}{' '}
            <ScopeNote scope={data.scope} timezone={data.timezone} />
          </span>
        }
        action={
          <div className="flex flex-wrap gap-2">
            <Link
              to="/today"
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              My work today
            </Link>
            {can('lead.import') && (
              <Link
                to="/leads/import"
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              >
                Import CSV
              </Link>
            )}
            {can('lead.create') && (
              <button
                type="button"
                onClick={() => setNewLeadOpen(true)}
                className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
              >
                + New lead
              </button>
            )}
          </div>
        }
      />
      <NewLeadDialog open={newLeadOpen} onClose={() => setNewLeadOpen(false)} />

      {/* 1. Key numbers — every tile opens the list it counts. */}
      <section aria-label="Key numbers" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile
          label="Overdue"
          value={overdue}
          tone={overdue > 0 ? 'danger' : 'success'}
          hint={overdue > 0 ? 'Past due time' : 'All clear'}
          to="/today?view=overdue"
        />
        <StatTile
          label="Due today"
          value={dueToday}
          tone={dueToday > 0 ? 'warning' : 'default'}
          hint={`${upcoming} from tomorrow`}
          to="/today?view=today"
        />
        <StatTile
          label="Awaiting response"
          value={work ? work.followUps.awaiting : '…'}
          hint="Customer owes a reply"
          to="/today?view=awaiting"
        />
        <StatTile
          label="Completed today"
          value={work ? work.followUps.completed_today : '…'}
          tone="success"
          hint="Follow-ups done"
          to="/today?view=completed_today"
        />
        <StatTile
          label="Open pipeline"
          value={formatCurrencyCompact(data.pipeline.activeValue)}
          hint={`${data.pipeline.activeCount} open leads`}
          to="/leads"
        />
        <StatTile
          label="Win rate"
          value={`${data.outcomes.conversionRate}%`}
          hint={`${data.outcomes.won} won · ${data.outcomes.lost} lost`}
          to="/leads?status=WON"
        />
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {/* 2. Today's priorities — the work, with its actions on every row. */}
        <section aria-labelledby="priorities-title" className="lg:col-span-2">
          <PriorityQueue overdue={overdue} dueToday={dueToday} />
        </section>

        {/* 3. Pipeline and lead health. */}
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Pipeline by stage"
              subtitle={`${data.pipeline.activeCount} open leads · ${formatCurrencyCompact(data.pipeline.activeValue)}`}
            />
            <div className="p-5">
              <PipelineChart stages={data.pipeline.byStage} />
            </div>
          </Card>

          <Card>
            <CardHeader title="Lead health" />
            <dl className="divide-y divide-slate-100">
              <Metric
                label="New — not reached yet"
                value={work ? String(work.leads.fresh) : '…'}
                to="/leads?fresh=true"
                tone={work && work.leads.fresh > 0 ? 'warning' : 'default'}
              />
              {work && work.leads.unassigned !== null && (
                <Metric
                  label="Unassigned"
                  value={String(work.leads.unassigned)}
                  to="/leads?unassigned=true"
                  tone={work.leads.unassigned > 0 ? 'warning' : 'default'}
                />
              )}
              <Metric label="Awaiting customer" value={work ? String(work.leads.awaiting) : '…'} to="/leads?awaiting=true" />
              <Metric label="New leads this week" value={String(data.outcomes.newThisWeek)} />
              <Metric label="Won value" value={formatCurrencyCompact(data.outcomes.wonValue)} to="/leads?status=WON" />
              <Metric label="Contacts" value={String(data.contacts)} to="/contacts" />
            </dl>
          </Card>
        </div>
      </div>

      {/* 4. The newest leads, workable from here. */}
      <section aria-labelledby="recent-title" className="mt-6">
        <RecentLeads />
      </section>
    </>
  );
}

/** Overdue and due-today work, with Call / Log outcome / Reschedule on each row. */
function PriorityQueue({ overdue, dueToday }: { overdue: number; dueToday: number }): React.JSX.Element {
  const [tab, setTab] = useState<'overdue' | 'today'>(overdue > 0 ? 'overdue' : 'today');

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="priorities-title" className="text-sm font-semibold text-slate-900">
          Today’s priorities
        </h2>
        <div className="flex gap-1.5" role="tablist" aria-label="Priority list">
          {(
            [
              ['overdue', `Overdue ${overdue}`],
              ['today', `Due today ${dueToday}`],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                tab === key
                  ? 'bg-slate-900 text-white'
                  : 'bg-white text-slate-600 ring-1 ring-slate-200 ring-inset hover:bg-slate-50'
              }`}
            >
              {label}
            </button>
          ))}
          <Link to="/follow-ups" className="px-2 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-900">
            All follow-ups →
          </Link>
        </div>
      </div>
      <div className="max-h-[32rem] overflow-y-auto rounded-xl">
        <FollowUpQueue bucket={tab} />
      </div>
    </>
  );
}

/** The five newest live leads, as actionable rows. */
function RecentLeads(): React.JSX.Element {
  const leads = useLeadsPage({ lifecycle: 'ACTIVE' }, 5);
  const rows = leads.data?.pages[0]?.items ?? [];

  return (
    <Card>
      <CardHeader
        title="Recently added leads"
        action={
          <Link to="/leads" className="text-xs font-medium text-slate-500 hover:text-slate-900">
            All leads →
          </Link>
        }
      />
      <h2 id="recent-title" className="sr-only">
        Recently added leads
      </h2>
      {leads.isPending ? (
        <SkeletonRows rows={3} />
      ) : leads.isError ? (
        <ErrorNotice message="Could not load recent leads." />
      ) : rows.length === 0 ? (
        <EmptyState title="No leads yet" description="Add a lead or import a CSV file to get started." />
      ) : (
        <ActionableLeadList leads={rows} />
      )}
    </Card>
  );
}

/**
 * Open pipeline by stage — one series, so one hue (#3987e5, validated against
 * the light surface), no legend; the count and value are written on every row
 * so identity and magnitude never rest on colour. Each bar opens that stage.
 */
const BAR_COLOUR = '#3987e5';

function PipelineChart({
  stages,
}: {
  stages: { status: LeadStatus; count: number; value: string }[];
}): React.JSX.Element {
  const max = Math.max(0, ...stages.map((stage) => stage.count));

  if (max === 0) {
    return <p className="text-sm text-slate-500">No open leads yet.</p>;
  }

  return (
    <ul className="space-y-3" aria-label="Open leads by stage">
      {stages.map((stage) => {
        const width = stage.count === 0 ? 0 : Math.max(3, (stage.count / max) * 100);
        const label = `${humanise(stage.status)}: ${stage.count} ${stage.count === 1 ? 'lead' : 'leads'}, ${formatCurrencyCompact(stage.value)}`;
        return (
          <li key={stage.status}>
            <Link
              to={`/leads?status=${stage.status}`}
              aria-label={`${label}. Open these leads.`}
              className="group relative block rounded-md outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
            >
              <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                <span className="font-medium text-slate-700 group-hover:underline">{humanise(stage.status)}</span>
                <span className="tabular-nums text-slate-500">
                  <span className="font-semibold text-slate-900">{stage.count}</span> · {formatCurrencyCompact(stage.value)}
                </span>
              </div>
              {/* Track, then the bar: 4px rounded data-end anchored to the baseline. */}
              <div className="h-2.5 w-full rounded bg-slate-100">
                <div className="h-2.5 rounded" style={{ width: `${width}%`, backgroundColor: BAR_COLOUR }} />
              </div>
              {/* Hover/focus detail — text in ink, never in the series colour. */}
              <span
                role="tooltip"
                className="pointer-events-none absolute right-0 -top-7 z-10 hidden whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[11px] text-white shadow group-hover:block group-focus-visible:block"
              >
                {label}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** Says whose numbers these are, and in which timezone the day was cut. */
function ScopeNote({ scope, timezone }: { scope: DashboardSummary['scope']; timezone: string }): React.JSX.Element {
  return (
    <span className="ml-1 inline-block rounded-md bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">
      {scope === 'OWN' ? 'Your leads' : 'Whole team'} · {timezone}
    </span>
  );
}

function Metric({
  label,
  value,
  to,
  tone = 'default',
}: {
  label: string;
  value: string;
  to?: string;
  tone?: 'default' | 'warning';
}): React.JSX.Element {
  const body = (
    <>
      <dt className="text-sm text-slate-600">{label}</dt>
      <dd className={`text-sm font-semibold tabular-nums ${tone === 'warning' ? 'text-amber-700' : 'text-slate-900'}`}>
        {value}
      </dd>
    </>
  );
  return to ? (
    <Link to={to} className="flex items-center justify-between px-5 py-3 transition hover:bg-slate-50">
      {body}
    </Link>
  ) : (
    <div className="flex items-center justify-between px-5 py-3">{body}</div>
  );
}

/** Greeting on the ORGANIZATION's clock, not the device's. */
function greeting(): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: formattingContext().timezone }).format(
      new Date(),
    ),
  );
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}
