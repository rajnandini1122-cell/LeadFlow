import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { LEAD_STATUSES, type LeadStatus } from '@idea001/api-types';
import { formatCurrency, formatCurrencyCompact, formatDate, formatDueDate, humanise } from '../../lib/format';
import {
  Avatar,
  Card,
  DueBadge,
  EmptyState,
  ErrorNotice,
  PageHeader,
  PhaseNote,
  PriorityBadge,
  SkeletonRows,
  StatusBadge,
} from '../../components/ui';
import { useLeads, type LeadSummary } from './use-leads';
import { NewLeadDialog } from './new-lead-dialog';
import { downloadCsv, exportFilename, toCsv } from '../../lib/export-csv';
import { useAuth } from '../auth/auth-context';

type SortKey = 'due' | 'value' | 'created';

export function LeadsPage(): React.JSX.Element {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<LeadStatus | 'ALL'>('ALL');
  const [sort, setSort] = useState<SortKey>('due');
  const [dialogOpen, setDialogOpen] = useState(false);
  const { user, can } = useAuth();

  const leads = useLeads();

  // Filtering happens client-side because Phase 1 loads one page of leads. The
  // API already supports `status` and `search` params, so this moves server-side
  // unchanged once the dataset outgrows a single page.
  const rows = useMemo(() => {
    const all = leads.data?.items ?? [];
    const term = search.trim().toLowerCase();

    const filtered = all.filter((lead) => {
      if (status !== 'ALL' && lead.status !== status) return false;
      if (!term) return true;
      return [lead.name, lead.companyName, lead.mobile, lead.leadNumber]
        .filter(Boolean)
        .some((field) => (field as string).toLowerCase().includes(term));
    });

    return [...filtered].sort((a, b) => {
      if (sort === 'value') return Number(b.estimatedValue ?? 0) - Number(a.estimatedValue ?? 0);
      if (sort === 'created') return b.createdAt.localeCompare(a.createdAt);
      // Due: leads with no next action sort last rather than first.
      return (a.nextFollowUpAt ?? '9999').localeCompare(b.nextFollowUpAt ?? '9999');
    });
  }, [leads.data, search, status, sort]);

  const counts = useMemo(() => {
    const all = leads.data?.items ?? [];
    return LEAD_STATUSES.reduce<Record<string, number>>(
      (acc, key) => ({ ...acc, [key]: all.filter((lead) => lead.status === key).length }),
      { ALL: all.length },
    );
  }, [leads.data]);

  /** Exports exactly what is on screen — current filter, current sort. */
  const exportRows = (): void => {
    const csv = toCsv(rows, [
      { header: 'Lead number', value: (lead) => lead.leadNumber },
      { header: 'Name', value: (lead) => lead.name },
      { header: 'Company', value: (lead) => lead.companyName },
      { header: 'Mobile', value: (lead) => lead.mobile },
      { header: 'Status', value: (lead) => humanise(lead.status) },
      { header: 'Priority', value: (lead) => humanise(lead.priority) },
      { header: 'Estimated value', value: (lead) => lead.estimatedValue ?? '' },
      { header: 'Estimated value (formatted)', value: (lead) => formatCurrency(lead.estimatedValue) },
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
          leads.data ? `${rows.length} of ${leads.data.items.length} leads` : 'Loading leads…'
        }
        action={
          <div className="flex gap-2">
            <button
              type="button"
              onClick={exportRows}
              disabled={rows.length === 0}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
            >
              Export CSV
            </button>
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
        <div className="flex flex-wrap gap-2">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search name, company, mobile or lead number…"
            className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition placeholder:text-slate-400 focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
          />
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as SortKey)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-900"
            aria-label="Sort leads"
          >
            <option value="due">Sort: follow-up date</option>
            <option value="value">Sort: deal value</option>
            <option value="created">Sort: newest</option>
          </select>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <FilterChip
            label="All"
            count={counts['ALL'] ?? 0}
            active={status === 'ALL'}
            onClick={() => setStatus('ALL')}
          />
          {LEAD_STATUSES.map((key) => (
            <FilterChip
              key={key}
              label={humanise(key)}
              count={counts[key] ?? 0}
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
                : 'Run the seed script to load demo data.'
            }
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((lead) => (
              <LeadListItem key={lead.id} lead={lead} />
            ))}
          </ul>
        )}
      </Card>

      <div className="mt-4">
        <PhaseNote phase="Phase 2">
          Creating leads and duplicate detection are implemented. Editing an
          existing lead, reassigning it and status-transition rules still belong
          to the Lead CRM phase. Export runs in the browser over the rows
          currently loaded, so it reflects your filter and sort.
        </PhaseNote>
      </div>
    </>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
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
      <span className={`ml-1.5 tabular-nums ${active ? 'text-slate-300' : 'text-slate-400'}`}>
        {count}
      </span>
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
