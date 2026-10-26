import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/ui';
import { useAuth } from '../auth/auth-context';
import { useFollowUpCounts, type FollowUpBucket } from '../leads/use-lead-mutations';
import { BUCKET_COPY, FollowUpQueue } from './follow-up-queue';

/**
 * Follow-up centre.
 *
 * Buckets come from the API, computed in the ORGANIZATION's timezone. Deriving
 * them in the browser would use the viewer's clock, so a manager travelling
 * would see a different "today" from the team they are managing.
 *
 * Tab counts are TRUE totals from /follow-ups/counts — the same predicate as
 * each list — not the length of a capped page.
 */

const TABS: FollowUpBucket[] = ['overdue', 'today', 'tomorrow', 'week', 'upcoming', 'awaiting', 'completed'];

export function FollowUpsPage(): React.JSX.Element {
  const { can } = useAuth();
  /*
   * The bucket comes from the URL when one is given, so dashboard and workspace
   * tiles can link straight to a tab, and the tab survives a reload.
   */
  const [params, setParams] = useSearchParams();
  const requested = params.get('bucket');
  const bucket: FollowUpBucket = isBucket(requested) ? requested : 'overdue';
  const setBucket = (next: FollowUpBucket): void => {
    // `replace`, so flicking between tabs does not fill the back button.
    setParams(next === 'overdue' ? {} : { bucket: next }, { replace: true });
  };

  const counts = useFollowUpCounts();
  const overdue = counts.data?.overdue ?? 0;

  return (
    <>
      <PageHeader
        title="Follow-ups"
        subtitle={
          counts.isPending
            ? 'Loading…'
            : overdue > 0
              ? `${overdue} overdue — these are the leads at risk of being forgotten`
              : 'Nothing overdue. Every active lead has a future follow-up.'
        }
        action={
          can('lead.view.all') ? (
            <Link
              to="/leads?unassigned=true"
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Unassigned leads
            </Link>
          ) : undefined
        }
      />

      <div className="-mx-4 mb-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div className="flex gap-1.5" role="tablist" aria-label="Follow-up buckets">
          {TABS.map((key) => {
            const n = counts.data?.[key];
            const danger = key === 'overdue' && (n ?? 0) > 0;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={bucket === key}
                onClick={() => setBucket(key)}
                className={`shrink-0 rounded-lg px-3.5 py-2 text-sm font-medium transition ${
                  bucket === key
                    ? 'bg-slate-900 text-white'
                    : 'bg-white text-slate-600 ring-1 ring-slate-200 ring-inset hover:bg-slate-50'
                }`}
              >
                {BUCKET_COPY[key].label}
                <span
                  className={`ml-2 rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
                    bucket === key
                      ? 'bg-white/20 text-white'
                      : danger
                        ? 'bg-red-100 text-red-700'
                        : 'bg-slate-100 text-slate-500'
                  }`}
                >
                  {counts.isPending || n === undefined ? '…' : n}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <FollowUpQueue bucket={bucket} />
    </>
  );
}

/** Narrows a query-string value to a real bucket. Anything else falls back. */
function isBucket(value: string | null): value is FollowUpBucket {
  return value !== null && (Object.keys(BUCKET_COPY) as string[]).includes(value);
}
