import { useState } from 'react';
import { formatCurrency, formatCurrencyCompact, humanise } from '../../lib/format';
import { downloadCsv, exportFilename, toCsv } from '../../lib/export-csv';
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorNotice,
  PageHeader,
  SkeletonRows,
  StatTile,
} from '../../components/ui';
import { useAuth } from '../auth/auth-context';
import { DateRangePicker, RangeSummary } from './date-range-picker';
import { useReportOverview, type RangeSelection, type ReportOverview } from './use-reports';

/**
 * Reports — intentionally basic (spec §24: "Do not build advanced BI in MVP").
 *
 * Every figure is aggregated by the API across the whole tenant dataset and
 * bucketed in the organization's timezone. It used to be derived in the browser
 * from one page of leads, which was fine at demo scale and wrong at real scale.
 */
export function ReportsPage(): React.JSX.Element {
  const { user } = useAuth();
  const [range, setRange] = useState<RangeSelection>({ preset: 'this_month' });
  const report = useReportOverview(range);

  const exportReport = (): void => {
    if (!report.data) return;
    downloadCsv(
      exportFilename('report', user?.organization.slug ?? 'export'),
      toCsv(metricRows(report.data), [
        { header: 'Metric', value: (row) => row.label },
        { header: 'Value', value: (row) => row.value },
        { header: 'Measured by', value: (row) => row.basis },
      ]),
    );
  };

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Pipeline, conversion and follow-up discipline"
        action={
          <button
            type="button"
            onClick={exportReport}
            disabled={!report.data}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            Export CSV
          </button>
        }
      />

      <div className="mb-5 space-y-2">
        <DateRangePicker value={range} onChange={setRange} />
        {report.data && <RangeSummary range={report.data.range} scope={report.data.scope} />}
      </div>

      {report.isPending ? (
        <Card>
          <SkeletonRows rows={6} />
        </Card>
      ) : report.isError ? (
        <Card>
          <ErrorNotice message="Could not load report data." />
        </Card>
      ) : (
        <ReportBody data={report.data} />
      )}
    </>
  );
}

