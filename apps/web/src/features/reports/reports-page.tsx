import { LEAD_STATUSES } from '@idea001/api-types';
import { formatCurrency, formatCurrencyCompact, humanise } from '../../lib/format';
import {
  Card,
  CardHeader,
  ErrorNotice,
  PageHeader,
  PhaseNote,
  SkeletonRows,
  StatTile,
} from '../../components/ui';
import { bucketLeads, useLeads } from '../leads/use-leads';

/**
 * Reports — intentionally basic (spec §24: "Do not build advanced BI in MVP").
 *
 * Everything here is derived in the browser from one page of leads. Real
 * reporting endpoints with server-side aggregation arrive in Phase 4; this
 * exists so the screen is useful now rather than empty.
 */
export function ReportsPage(): React.JSX.Element {
  const leads = useLeads();

  if (leads.isPending) {
    return (
      <>
        <PageHeader title="Reports" />
        <Card>
          <SkeletonRows rows={5} />
        </Card>
      </>
    );
  }

  if (leads.isError) {
    return (
      <Card>
        <ErrorNotice message="Could not load report data." />
      </Card>
    );
  }

  const b = bucketLeads(leads.data.items);

  const bySource = groupBy(b.all, (lead) => lead.assignedTo?.fullName ?? 'Unassigned');
  const byStatus = LEAD_STATUSES.map((status) => ({
    status,
    rows: b.all.filter((lead) => lead.status === status),
  })).filter((entry) => entry.rows.length > 0);

  const maxStatus = Math.max(...byStatus.map((entry) => entry.rows.length), 1);

  return (
    <>
      <PageHeader title="Reports" subtitle="Pipeline and conversion at a glance" />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Total leads" value={b.all.length} />
        <StatTile
          label="Open pipeline"
          value={formatCurrencyCompact(b.pipelineValue)}
          hint={`${b.active.length} active`}
        />
        <StatTile
          label="Won value"
          value={formatCurrencyCompact(b.wonValue)}
          tone="success"
          hint={`${b.won.length} deals`}
        />
        <StatTile
          label="Conversion"
          value={`${b.conversionRate}%`}
          hint={`${b.won.length} won of ${b.won.length + b.lost.length} decided`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Leads by stage" subtitle="Count and total value" />
          <div className="space-y-3 p-5">
            {byStatus.map(({ status, rows }) => {
              const value = rows.reduce(
                (sum, lead) => sum + Number(lead.estimatedValue ?? 0),
                0,
              );
              return (
                <div key={status}>
                  <div className="mb-1 flex items-baseline justify-between gap-3">
                    <span className="text-sm text-slate-700">{humanise(status)}</span>
                    <span className="text-xs text-slate-500">
                      <span className="font-semibold tabular-nums text-slate-900">
                        {rows.length}
                      </span>
                      {' · '}
                      {formatCurrencyCompact(value)}
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full rounded-full ${
                        status === 'WON'
                          ? 'bg-emerald-500'
                          : status === 'LOST'
                            ? 'bg-rose-400'
                            : 'bg-slate-400'
                      }`}
                      style={{ width: `${(rows.length / maxStatus) * 100}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card>
          <CardHeader title="By owner" subtitle="Active workload per person" />
          <ul className="divide-y divide-slate-100">
            {Object.entries(bySource)
              .sort(([, a], [, b2]) => b2.length - a.length)
              .map(([owner, rows]) => {
                const active = rows.filter(
                  (lead) => lead.status !== 'WON' && lead.status !== 'LOST',
                );
                const value = active.reduce(
                  (sum, lead) => sum + Number(lead.estimatedValue ?? 0),
                  0,
                );
                const won = rows.filter((lead) => lead.status === 'WON').length;

                return (
                  <li key={owner} className="flex items-center justify-between px-5 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-900">{owner}</p>
                      <p className="text-xs text-slate-500">
                        {active.length} active · {won} won
                      </p>
                    </div>
                    <p className="shrink-0 text-sm font-semibold tabular-nums text-slate-900">
                      {formatCurrency(value)}
                    </p>
                  </li>
                );
              })}
          </ul>
        </Card>
      </div>

      <div className="mt-4">
        <PhaseNote phase="Phase 4">
          Computed in the browser from a single page of leads, which is fine at
          demo scale and wrong at real scale. The reporting endpoints in spec
          §20 — team, leads and conversion — replace this with SQL aggregation.
        </PhaseNote>
      </div>
    </>
  );
}

function groupBy<T>(rows: T[], key: (row: T) => string): Record<string, T[]> {
  return rows.reduce<Record<string, T[]>>((acc, row) => {
    const group = key(row);
    (acc[group] ??= []).push(row);
    return acc;
  }, {});
}
