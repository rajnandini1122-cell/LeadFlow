import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Card, EmptyState, ErrorNotice, PageHeader, SkeletonRows } from '../../components/ui';
import { formatDate } from '../../lib/format';
import { useAuth } from '../auth/auth-context';
import { useWorkspaceSummary, type FollowUpBucket } from '../leads/use-lead-mutations';
import { useLeadsPage } from '../leads/use-leads';
import { ActionableLeadList } from '../leads/actionable-lead-list';
import { BUCKET_COPY, FollowUpQueue } from '../followups/follow-up-queue';

/**
 * My work today — the screen a salesperson opens the app to.
 *
 * Six numbers answer "what needs me?", each one a button that opens exactly the
 * list behind it, underneath. Every count comes from /workspace/summary, which
 * uses the SAME predicates as the lists, so a tile never promises rows its list
 * does not show. Day boundaries are the organization's (Asia/Kolkata), not the
 * device's.
 */

type View = 'overdue' | 'today' | 'upcoming' | 'awaiting' | 'completed_today' | 'fresh' | 'unassigned';

const FOLLOW_UP_VIEWS: View[] = ['overdue', 'today', 'upcoming', 'awaiting', 'completed_today'];

export function WorkspacePage(): React.JSX.Element {
  const { user } = useAuth();
  const summary = useWorkspaceSummary();
  const [params, setParams] = useSearchParams();

  const data = summary.data;
  const requested = params.get('view') as View | null;
  // Default to what is most urgent: overdue if there is any, otherwise today.
  const view: View = useMemo(() => {
    if (requested && TILES.some((t) => t.view === requested)) return requested;
    return (data?.followUps.overdue ?? 0) > 0 ? 'overdue' : 'today';
  }, [requested, data]);

  const tiles = TILES.filter((tile) => tile.view !== 'unassigned' || data?.leads.unassigned !== null);

  return (
    <>
      <PageHeader
        title={`My work today${user?.fullName ? ` — ${user.fullName.split(' ')[0]}` : ''}`}
        subtitle={
          data
            ? `${formatDate(new Date().toISOString())} · ${data.scope === 'TEAM' ? 'Whole team' : 'Your leads'} · ${data.timezone}`
            : 'Loading…'
        }
      />

      {summary.isError ? (
        <ErrorNotice message="Could not load your work. Refresh to try again." />
      ) : (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7" role="tablist" aria-label="Work views">
          {tiles.map((tile) => {
            const value = data ? tile.count(data) : null;
            const selected = view === tile.view;
            const danger = tile.view === 'overdue' && (value ?? 0) > 0;
            return (
              <button
                key={tile.view}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setParams({ view: tile.view }, { replace: true })}
                className={`relative overflow-hidden rounded-xl border p-3.5 text-left transition before:absolute before:inset-y-0 before:left-0 before:w-1 ${
                  selected ? 'border-slate-900 bg-slate-900 text-white before:bg-white/40' : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                } ${danger && !selected ? 'before:bg-red-500' : !selected ? tile.accent : ''}`}
              >
                <p className={`text-xs font-medium ${selected ? 'text-white/80' : 'text-slate-500'}`}>{tile.label}</p>
                <p
                  className={`mt-1 text-2xl font-semibold tabular-nums ${
                    selected ? 'text-white' : danger ? 'text-red-600' : 'text-slate-900'
                  }`}
                >
                  {value === null ? '…' : value}
                </p>
                <p className={`mt-0.5 text-[11px] ${selected ? 'text-white/70' : 'text-slate-400'}`}>{tile.hint}</p>
              </button>
            );
          })}
        </div>
      )}

      <h2 className="mb-2 text-sm font-semibold text-slate-900">
        {TILES.find((t) => t.view === view)?.label}
      </h2>

      {FOLLOW_UP_VIEWS.includes(view) ? (
        <FollowUpQueue bucket={view as FollowUpBucket} />
      ) : (
        <LeadsView kind={view as 'fresh' | 'unassigned'} />
      )}
    </>
  );
}

interface Tile {
  view: View;
  label: string;
  hint: string;
  accent: string;
  count: (data: NonNullable<ReturnType<typeof useWorkspaceSummary>['data']>) => number | null;
}

const TILES: Tile[] = [
  { view: 'today', label: 'Calls due today', hint: 'Later today', accent: 'before:bg-slate-300', count: (d) => d.followUps.today },
  { view: 'overdue', label: 'Overdue', hint: 'Past due time', accent: 'before:bg-slate-300', count: (d) => d.followUps.overdue },
  { view: 'upcoming', label: 'Upcoming', hint: 'From tomorrow', accent: 'before:bg-slate-300', count: (d) => d.followUps.upcoming },
  { view: 'awaiting', label: 'Awaiting response', hint: 'Customer owes a reply', accent: 'before:bg-sky-400', count: (d) => d.followUps.awaiting },
  { view: 'completed_today', label: 'Completed today', hint: 'Follow-ups done', accent: 'before:bg-emerald-400', count: (d) => d.followUps.completed_today },
  { view: 'fresh', label: 'New leads', hint: 'Not reached yet', accent: 'before:bg-indigo-400', count: (d) => d.leads.fresh },
  { view: 'unassigned', label: 'Unassigned', hint: 'Needs an owner', accent: 'before:bg-amber-400', count: (d) => d.leads.unassigned },
];

/** Lead lists for the two tiles that are about leads, not scheduled work. */
function LeadsView({ kind }: { kind: 'fresh' | 'unassigned' }): React.JSX.Element {
  const leads = useLeadsPage(kind === 'fresh' ? { fresh: true, lifecycle: 'ACTIVE' } : { unassigned: true, lifecycle: 'ACTIVE' }, 50);
  const rows = (leads.data?.pages ?? []).flatMap((page) => page.items);

  return (
    <Card>
      {leads.isPending ? (
        <SkeletonRows rows={5} />
      ) : leads.isError ? (
        <ErrorNotice message="Could not load leads." />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="✓"
          title={kind === 'fresh' ? 'No untouched leads' : 'Every lead has an owner'}
          description={kind === 'fresh' ? 'Every new lead has had a first call.' : 'Nothing is waiting to be assigned.'}
        />
      ) : (
        <>
          <ActionableLeadList leads={rows} />
          {leads.hasNextPage && (
            <div className="border-t border-slate-100 p-3 text-center">
              <button
                type="button"
                onClick={() => void leads.fetchNextPage()}
                disabled={leads.isFetchingNextPage}
                className="rounded-lg border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
              >
                {leads.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export { BUCKET_COPY };