function ReportBody({ data }: { data: ReportOverview }): React.JSX.Element {
  const { leads, followUps, snapshot, basis } = data;

  return (
    <>
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Total leads"
          value={snapshot.totalLeads}
          hint={`${snapshot.activeLeads} active now`}
        />
        <StatTile
          label="Open pipeline"
          value={formatCurrencyCompact(snapshot.pipelineValue)}
          hint="Estimated value of active leads"
        />
        <StatTile
          label="Won value"
          value={formatCurrencyCompact(leads.wonValue)}
          tone="success"
          hint={`${leads.won} deals closed in range`}
        />
        <StatTile
          label="Conversion"
          value={`${leads.conversionRate}%`}
          hint={`${leads.won} won of ${leads.won + leads.lost} decided`}
        />
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="New leads"
          value={leads.created}
          hint={basis['newLeads'] ?? 'By created date'}
        />
        <StatTile
          label="Overdue follow-ups"
          value={followUps.overdue}
          tone={followUps.overdue > 0 ? 'danger' : 'success'}
          hint="Open and past due, right now"
        />
        <StatTile
          label="Due today"
          value={followUps.dueToday}
          tone={followUps.dueToday > 0 ? 'warning' : 'default'}
        />
        <StatTile
          label="Follow-up completion"
          value={`${followUps.completionRate}%`}
          hint={`${followUps.completed} completed of ${followUps.scheduled} scheduled`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Leads by stage"
            subtitle="Created in the selected range, by their status now"
          />
          <div className="space-y-3 p-5">
            {leads.byStatus.length === 0 ? (
              <p className="text-sm text-slate-500">No leads created in this range.</p>
            ) : (
              <StageBars
                rows={leads.byStatus.map((row) => ({
                  key: row.status,
                  label: humanise(row.status),
                  count: row.count,
                  detail: formatCurrencyCompact(row.value),
                  tone:
                    row.status === 'WON'
                      ? 'bg-emerald-500'
                      : row.status === 'LOST'
                        ? 'bg-rose-400'
                        : 'bg-slate-400',
                }))}
              />
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Where leads came from" subtitle="By created date" />
          <div className="space-y-3 p-5">
            {leads.bySource.length === 0 ? (
              <p className="text-sm text-slate-500">No leads created in this range.</p>
            ) : (
              <StageBars
                rows={leads.bySource.map((row) => ({
                  key: row.source,
                  label: row.source,
                  count: row.count,
                  detail: `${row.count}`,
                  tone: 'bg-sky-400',
                }))}
              />
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Why deals were lost" subtitle="By lost date" />
          {leads.lostReasons.length === 0 ? (
            <EmptyState
              icon="✓"
              title="No losses in this range"
              description="Nothing was marked lost during the selected period."
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              {leads.lostReasons.map((row) => (
                <li key={row.reason} className="flex items-center justify-between px-5 py-3">
                  <span className="min-w-0 truncate text-sm text-slate-700">{row.reason}</span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-900">
                    {row.count}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Outcomes in range" subtitle="Counted by close date" />
          <dl className="divide-y divide-slate-100">
            <Row label="Won" value={String(leads.won)} detail={formatCurrency(leads.wonValue)} />
            <Row label="Lost" value={String(leads.lost)} />
            <Row label="Archived" value={String(leads.archived)} />
            <Row label="Created" value={String(leads.created)} />
            <Row label="Follow-ups completed" value={String(followUps.completed)} />
          </dl>
        </Card>
      </div>

      <details className="mt-6 rounded-xl border border-slate-200 bg-white p-4">
        <summary className="cursor-pointer text-sm font-medium text-slate-700">
          How each figure is measured
        </summary>
        <dl className="mt-3 space-y-1.5 text-xs">
          {Object.entries(basis).map(([metric, description]) => (
            <div key={metric} className="flex flex-wrap gap-x-2">
              <dt className="font-medium text-slate-700">{humanise(metric)}:</dt>
              <dd className="text-slate-500">{description}</dd>
            </div>
          ))}
        </dl>
      </details>
    </>
  );
}

function StageBars({
  rows,
}: {
  rows: { key: string; label: string; count: number; detail: string; tone: string }[];
}): React.JSX.Element {
  const max = Math.max(...rows.map((row) => row.count), 1);

  return (
    <>
      {rows.map((row) => (
        <div key={row.key}>
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-sm text-slate-700">{row.label}</span>
            <span className="shrink-0 text-xs text-slate-500">
              <span className="font-semibold tabular-nums text-slate-900">{row.count}</span>
              {row.detail !== String(row.count) && ` · ${row.detail}`}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className={`h-full rounded-full ${row.tone}`}
              style={{ width: `${(row.count / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </>
  );
}

function Row({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between px-5 py-3">
      <dt className="text-sm text-slate-600">{label}</dt>
      <dd className="text-right">
        <span className="text-sm font-semibold tabular-nums text-slate-900">{value}</span>
        {detail && <span className="ml-2 text-xs text-slate-500">{detail}</span>}
      </dd>
    </div>
  );
}

/** Flattens the report into rows a spreadsheet can hold. */
function metricRows(data: ReportOverview): { label: string; value: string; basis: string }[] {
  const basis = (key: string): string => data.basis[key] ?? '';

  return [
    { label: 'Range', value: `${data.range.fromDate} to ${data.range.toDate}`, basis: data.range.timezone },
    { label: 'Scope', value: data.scope, basis: 'caller lead visibility' },
    { label: 'Total leads', value: String(data.snapshot.totalLeads), basis: basis('totalLeads') },
    { label: 'Active leads', value: String(data.snapshot.activeLeads), basis: basis('activeLeads') },
    { label: 'Pipeline value', value: data.snapshot.pipelineValue, basis: basis('pipelineValue') },
    { label: 'New leads', value: String(data.leads.created), basis: basis('newLeads') },
    { label: 'Won leads', value: String(data.leads.won), basis: basis('wonLeads') },
    { label: 'Lost leads', value: String(data.leads.lost), basis: basis('lostLeads') },
    { label: 'Archived leads', value: String(data.leads.archived), basis: basis('archivedLeads') },
    { label: 'Won value', value: data.leads.wonValue, basis: basis('wonValue') },
    { label: 'Conversion rate', value: `${data.leads.conversionRate}%`, basis: basis('conversionRate') },
    { label: 'Follow-ups due today', value: String(data.followUps.dueToday), basis: basis('followUpsDueToday') },
    { label: 'Overdue follow-ups', value: String(data.followUps.overdue), basis: basis('overdueFollowUps') },
    { label: 'Completed follow-ups', value: String(data.followUps.completed), basis: basis('completedFollowUps') },
    {
      label: 'Follow-up completion rate',
      value: `${data.followUps.completionRate}%`,
      basis: basis('followUpCompletionRate'),
    },
    ...data.leads.byStatus.map((row) => ({
      label: `Stage: ${humanise(row.status)}`,
      value: String(row.count),
      basis: basis('statusDistribution'),
    })),
    ...data.leads.bySource.map((row) => ({
      label: `Source: ${row.source}`,
      value: String(row.count),
      basis: basis('sourceDistribution'),
    })),
    ...data.leads.lostReasons.map((row) => ({
      label: `Lost: ${row.reason}`,
      value: String(row.count),
      basis: basis('lostReasons'),
    })),
  ];
}
