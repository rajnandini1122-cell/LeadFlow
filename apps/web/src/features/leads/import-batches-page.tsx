import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { LeadImportBatchSummary } from '@leadflow/api-types';
import { apiGet } from '../../lib/api-client';
import { Card, CardHeader, EmptyState, ErrorNotice, PageHeader, SkeletonRows } from '../../components/ui';

/**
 * Past CSV imports.
 *
 * THE GAP THIS CLOSES. An import used to report a count and nothing else, so
 * once the response was closed there was no way to ask "which leads came from
 * that badly mapped file?" — correcting one meant finding its rows by eye.
 *
 * The two numbers that matter are on every row: how many leads the run created,
 * and how many of those are still live. A batch showing "40 created, 40
 * deactivated" is a run somebody has already cleaned up; one showing "40
 * created, 0 deactivated" with a wrong mapping is the work still to do.
 */
export function ImportBatchesPage(): React.JSX.Element {
  const batches = useQuery({
    queryKey: ['lead-import-batches'],
    queryFn: () => apiGet<LeadImportBatchSummary[]>('/leads/import/batches'),
  });

  return (
    <>
      <PageHeader
        title="Past imports"
        subtitle="What each run created, and how much of it is still live"
        action={
          <Link
            to="/leads/import"
            className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
          >
            Import a file
          </Link>
        }
      />

      <Card>
        {batches.isPending ? (
          <SkeletonRows />
        ) : batches.isError ? (
          <ErrorNotice message="Past imports could not be loaded. Please try again." />
        ) : (batches.data ?? []).length === 0 ? (
          <EmptyState
            title="No imports yet"
            description="Every CSV import appears here, with what it created."
          />
        ) : (
          <>
            <CardHeader
              title={`${(batches.data ?? []).length} ${
                (batches.data ?? []).length === 1 ? 'import' : 'imports'
              }`}
              subtitle="Newest first."
            />
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-100 text-xs text-slate-500">
                  <tr>
                    <th className="px-5 py-2 font-medium">File</th>
                    <th className="px-5 py-2 font-medium">When</th>
                    <th className="px-5 py-2 font-medium">By</th>
                    <th className="px-5 py-2 font-medium">Rows</th>
                    <th className="px-5 py-2 font-medium">Outcome</th>
                    <th className="px-5 py-2 font-medium">Still live</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {(batches.data ?? []).map((batch) => (
                    <BatchRow key={batch.id} batch={batch} />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </>
  );
}

function BatchRow({ batch }: { batch: LeadImportBatchSummary }): React.JSX.Element {
  const unfinished = batch.completedAt === null;

  return (
    <tr>
      <td className="px-5 py-3">
        <span className="font-medium text-slate-900">{batch.fileName ?? 'Unnamed file'}</span>
        {unfinished && (
          /* `completedAt` is written when the run finishes, so a null here is a
             run that was interrupted. Its leads still carry the batch id, which
             is the whole reason the batch row is written before the first
             lead. */
          <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
            Did not finish
          </span>
        )}
      </td>
      <td className="px-5 py-3 text-xs text-slate-500">
        {new Date(batch.startedAt).toLocaleString()}
      </td>
      <td className="px-5 py-3 text-xs text-slate-600">
        {batch.importedBy?.fullName ?? '—'}
      </td>
      <td className="px-5 py-3 tabular-nums text-slate-600">{batch.totalRows}</td>
      <td className="px-5 py-3 text-xs">
        <span className="text-emerald-700">{batch.created} created</span>
        {batch.skipped > 0 && <span className="text-amber-700"> · {batch.skipped} skipped</span>}
        {batch.failed > 0 && <span className="text-red-700"> · {batch.failed} failed</span>}
      </td>
      <td className="px-5 py-3 text-xs">
        {batch.created === 0 ? (
          <span className="text-slate-400">—</span>
        ) : (
          <Link
            to={`/leads?importBatchId=${batch.id}`}
            className="text-slate-900 underline tabular-nums"
          >
            {batch.activeLeads} of {batch.created}
          </Link>
        )}
        {batch.deactivatedLeads > 0 && (
          <span className="block text-slate-500">{batch.deactivatedLeads} deactivated</span>
        )}
      </td>
    </tr>
  );
}
