import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  CALL_OUTCOMES,
  CALL_OUTCOME_RULES,
  LEAD_STATUSES,
  type LeadLifecycleFilter,
  type LeadStatus,
} from '@leadflow/api-types';
import {
  formatCurrency,
  formatDate,
  formatDueDate,
  humanise,
} from '../../lib/format';
import {
  Card,
  EmptyState,
  ErrorNotice,
  PageHeader,
  SkeletonRows,
} from '../../components/ui';
import { useLeadsPage } from './use-leads';
import { ActionableLeadList } from './actionable-lead-list';
import { NewLeadDialog } from './new-lead-dialog';
import { downloadCsv, exportFilename, toCsv } from '../../lib/export-csv';
import { useAuth } from '../auth/auth-context';

const PAGE_SIZE = 25;

/**
 * The lead list.
 *
 * Search and status filtering are server-side, so they cover the whole
 * pipeline. Previously both ran in the browser over a first-100 page, which
 * meant searching for a customer created last month simply found nothing.
 */
export function LeadsPage(): React.JSX.Element {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<LeadStatus | 'ALL'>('ALL');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [lifecycle, setLifecycle] = useState<LeadLifecycleFilter>('ACTIVE');
  /*
   * Leads nobody owns. They cannot carry a follow-up row, so they appear in no
   * follow-up queue — this is the one place a manager can find them to assign.
   */
  const { user, can } = useAuth();
  const canSeeTeam = can('lead.view.all');

  /*
   * The import batch and the work filters come from the URL, not only from
   * controls on this page: they are arrived at by following a link (the import
   * result, the Follow-ups "Unassigned" button, a workspace tile), so the link
   * can be shared and the filter survives a refresh.
   */
  const [params, setParams] = useSearchParams();
  const importBatchId = params.get('importBatchId') ?? undefined;
  /*
   * Leads nobody owns. They cannot carry a follow-up row, so they appear in no
   * follow-up queue — this is the one place a manager can find them to assign.
   */
  const unassignedOnly = params.get('unassigned') === 'true';
  const freshOnly = params.get('fresh') === 'true';
  const awaitingOnly = params.get('awaiting') === 'true';
  const lastOutcome = params.get('lastOutcome') ?? '';
  const setFilter = (key: string, value: string | null): void => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  /*
   * The import batch comes from the URL, not from a control on this page.
   *
   * It is arrived at by following a link — from the import result or the batch
   * list — which means the link can be shared and reopened, and the screen that
   * fixes a bad import keeps working after a refresh. A piece of state only
   * this component knew would lose that.
   */
  // Debounced, because the search box now hits the API on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const leads = useLeadsPage(
    {
      search: search || undefined,
      status: status === 'ALL' ? undefined : status,
      ...(canSeeTeam && unassignedOnly ? { unassigned: true } : {}),
      ...(freshOnly ? { fresh: true } : {}),
      ...(awaitingOnly ? { awaiting: true } : {}),
      ...(lastOutcome ? { lastOutcome } : {}),
      /*
       * Filtering by batch shows ALL of it, deactivated rows included.
       *
       * The screen exists to correct a bad import, so it has to show what it is
       * about to act on — and after somebody deactivates half the batch, a list
       * that hid those rows would make the work look undone.
       */
      ...(importBatchId ? { importBatchId, lifecycle: 'ALL' as const } : { lifecycle }),
    },
    PAGE_SIZE,
  );

  const rows = useMemo(
    () => (leads.data?.pages ?? []).flatMap((page) => page.items),
    [leads.data],
  );

  const total = leads.data?.pages[0]?.total ?? null;

  /**
   * Exports the rows currently loaded — what is on screen, nothing hidden.
   *
   * Deliberately not "export everything matching": that would silently download
   * a different dataset from the one being looked at, and a server-streamed
   * export belongs on the reports API rather than here.
   */
  const exportRows = (): void => {
    const csv = toCsv(rows, [
      { header: 'Lead number', value: (lead) => lead.leadNumber },
      { header: 'Name', value: (lead) => lead.name },
      { header: 'Company', value: (lead) => lead.companyName },
      { header: 'Mobile', value: (lead) => lead.mobile },
      { header: 'Status', value: (lead) => humanise(lead.status) },
      { header: 'Priority', value: (lead) => humanise(lead.priority) },
      { header: 'Estimated value', value: (lead) => lead.estimatedValue ?? '' },
      {
        header: 'Estimated value (formatted)',
        value: (lead) => formatCurrency(lead.estimatedValue),
      },
      { header: 'Next follow-up', value: (lead) => formatDate(lead.nextFollowUpAt) },
      { header: 'Follow-up status', value: (lead) => formatDueDate(lead.nextFollowUpAt) },
      { header: 'Owner', value: (lead) => lead.assignedTo?.fullName ?? 'Unassigned' },
      { header: 'Created', value: (lead) => formatDate(lead.createdAt) },
    ]);

    downloadCsv(exportFilename('leads', user?.organization.slug ?? 'export'), csv);
  };

  return (
    <>
      <PageHeader
        title="Leads"
        subtitle={
          leads.isPending
            ? 'Loading leads…'
            : total === null
              ? `${rows.length} leads`
              : rows.length >= total
                ? `${total} ${total === 1 ? 'lead' : 'leads'}`
                : `Showing ${rows.length} of ${total}`
        }
        action={
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={exportRows}
              disabled={rows.length === 0}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
            >
              Export loaded
            </button>
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
                onClick={() => setDialogOpen(true)}
                className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
              >
                + New lead
              </button>
            )}
          </div>
        }
      />

      <NewLeadDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />

      <div className="mb-4 space-y-3">
        <input
          type="search"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="Search name, company or mobile…"
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition placeholder:text-slate-400 focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
        />

        <div className="flex flex-wrap gap-1.5">
          <FilterChip label="All" active={status === 'ALL'} onClick={() => setStatus('ALL')} />
          {LEAD_STATUSES.map((key) => (
            <FilterChip
              key={key}
              label={humanise(key)}
              active={status === key}
              onClick={() => setStatus(key)}
            />
          ))}
        </div>

        {/*
          A SEPARATE row from the status chips, deliberately.
          Deactivated is not a pipeline stage — it is orthogonal to every stage,
          and putting it in the same row as NEW and WON would read as though it
          were one of them. The three states that mean "not live work" —
          deactivated, archived and LOST — are different things, and this
          control only reaches the first.
        */}
        {!importBatchId && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs text-slate-500">Show</span>
            <FilterChip
              label="In the pipeline"
              active={lifecycle === 'ACTIVE'}
              onClick={() => setLifecycle('ACTIVE')}
            />
            <FilterChip
              label="Deactivated"
              active={lifecycle === 'INACTIVE'}
              onClick={() => setLifecycle('INACTIVE')}
            />
            <FilterChip
              label="Both"
              active={lifecycle === 'ALL'}
              onClick={() => setLifecycle('ALL')}
            />
            {canSeeTeam && (
              <>
                <span className="mx-1 h-4 w-px bg-slate-200" aria-hidden />
                <FilterChip
                  label="Unassigned only"
                  active={unassignedOnly}
                  onClick={() => setFilter('unassigned', unassignedOnly ? null : 'true')}
                />
              </>
            )}
          </div>
        )}

        {/*
          WORK filters — what happened on the phone, not where the deal is. A
          separate row from the stage chips so a call outcome is never mistaken
          for a sales stage.
        */}
        {!importBatchId && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs text-slate-500">Work</span>
            <FilterChip
              label="New — not reached yet"
              active={freshOnly}
              onClick={() => setFilter('fresh', freshOnly ? null : 'true')}
            />
            <FilterChip
              label="Awaiting response"
              active={awaitingOnly}
              onClick={() => setFilter('awaiting', awaitingOnly ? null : 'true')}
            />
            <label className="ml-1 flex items-center gap-1.5 text-xs text-slate-500">
              Last call
              <select
                value={lastOutcome}
                onChange={(event) => setFilter('lastOutcome', event.target.value || null)}
                className="rounded-full border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
              >
                <option value="">Any</option>
                {CALL_OUTCOMES.map((code) => (
                  <option key={code} value={code}>
                    {CALL_OUTCOME_RULES[code].label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {importBatchId && (
          <p className="flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700">
            <span>Showing one CSV import only, including any rows already deactivated.</span>
            <Link to="/leads" className="underline">
              Show everything
            </Link>
          </p>
        )}
      </div>

      <Card>
        {leads.isPending ? (
          <SkeletonRows rows={8} />
        ) : leads.isError ? (
          <ErrorNotice message="Could not load leads." />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="⌕"
            title="No leads match"
            description={
              search || status !== 'ALL' || freshOnly || awaitingOnly || lastOutcome || unassignedOnly
                ? 'Try clearing the search box or the filters above.'
                : 'Add your first lead, or import a CSV file.'
            }
          />
        ) : (
          <>
            <ActionableLeadList leads={rows} />

            {leads.hasNextPage && (
              <div className="border-t border-slate-100 p-4 text-center">
                <button
                  type="button"
                  onClick={() => void leads.fetchNextPage()}
                  disabled={leads.isFetchingNextPage}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                >
                  {leads.isFetchingNextPage ? 'Loading…' : `Load ${PAGE_SIZE} more`}
                </button>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-medium transition ${
        active
          ? 'bg-slate-900 text-white'
          : 'bg-white text-slate-600 ring-1 ring-slate-200 ring-inset hover:bg-slate-50'
      }`}
    >
      {label}
    </button>
  );
}

