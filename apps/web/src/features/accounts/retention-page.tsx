import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardHeader, ErrorNotice, PageHeader, SkeletonRows } from '../../components/ui';
import { RepeatBusinessDialog } from './repeat-business-dialog';
import { CustomerFollowUpDialog } from './customer-followup-dialog';
import {
  SIGNAL_PRESENTATION,
  useActionQueue,
  useRetentionSummary,
  type ActionQueueItem,
  type SignalKind,
} from './use-retention';

const FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'Everything' },
  { value: 'FOLLOW_UP_DUE', label: 'Follow-ups due' },
  { value: 'REPEAT_CANDIDATE', label: 'Repeat business' },
  { value: 'DORMANT', label: 'Dormant' },
  { value: 'EXPANSION_CANDIDATE', label: 'Expansion' },
  { value: 'OPEN_OPPORTUNITY', label: 'Active opportunities' },
];

/**
 * The customer action queue.
 *
 * A work list, not a dashboard. Each row says which customer, why now, and
 * gives the one action that follows from it — because a retention screen that
 * requires three more clicks to act on is a report, and reports do not get
 * used between calls.
 *
 * Every row is an OBSERVATION. Nothing here has already happened: no
 * opportunity has been created, no message sent, no status changed. The
 * salesperson decides.
 */
export function RetentionPage(): React.JSX.Element {
  const [filter, setFilter] = useState('');
  const [repeatFor, setRepeatFor] = useState<{ id: string; name: string } | null>(null);
  const [followUpFor, setFollowUpFor] = useState<{ id: string; name: string } | null>(null);

  const summary = useRetentionSummary();
  const queue = useActionQueue(filter || undefined);

  return (
    <>
      <PageHeader
        title="Customer retention"
        subtitle="Who needs attention, and why. Nothing here happens on its own."
        action={
          <Link
            to="/customers"
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            All customers
          </Link>
        }
      />

      {summary.data && (
        <div className="mb-4 grid gap-px overflow-hidden rounded-xl bg-slate-200 sm:grid-cols-2 lg:grid-cols-5">
          <Tile label="Need attention" value={summary.data.needAttention} />
          <Tile label="Repeat business" value={summary.data.repeatCandidates} />
          <Tile label="Follow-ups due" value={summary.data.followUpsDue} />
          <Tile label="Dormant" value={summary.data.dormant} />
          <Tile label="Expansion" value={summary.data.expansionCandidates} />
        </div>
      )}

      <Card>
        <CardHeader
          title="Action queue"
          subtitle="Least recently active first — the customer nobody has touched is the one most likely to be forgotten."
        />

        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-4">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setFilter(option.value)}
              className={`rounded-full px-3 py-1.5 text-sm transition ${
                filter === option.value
                  ? 'bg-slate-900 text-white'
                  : 'border border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        {queue.isPending ? (
          <SkeletonRows rows={6} />
        ) : queue.isError ? (
          <ErrorNotice message="Could not load the action queue." />
        ) : queue.data.items.length === 0 ? (
          <p className="p-10 text-center text-sm text-slate-500">
            {/*
              "Nothing to do" is a legitimate answer, and saying so plainly is
              what makes the queue trustworthy on the days it is full.
            */}
            No customer needs attention right now.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {queue.data.items.map((item) => (
              <QueueRow
                key={item.accountId}
                item={item}
                onRepeat={() => setRepeatFor({ id: item.accountId, name: item.name })}
                onFollowUp={() => setFollowUpFor({ id: item.accountId, name: item.name })}
              />
            ))}
          </ul>
        )}

        {queue.data && (
          <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
            {/*
              Signals come from history rather than from anything SQL can
              select on, so the queue filters within a page. Saying what it
              examined beats implying it looked at every customer.
            */}
            Showing {queue.data.items.length} needing attention from {queue.data.scanned} customers
            examined, of {queue.data.total} in total.
          </p>
        )}
      </Card>

      {repeatFor && (
        <RepeatBusinessDialog
          accountId={repeatFor.id}
          accountName={repeatFor.name}
          onClose={() => setRepeatFor(null)}
        />
      )}

      {followUpFor && (
        <CustomerFollowUpDialog
          accountId={followUpFor.id}
          accountName={followUpFor.name}
          onClose={() => setFollowUpFor(null)}
        />
      )}
    </>
  );
}

function QueueRow({
  item,
  onRepeat,
  onFollowUp,
}: {
  item: ActionQueueItem;
  onRepeat: () => void;
  onFollowUp: () => void;
}): React.JSX.Element {
  const headline = item.headline;
  const presentation = headline ? SIGNAL_PRESENTATION[headline.kind as SignalKind] : null;

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 p-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={`/customers/${item.accountId}`}
            className="font-medium text-slate-900 hover:underline"
          >
            {item.name}
          </Link>

          {presentation && (
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${presentation.className}`}
            >
              {presentation.icon} {presentation.label}
            </span>
          )}
        </div>

        {/* The evidence. Always stated, so the suggestion can be judged. */}
        {headline && <p className="mt-1 text-sm text-slate-600">{headline.reason}</p>}

        {item.signals.length > 1 && (
          <p className="mt-1 text-xs text-slate-400">
            {item.signals
              .slice(1)
              .map((signal) => SIGNAL_PRESENTATION[signal.kind as SignalKind]?.label)
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap gap-2">
        {/*
          The primary action is repeat business, and it is offered only where
          there is history to repeat. Offering it to a customer who has never
          bought would be a button that means nothing.
        */}
        {item.wonCount > 0 && (
          <button
            type="button"
            onClick={onRepeat}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-slate-800"
          >
            🔄 Repeat business
          </button>
        )}
        <button
          type="button"
          onClick={onFollowUp}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
        >
          📞 Follow-up
        </button>
      </div>
    </li>
  );
}

function Tile({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div className="bg-white p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</p>
    </div>
  );
}
