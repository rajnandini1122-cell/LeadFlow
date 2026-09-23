import { useState } from 'react';
import { Card, CardHeader, ErrorNotice, PageHeader, SkeletonRows } from '../../components/ui';
import {
  formatCustomerKpi,
  useCustomerOverview,
  useDemandByCustomerType,
  useTopCustomers,
} from './use-accounts';

const RANGES = [
  { value: 'last_30_days', label: 'Last 30 days' },
  { value: 'last_90_days', label: 'Last 90 days' },
  { value: 'this_month', label: 'This month' },
  { value: '', label: 'All time' },
];

/**
 * Customer KPIs — acquisition, retention and repeat business.
 *
 * Every figure that cannot be calculated renders as an em dash, never a zero.
 * A "0% repeat rate" for an organization with three customers and no history
 * describes a retention problem that does not exist, and somebody will act on
 * it.
 *
 * Where a rate is withheld for a small sample, the underlying COUNTS are shown
 * instead — they say exactly as much and claim less.
 */
export function CustomerKpiPage(): React.JSX.Element {
  const [range, setRange] = useState('last_90_days');

  const overview = useCustomerOverview(range || undefined);
  const top = useTopCustomers(range || undefined);
  const demand = useDemandByCustomerType(range || undefined);

  return (
    <>
      <PageHeader
        title="Customer KPIs"
        subtitle="Are you growing by winning new customers, or by selling more to the ones you have?"
        action={
          <select
            value={range}
            onChange={(event) => setRange(event.target.value)}
            aria-label="Date range"
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
          >
            {RANGES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        }
      />

      {overview.isPending ? (
        <SkeletonRows rows={4} />
      ) : overview.isError ? (
        <ErrorNotice message="Could not load customer KPIs." />
      ) : (
        <>
          <div className="mb-4 grid gap-px overflow-hidden rounded-xl bg-slate-200 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Prospects" value={String(overview.data.counts.prospects)} note="Never bought" />
            <Tile
              label="Customers"
              value={String(overview.data.counts.customers)}
              note={
                overview.data.newCustomers !== null
                  ? `${overview.data.newCustomers} new this period`
                  : undefined
              }
            />
            <Tile label="Dormant" value={String(overview.data.counts.dormant)} note="Gone quiet" />
            <Tile
              label="Former"
              value={String(overview.data.counts.formerCustomers)}
              note="Churned or written off"
            />
          </div>

          <div className="mb-4 grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="Repeat business"
                subtitle="The clearest signal of whether the relationship is working."
              />
              <dl className="divide-y divide-slate-100">
                <Row
                  label="Customers who bought more than once"
                  value={`${overview.data.repeat.customersWithMultipleWins} of ${overview.data.repeat.customersWithAnyWin}`}
                />
                <Row
                  label="Repeat rate"
                  value={formatCustomerKpi(overview.data.repeat.repeatRate, 'percent')}
                  // The honest caveat, in place rather than in a footnote.
                  note={
                    overview.data.repeat.repeatRate === null
                      ? 'Too few paying customers for a percentage to mean anything yet.'
                      : undefined
                  }
                />
                <Row
                  label="Average deals per customer"
                  value={
                    overview.data.repeat.averageWinsPerCustomer === null
                      ? '—'
                      : (Math.round(overview.data.repeat.averageWinsPerCustomer * 10) / 10).toString()
                  }
                />
                <Row
                  label="Prospect to customer"
                  value={formatCustomerKpi(overview.data.conversionRate, 'percent')}
                  note={
                    overview.data.conversionRate === null
                      ? 'Too few accounts on record to compute a conversion rate.'
                      : undefined
                  }
                />
              </dl>
            </Card>

            <Card>
              <CardHeader title="Revenue" subtitle="Won opportunity value, not invoiced revenue." />
              <dl className="divide-y divide-slate-100">
                <Row
                  label="Total won"
                  value={formatCustomerKpi(overview.data.value.totalWonValue, 'currency')}
                />
                <Row
                  label="From repeat purchases"
                  value={formatCustomerKpi(overview.data.value.repeatWonValue, 'currency')}
                  note="Every deal after a customer's first."
                />
                <Row
                  label="Share from repeat business"
                  value={formatCustomerKpi(overview.data.value.repeatRevenueShare, 'percent')}
                />
                <Row
                  label="Average customer value"
                  value={formatCustomerKpi(overview.data.value.averageCustomerValue, 'currency')}
                />
              </dl>
            </Card>
          </div>
        </>
      )}

      {/* Product demand, split by who is asking — the question the whole
          feature was built to answer. */}
      <Card className="mb-4">
        <CardHeader
          title="Product demand — new prospects vs existing customers"
          subtitle="Whether growth comes from new customers or from selling more to the ones you have."
        />

        {demand.isPending ? (
          <SkeletonRows rows={5} />
        ) : demand.isError ? (
          <ErrorNotice message="Could not load product demand." />
        ) : demand.data.items.length === 0 ? (
          <p className="p-8 text-center text-sm text-slate-500">
            No leads have a product attached yet.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Product</th>
                    <th className="px-4 py-2.5 text-right font-medium">New prospects</th>
                    <th className="px-4 py-2.5 text-right font-medium">Existing customers</th>
                    <th className="px-4 py-2.5 text-right font-medium">Unattributed</th>
                    <th className="px-4 py-2.5 text-right font-medium">Total</th>
                    <th className="px-4 py-2.5 text-right font-medium">From customers</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {demand.data.items.map((row) => (
                    <tr key={row.productId}>
                      <td className="px-4 py-3">
                        <span className="font-medium text-slate-900">{row.name}</span>
                        {!row.active && <span className="ml-2 text-xs text-slate-400">retired</span>}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{row.prospect}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{row.existingCustomer}</td>
                      {/* Shown, never folded into either side. */}
                      <td className="px-4 py-3 text-right tabular-nums text-slate-400">
                        {row.unknown}
                      </td>
                      <td className="px-4 py-3 text-right font-medium tabular-nums">{row.total}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatCustomerKpi(row.existingCustomerShare, 'percent')}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-slate-200 bg-slate-50 text-sm font-medium">
                  <tr>
                    <td className="px-4 py-3">All products</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {demand.data.totals.prospect}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {demand.data.totals.existingCustomer}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-400">
                      {demand.data.totals.unknown}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{demand.data.totals.total}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatCustomerKpi(demand.data.totals.existingCustomerShare, 'percent')}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/*
              Coverage, stated plainly. Without it a breakdown built on a
              fraction of the business looks like it covers all of it.
            */}
            <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
              {demand.data.coverage.leadsWithoutAccount} lead
              {demand.data.coverage.leadsWithoutAccount === 1 ? ' has' : 's have'} no customer
              attached and {demand.data.coverage.leadsWithoutAccount === 1 ? 'is' : 'are'} counted
              as unattributed. {demand.data.coverage.leadsWithoutProduct} have no product and are
              not counted at all.
            </p>
          </>
        )}
      </Card>

      <Card>
        <CardHeader title="Top customers" subtitle="By won opportunity value." />

        {top.isPending ? (
          <SkeletonRows rows={5} />
        ) : top.isError ? (
          <ErrorNotice message="Could not load top customers." />
        ) : top.data.items.length === 0 ? (
          <p className="p-8 text-center text-sm text-slate-500">Nothing has been won yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Customer</th>
                  <th className="px-4 py-2.5 text-right font-medium">Deals</th>
                  <th className="px-4 py-2.5 text-right font-medium">Won value</th>
                  <th className="px-4 py-2.5 text-right font-medium">Average deal</th>
                  <th className="px-4 py-2.5 font-medium">Last won</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {top.data.items.map((row) => (
                  <tr key={row.accountId}>
                    <td className="px-4 py-3">
                      <span className="font-medium text-slate-900">{row.name}</span>
                      {row.isRepeatCustomer && (
                        <span className="ml-2 rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-800">
                          repeat
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{row.wonDeals}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatCustomerKpi(row.wonValue, 'currency')}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatCustomerKpi(row.averageDealValue, 'currency')}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {row.lastWonAt ? new Date(row.lastWonAt).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function Tile({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string | undefined;
}): React.JSX.Element {
  return (
    <div className="bg-white p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</p>
      {note && <p className="mt-0.5 text-xs text-slate-400">{note}</p>}
    </div>
  );
}

function Row({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string | undefined;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <dt className="text-sm text-slate-600">{label}</dt>
        {note && <p className="mt-0.5 text-xs text-slate-400">{note}</p>}
      </div>
      <dd className="shrink-0 text-sm font-medium tabular-nums text-slate-900">{value}</dd>
    </div>
  );
}
