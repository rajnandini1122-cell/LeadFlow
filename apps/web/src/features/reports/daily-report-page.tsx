import { Link } from 'react-router-dom';
import {
  formatCurrency,
  formatCurrencyCompact,
  formatDate,
  formatDueDate,
  humanise,
} from '../../lib/format';
import { downloadCsv, exportFilename, toCsv } from '../../lib/export-csv';
import {
  Card,
  CardHeader,
  DueBadge,
  EmptyState,
  ErrorNotice,
  PageHeader,
  SkeletonRows,
  StatTile,
  StatusBadge,
} from '../../components/ui';
import { useAuth } from '../auth/auth-context';
import { useFollowUps, type FollowUp } from '../leads/use-lead-mutations';
import { useDailyReport, type DailyReport } from './use-reports';

/**
 * Daily report — the sheet a manager reads at the start of the day, or prints
 * for a morning huddle.
 *
 * Deliberately a single page: what is late, what is due, what came in, and what
 * closed. Every count is aggregated by the API over the whole dataset, and
 * "today" is a wall-clock day in the ORGANIZATION's timezone — the browser's
 * clock would give a travelling manager a different day from their team.
 */
export function DailyReportPage(): React.JSX.Element {
  const { user } = useAuth();
  const report = useDailyReport();
  const overdue = useFollowUps('overdue');
  const dueToday = useFollowUps('today');

  const actionable = [...(overdue.data ?? []), ...(dueToday.data ?? [])];

  const exportReport = (): void => {
    const csv = toCsv(actionable, [
      {
        header: 'Bucket',
        value: (item) => ((overdue.data ?? []).includes(item) ? 'Overdue' : 'Due today'),
      },
      { header: 'Lead number', value: (item) => item.leadNumber },
      { header: 'Name', value: (item) => item.leadName },
      { header: 'Company', value: (item) => item.companyName },
      { header: 'Mobile', value: (item) => item.mobile },
      { header: 'Lead status', value: (item) => humanise(item.leadStatus) },
      { header: 'Follow-up type', value: (item) => humanise(item.type) },
      { header: 'Scheduled', value: (item) => formatDueDate(item.scheduledAt) },
      { header: 'Owner', value: (item) => item.assignedTo.fullName },
    ]);

    downloadCsv(exportFilename('daily-report', user?.organization.slug ?? 'export'), csv);
  };

  if (report.isPending) {
    return (
      <>
        <PageHeader title="Daily report" />
        <Card>
          <SkeletonRows rows={6} />
        </Card>
      </>
    );
  }

  if (report.isError) {
    return (
      <Card>
        <ErrorNotice message="Could not build the report." />
      </Card>
    );
  }

  const data = report.data;

  return (
    <>
      <PageHeader
        title="Daily report"
        subtitle={`${formatDate(`${data.date}T00:00:00Z`)} · ${user?.organization.name}`}
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

      <p className="mb-4 text-xs text-slate-500">
        Day boundaries use <span className="font-medium text-slate-700">{data.timezone}</span>
        {data.scope === 'OWN' && (
          <>
            <span className="mx-1.5 text-slate-300">·</span>
            <span className="font-medium text-amber-700">Your leads only</span>
          </>
        )}
      </p>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Overdue"
          value={data.followUpsOverdue}
          tone={data.followUpsOverdue > 0 ? 'danger' : 'success'}
          hint="Open and past due, right now"
        />
        <StatTile
          label="Completed today"
          value={data.followUpsCompleted}
          tone={data.followUpsCompleted > 0 ? 'success' : 'default'}
          hint="Follow-ups closed off"
        />
        <StatTile label="New today" value={data.leadsCreated} hint="Leads added" />
        <StatTile
          label="Won today"
          value={data.leadsWon}
          tone="success"
          hint={formatCurrencyCompact(data.wonValueToday)}
        />
      </div>

      <div className="mt-6 space-y-6">
        <Card>
          <CardHeader
            title="Today’s outreach"
            subtitle="Counted from the activity timeline, not from what is on screen"
          />
          <dl className="grid grid-cols-2 divide-slate-100 sm:grid-cols-3 lg:grid-cols-6">
            <Metric label="Leads contacted" value={data.leadsContacted} />
            <Metric label="Calls completed" value={data.callsCompleted} />
            <Metric label="Not answered" value={data.callsNotAnswered} />
            <Metric label="WhatsApp" value={data.whatsappActivities} />
            <Metric label="Notes added" value={data.notesAdded} />
            <Metric label="Lost today" value={data.leadsLost} />
          </dl>
        </Card>

        <Card>
          <CardHeader
            title="Needs action today"
            subtitle={`${overdue.data?.length ?? 0} overdue · ${dueToday.data?.length ?? 0} due today`}
          />
          {overdue.isPending || dueToday.isPending ? (
            <SkeletonRows rows={4} />
          ) : actionable.length === 0 ? (
            <EmptyState
              icon="✓"
              title="Nothing outstanding"
              description="No overdue follow-ups and nothing due today."
            />
          ) : (
            <div className="overflow-x-auto">
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
                  {actionable.map((item) => (
                    <ActionRow key={item.id} followUp={item} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

function ActionRow({ followUp }: { followUp: FollowUp }): React.JSX.Element {
  return (
    <tr className="hover:bg-slate-50">
      <td className="px-5 py-2.5">
        <Link
          to={`/leads/${followUp.leadId}`}
          className="font-medium text-slate-900 hover:underline"
        >
          {followUp.leadName}
        </Link>
        <p className="text-xs text-slate-500">
          <span className="font-mono">{followUp.leadNumber}</span>
          {followUp.companyName ? ` · ${followUp.companyName}` : ''}
        </p>
      </td>
      <td className="px-3 py-2.5">
        <StatusBadge status={followUp.leadStatus as never} />
        <p className="mt-1 text-[11px] text-slate-500">{humanise(followUp.type)}</p>
      </td>
      <td className="px-3 py-2.5 text-slate-600">{followUp.assignedTo.fullName}</td>
      <td className="px-3 py-2.5 text-right font-medium tabular-nums text-slate-900">
        {formatCurrency(followUp.estimatedValue)}
      </td>
      <td className="px-5 py-2.5 text-right">
        <DueBadge iso={followUp.scheduledAt} label={formatDueDate(followUp.scheduledAt)} />
      </td>
    </tr>
  );
}

function Metric({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div className="border-t border-slate-100 px-5 py-3 first:border-t-0 sm:border-t-0">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-xl font-semibold tabular-nums text-slate-900">{value}</dd>
    </div>
  );
}

export type { DailyReport };
