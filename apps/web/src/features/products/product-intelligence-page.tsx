import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardHeader, ErrorNotice, PageHeader, SkeletonRows } from '../../components/ui';
import {
  formatKpi,
  TREND_PRESENTATION,
  useProductByAgent,
  useProductBySource,
  useProductLossAnalysis,
  useProductPerformance,
  type ProductPerformanceRow,
} from './use-products';

/**
 * Product intelligence.
 *
 * Answers, from live data: what are customers asking for, what is trending,
 * what converts, and why we lose.
 *
 * The discipline throughout is what it REFUSES to show. Every figure here can
 * legitimately be uncomputable, and the server sends null rather than zero in
 * those cases — a win rate for a product nothing has closed on, a trend from
 * two leads. These numbers get quoted in meetings, so an em dash is the honest
 * output and a confident zero is not.
 */

const RANGES = [
  { value: 'last_7_days', label: 'Last 7 days' },
  { value: 'last_30_days', label: 'Last 30 days' },
  { value: 'last_90_days', label: 'Last 90 days' },
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
] as const;

export function ProductIntelligencePage(): React.JSX.Element {
  const [range, setRange] = useState<string>('last_30_days');

  const performance = useProductPerformance(range);
  const bySource = useProductBySource();
  const byAgent = useProductByAgent();
  const loss = useProductLossAnalysis();

  const items = performance.data?.items ?? [];
  const totals = performance.data?.totals;

  return (
    <>
      <PageHeader
        title="Product intelligence"
        subtitle="What customers are asking for, and what actually converts."
        action={
          <select
            value={range}
            onChange={(event) => setRange(event.target.value)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
            aria-label="Comparison period"
          >
            {RANGES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        }
      />

      {performance.isPending ? (
        <SkeletonRows rows={6} />
      ) : performance.isError ? (
        <ErrorNotice message="Could not load product figures." />
      ) : items.length === 0 ? (
        <Card>
          <p className="p-8 text-center text-sm text-pretty text-slate-500">
            No leads have a product yet. Add products in{' '}
            <Link to="/products" className="underline">
              the catalogue
            </Link>
            , then assign them on leads — the figures here appear as soon as they do.
          </p>
        </Card>
      ) : (
        <>
          {/*
            Coverage first, deliberately.
            Every figure below covers only leads that HAVE a product. Without
            this line a dashboard built on a fraction of the business looks
            like it covers all of it.
          */}
          {totals && (
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <Stat label="Products with demand" value={formatKpi(totals.productsWithDemand)} />
              <Stat label="Leads with a product" value={formatKpi(totals.leadsWithProduct)} />
              <Stat
                label="Leads with none"
                value={formatKpi(totals.leadsWithoutProduct)}
                tone={totals.leadsWithoutProduct > 0 ? 'warn' : 'default'}
                hint={
                  totals.leadsWithoutProduct > 0
                    ? 'Not counted in anything below'
                    : 'Everything is classified'
                }
              />
            </div>
          )}

          <div className="mb-6 grid gap-4 lg:grid-cols-2">
            <TrendPanel items={items} />
            <LossPanel loss={loss.data?.items ?? []} loading={loss.isPending} />
          </div>

          <PerformanceTable items={items} />

          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <SourcePanel data={bySource.data} loading={bySource.isPending} />
            <AgentPanel data={byAgent.data} loading={byAgent.isPending} />
          </div>
        </>
      )}
    </>
  );
}

/**
 * Rising and falling demand.
 *
 * A percentage appears only where the sample supports one; everything else
 * shows the raw counts with a direction. A dashboard that prints "+50%" for one
 * extra enquiry trains people to ignore every percentage on it.
 */
function TrendPanel({ items }: { items: ProductPerformanceRow[] }): React.JSX.Element {
  const withTrend = items.filter((item) => item.trend !== null);

  const ranked = [...withTrend].sort((a, b) => {
    const order: Record<string, number> = { rising: 0, new: 1, stable: 2, falling: 3 };
    const byDirection =
      (order[a.trend?.direction ?? 'stable'] ?? 2) - (order[b.trend?.direction ?? 'stable'] ?? 2);
    if (byDirection !== 0) return byDirection;
    return (b.trend?.current ?? 0) - (a.trend?.current ?? 0);
  });

  return (
    <Card>
      <CardHeader title="Demand trend" subtitle="Against the previous period of equal length" />

      {ranked.length === 0 ? (
        <p className="p-6 text-sm text-slate-500">
          No enquiries in this period, so there is nothing to compare.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {ranked.slice(0, 8).map((item) => {
            const trend = item.trend!;
            const presentation = TREND_PRESENTATION[trend.direction];

            return (
              <li key={item.productId} className="flex items-center gap-3 px-5 py-3">
                <span aria-hidden="true" className={`shrink-0 ${presentation.tone}`}>
                  {presentation.icon}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{item.name}</span>

                <span className="shrink-0 text-right">
                  {trend.change !== null ? (
                    <span className={`text-sm font-medium tabular-nums ${presentation.tone}`}>
                      {trend.change > 0 ? '+' : ''}
                      {Math.round(trend.change * 100)}%
                    </span>
                  ) : (
                    /*
                      No percentage: either no previous period to divide by, or
                      too few leads for one to mean anything. The counts say
                      everything the percentage would have, honestly.
                    */
                    <span className="text-xs text-slate-500 tabular-nums">
                      {trend.previous} → {trend.current}
                    </span>
                  )}
                  {trend.change !== null && (
                    <span className="ml-2 text-xs text-slate-400 tabular-nums">
                      ({trend.previous} → {trend.current})
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function LossPanel({
  loss,
  loading,
}: {
  loss: { productId: string; name: string; lostLeads: number; reasons: { reason: string; count: number }[] }[];
  loading: boolean;
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader title="Why we lose" subtitle="Lost deals by reason, per product" />

      {loading ? (
        <SkeletonRows rows={3} />
      ) : loss.length === 0 ? (
        <p className="p-6 text-sm text-slate-500">No lost deals with a product yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {loss.slice(0, 4).map((item) => (
            <li key={item.productId} className="px-5 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-sm font-medium text-slate-800">{item.name}</span>
                <span className="shrink-0 text-xs text-slate-500 tabular-nums">
                  {item.lostLeads} lost
                </span>
              </div>
              <ul className="mt-1.5 space-y-1">
                {item.reasons.slice(0, 4).map((reason) => (
                  <li
                    key={reason.reason}
                    className="flex justify-between gap-3 text-xs text-slate-600"
                  >
                    <span className="truncate">{reason.reason}</span>
                    <span className="shrink-0 tabular-nums">{reason.count}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** The primary management view. */
function PerformanceTable({ items }: { items: ProductPerformanceRow[] }): React.JSX.Element {
  const [sort, setSort] = useState<keyof ProductPerformanceRow>('totalLeads');

  const sorted = [...items].sort((a, b) => {
    const left = a[sort];
    const right = b[sort];
    // Nulls last: a product with no computable figure should not top the sort.
    if (left === null) return 1;
    if (right === null) return -1;
    return Number(right) - Number(left);
  });

  const columns: { key: keyof ProductPerformanceRow; label: string }[] = [
    { key: 'totalLeads', label: 'Leads' },
    { key: 'openPipeline', label: 'Open pipeline' },
    { key: 'wonLeads', label: 'Won' },
    { key: 'wonValue', label: 'Won value' },
    { key: 'winRate', label: 'Win rate' },
    { key: 'averageWonValue', label: 'Avg deal' },
    { key: 'averageDaysToClose', label: 'Avg days' },
  ];

  return (
    <Card>
      <CardHeader
        title="Product performance"
        subtitle="Sorted by demand. A dash means the figure cannot yet be calculated."
      />

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">Product</th>
              {columns.map((column) => (
                <th key={column.key} className="px-4 py-2.5 text-right font-medium">
                  <button
                    type="button"
                    onClick={() => setSort(column.key)}
                    className={`transition hover:text-slate-900 ${
                      sort === column.key ? 'text-slate-900 underline' : ''
                    }`}
                  >
                    {column.label}
                  </button>
                </th>
              ))}
              <th className="px-4 py-2.5 text-right font-medium">Forecast</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sorted.map((item) => (
              <tr key={item.productId}>
                <td className="px-4 py-3">
                  <Link
                    to={`/leads?productId=${item.productId}`}
                    className="font-medium text-slate-900 hover:underline"
                  >
                    {item.name}
                  </Link>
                  {!item.active && (
                    <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
                      retired
                    </span>
                  )}
                  {item.demandShare !== null && (
                    <span className="ml-2 text-xs text-slate-400">
                      {Math.round(item.demandShare * 100)}% of demand
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{formatKpi(item.totalLeads)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{formatKpi(item.openPipeline)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{formatKpi(item.wonLeads)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{formatKpi(item.wonValue)}</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {item.winRate !== null && item.winRateReliable ? (
                    formatKpi(item.winRate, 'percent')
                  ) : item.wonLeads + item.lostLeads > 0 ? (
                    /*
                      Too few closed deals for a percentage. The counts are
                      shown instead — "100%" off a single sale is worse than
                      no number.
                    */
                    <span
                      className="text-xs text-slate-500"
                      title="Too few closed deals for a reliable rate"
                    >
                      {item.wonLeads}/{item.wonLeads + item.lostLeads}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatKpi(item.averageWonValue)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {item.averageDaysToClose === null ? '—' : `${item.averageDaysToClose}d`}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {item.forecast.accuracy === null ? (
                    '—'
                  ) : (
                    <span
                      title={`Estimated ${formatKpi(item.forecast.estimated)}, closed at ${formatKpi(
                        item.forecast.actual,
                      )}`}
                    >
                      {formatKpi(item.forecast.accuracy, 'percent')}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function SourcePanel({
  data,
  loading,
}: {
  data: { sources: string[]; items: { productId: string; name: string; counts: Record<string, number> }[] } | undefined;
  loading: boolean;
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader title="Product by channel" subtitle="Where demand for each product comes from" />

      {loading ? (
        <SkeletonRows rows={3} />
      ) : !data || data.items.length === 0 ? (
        <p className="p-6 text-sm text-slate-500">Nothing to break down yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Product</th>
                {data.sources.map((source) => (
                  <th key={source} className="px-4 py-2.5 text-right font-medium">
                    {source}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.items.slice(0, 10).map((item) => (
                <tr key={item.productId}>
                  <td className="px-4 py-2.5 truncate">{item.name}</td>
                  {data.sources.map((source) => (
                    <td key={source} className="px-4 py-2.5 text-right tabular-nums">
                      {item.counts[source] ?? '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function AgentPanel({
  data,
  loading,
}: {
  data:
    | {
        items: {
          productId: string;
          productName: string;
          agentName: string;
          leads: number;
          wonDeals: number;
          winRate: number | null;
          winRateReliable: boolean;
        }[];
      }
    | undefined;
  loading: boolean;
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader title="Product by salesperson" subtitle="Who converts demand for what" />

      {loading ? (
        <SkeletonRows rows={3} />
      ) : !data || data.items.length === 0 ? (
        <p className="p-6 text-sm text-slate-500">Nothing to break down yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Product</th>
                <th className="px-4 py-2.5 font-medium">Salesperson</th>
                <th className="px-4 py-2.5 text-right font-medium">Leads</th>
                <th className="px-4 py-2.5 text-right font-medium">Won</th>
                <th className="px-4 py-2.5 text-right font-medium">Win rate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {[...data.items]
                .sort((a, b) => b.leads - a.leads)
                .slice(0, 12)
                .map((item) => (
                  <tr key={`${item.productId}:${item.agentName}`}>
                    <td className="px-4 py-2.5 truncate">{item.productName}</td>
                    <td className="px-4 py-2.5 truncate text-slate-600">{item.agentName}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{item.leads}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{item.wonDeals}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {item.winRate !== null && item.winRateReliable
                        ? formatKpi(item.winRate, 'percent')
                        : '—'}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Stat({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'warn';
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p
        className={`mt-1 text-2xl font-semibold tabular-nums ${
          tone === 'warn' ? 'text-amber-600' : 'text-slate-900'
        }`}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}
