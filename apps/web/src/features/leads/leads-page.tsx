import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { LEAD_STATUSES, type LeadStatus } from '@leadflow/api-types';
import {
  formatCurrency,
  formatCurrencyCompact,
  formatDate,
  formatDueDate,
  humanise,
} from '../../lib/format';
import {
  Avatar,
  Card,
  DueBadge,
  EmptyState,
  ErrorNotice,
  PageHeader,
  PriorityBadge,
  SkeletonRows,
  StatusBadge,
} from '../../components/ui';
import { useLeadsPage, type LeadSummary } from './use-leads';
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
  const { user, can } = useAuth();

  // Debounced, because the search box now hits the API on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const leads = useLeadsPage(
    {
      search: search || undefined,
      status: status === 'ALL' ? undefined : status,
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
              search || status !== 'ALL'
                ? 'Try clearing the search box or choosing a different status.'
                : 'Add your first lead, or import a CSV file.'
            }
          />
        ) : (
          <>
            <ul className="divide-y divide-slate-100">
              {rows.map((lead) => (
                <LeadListItem key={lead.id} lead={lead} />
              ))}
            </ul>

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

function LeadListItem({ lead }: { lead: LeadSummary }): React.JSX.Element {
  return (
    <li>
      <Link
        to={`/leads/${lead.id}`}
        className="flex items-center gap-3 px-5 py-3.5 transition hover:bg-slate-50"
      >
        <Avatar name={lead.name} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="truncate text-sm font-medium text-slate-900">{lead.name}</p>
            <StatusBadge status={lead.status} />
            <PriorityBadge priority={lead.priority} />
          </div>
          <p className="mt-1 truncate text-xs text-slate-500">
            <span className="font-mono text-slate-400">{lead.leadNumber}</span>
            {lead.companyName ? ` · ${lead.companyName}` : ''}
            {lead.mobile ? ` · ${lead.mobile}` : ''}
          </p>
        </div>

        <div className="shrink-0 text-right">
          <p className="text-sm font-semibold tabular-nums text-slate-900">
            {formatCurrencyCompact(lead.estimatedValue)}
          </p>
          <div className="mt-1">
            <DueBadge iso={lead.nextFollowUpAt} label={formatDueDate(lead.nextFollowUpAt)} />
          </div>
        </div>

        <div className="hidden w-32 shrink-0 items-center gap-2 md:flex">
          {lead.assignedTo ? (
            <>
              <Avatar name={lead.assignedTo.fullName} size="sm" />
              <span className="truncate text-xs text-slate-500">
                {lead.assignedTo.fullName.split(' ')[0]}
              </span>
            </>
          ) : (
            <span className="text-xs text-slate-400">Unassigned</span>
          )}
        </div>
      </Link>
    </li>
  );
}
