import { Link } from 'react-router-dom';
import { formatCurrency, formatCurrencyCompact, formatDate, formatDueDate } from '../../lib/format';
import { downloadCsv, exportFilename, toCsv } from '../../lib/export-csv';
import {
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
 * Daily report — the sheet a manager reads at the start of the day, or prints
 * for a morning huddle.
 *
 * Deliberately a single page: what is late, what is due, what came in, and who
 * is carrying it. Anything that does not drive a decision today is left out.
 */
export function DailyReportPage(): React.JSX.Element {
  const { user } = useAuth();
  const leads = useLeads();

  if (leads.isPending) {
    return (
      <>
        <PageHeader title="Daily report" />
        <Card>
          <SkeletonRows rows={6} />
        </Card>
      </>
    );
  }

  if (leads.isError) {
    return (
      <Card>
        <ErrorNotice message="Could not build the report." />
      </Card>
    );
  }

  const b = bucketLeads(leads.data.items);
  const newToday = b.all.filter((lead) => isToday(lead.createdAt));

  const actionable = [...b.overdue, ...b.today];

  const byOwner = groupByOwner(b.active);

  const exportReport = (): void => {
    const csv = toCsv(actionable, [
      { header: 'Bucket', value: (lead) => (b.overdue.includes(lead) ? 'Overdue' : 'Due today') },
      { header: 'Lead number', value: (lead) => lead.leadNumber },
      { header: 'Name', value: (lead) => lead.name },
      { header: 'Company', value: (lead) => lead.companyName },
      { header: 'Mobile', value: (lead) => lead.mobile },
      { header: 'Status', value: (lead) => lead.status },
      { header: 'Priority', value: (lead) => lead.priority },
      { header: 'Value', value: (lead) => lead.estimatedValue ?? '' },
      { header: 'Follow-up', value: (lead) => formatDueDate(lead.nextFollowUpAt) },
      { header: 'Owner', value: (lead) => lead.assignedTo?.fullName ?? 'Unassigned' },
    ]);

    downloadCsv(exportFilename('daily-report', user?.organization.slug ?? 'export'), csv);
  };

  return (
    <>
      <PageHeader
        title="Daily report"
        subtitle={`${formatDate(new Date().toISOString())} · ${user?.organization.name}`}
        action={
          <div className="flex gap-2 print:hidden">
            <button
              type="button"
              onClick={exportReport}
              disabled={actionable.length === 0}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
            >
              Export CSV
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
            >
              Print
            </button>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Overdue"
          value={b.overdue.length}
          tone={b.overdue.length > 0 ? 'danger' : 'success'}
          hint={formatCurrencyCompact(sum(b.overdue)) + ' at risk'}
        />
        <StatTile label="Due today" value={b.today.length} tone={b.today.length > 0 ? 'warning' : 'default'} />
        <StatTile label="New today" value={newToday.length} hint="Leads added" />
        <StatTile
          label="Open pipeline"
          value={formatCurrencyCompact(b.pipelineValue)}
          hint={`${b.active.length} active leads`}
        />
      </div>

      <div className="mt-6 space-y-6">
        <Card>
          <CardHeader
            title="Needs action today"
            subtitle={`${b.overdue.length} overdue · ${b.today.length} due today`}
          />
          {actionable.length === 0 ? (
            <EmptyState
              icon="✓"
              title="Nothing outstanding"
              description="No overdue follow-ups and nothing due today."
            />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs text-slate-500">
                  <th className="px-5 py-2 font-medium">Lead</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Owner</th>
                  <th className="px-3 py-2 text-right font-medium">Value</th>
                  <th className="px-5 py-2 text-right font-medium">Follow-up</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {actionable.map((lead) => (
                  <tr key={lead.id} className="hover:bg-slate-50">
                    <td className="px-5 py-2.5">
                      <Link to={`/leads/${lead.id}`} className="font-medium text-slate-900 hover:underline">
                        {lead.name}
                      </Link>
                      <p className="text-xs text-slate-500">
                        <span className="font-mono">{lead.leadNumber}</span>
                        {lead.companyName ? ` · ${lead.companyName}` : ''}
                      </p>
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={lead.status} />
                      <div className="mt-1">
                        <PriorityBadge priority={lead.priority} />
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-slate-600">
                      {lead.assignedTo?.fullName ?? '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right font-medium tabular-nums text-slate-900">
                      {formatCurrency(lead.estimatedValue)}
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      <DueBadge iso={lead.nextFollowUpAt} label={formatDueDate(lead.nextFollowUpAt)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title="Workload by owner" subtitle="Active leads and overdue count" />
            {byOwner.length === 0 ? (
              <EmptyState title="No active leads" description="Nothing assigned right now." />
            ) : (
              <ul className="divide-y divide-slate-100">
                {byOwner.map(({ owner, rows }) => {
                  const overdue = rows.filter((lead) => b.overdue.includes(lead)).length;
                  return (
                    <li key={owner} className="flex items-center justify-between px-5 py-3">
                      <div>
                        <p className="text-sm font-medium text-slate-900">{owner}</p>
                        <p className="text-xs text-slate-500">
                          {rows.length} active
                          {overdue > 0 && (
                            <span className="ml-1.5 font-medium text-red-600">
                              · {overdue} overdue
                            </span>
                          )}
                        </p>
                      </div>
                      <p className="text-sm font-semibold tabular-nums text-slate-900">
                        {formatCurrencyCompact(sum(rows))}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Added today" />
            {newToday.length === 0 ? (
              <EmptyState title="No new leads today" description="Nothing captured yet." />
            ) : (
              <ul className="divide-y divide-slate-100">
                {newToday.map((lead) => (
                  <li key={lead.id} className="flex items-center justify-between px-5 py-3">
                    <div className="min-w-0">
                      <Link
                        to={`/leads/${lead.id}`}
                        className="truncate text-sm font-medium text-slate-900 hover:underline"
                      >
                        {lead.name}
                      </Link>
                      <p className="truncate text-xs text-slate-500">{lead.companyName}</p>
                    </div>
                    <StatusBadge status={lead.status} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <div className="mt-4 print:hidden">
        <PhaseNote phase="Phase 6">
          Built in the browser from the leads currently loaded. A scheduled
          version — emailed or pushed each morning, and driven by real follow-up
          records rather than each lead&rsquo;s next date — arrives with the
          follow-up engine and its worker.
        </PhaseNote>
      </div>
    </>
  );
}

function isToday(iso: string): boolean {
  const date = new Date(iso);
  const now = new Date();
  return (
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear()
  );
}

function sum(rows: LeadSummary[]): number {
  return rows.reduce((total, lead) => total + Number(lead.estimatedValue ?? 0), 0);
}

function groupByOwner(rows: LeadSummary[]): { owner: string; rows: LeadSummary[] }[] {
  const groups = new Map<string, LeadSummary[]>();

  for (const lead of rows) {
    const owner = lead.assignedTo?.fullName ?? 'Unassigned';
    groups.set(owner, [...(groups.get(owner) ?? []), lead]);
  }

  return [...groups.entries()]
    .map(([owner, ownerRows]) => ({ owner, rows: ownerRows }))
    .sort((a, b) => b.rows.length - a.rows.length);
}
