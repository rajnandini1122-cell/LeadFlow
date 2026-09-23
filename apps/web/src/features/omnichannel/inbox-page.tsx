import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, EmptyState, ErrorNotice, PageHeader, SkeletonRows } from '../../components/ui';
import { formatRelative } from '../../lib/format';
import { ConversationDrawer } from './conversation-drawer';
import {
  CHANNEL_PRESENTATION,
  LINK_STATE_PRESENTATION,
  useInbox,
  useInboxCounts,
  type Channel,
  type InboxFilter,
  type ReviewRow,
} from './use-conversations';

/**
 * The unified inbox.
 *
 * Every conversation this user may see, across every channel — including the
 * ones already attached to a lead, which the review queue hides because they
 * have been dealt with. Same table, same rows, same visibility policy: the
 * review queue is a view over this, not a second copy of it.
 *
 * What a rep sees here is narrower than it looks. Unowned conversations are
 * hidden unless the organization has switched on its shared queue, because an
 * unassigned enquiry is a customer's private message rather than a noticeboard.
 */

const FILTERS: { value: InboxFilter; label: string; countKey: 'all' | 'mine' | 'unassigned' }[] = [
  { value: 'ALL', label: 'All', countKey: 'all' },
  { value: 'MINE', label: 'Mine', countKey: 'mine' },
  { value: 'UNASSIGNED', label: 'Unassigned', countKey: 'unassigned' },
];

const CHANNELS: { value: Channel | undefined; label: string }[] = [
  { value: undefined, label: 'All channels' },
  { value: 'WHATSAPP', label: 'WhatsApp' },
  { value: 'FACEBOOK', label: 'Facebook' },
  { value: 'INSTAGRAM', label: 'Instagram' },
];

export function InboxPage(): React.JSX.Element {
  const [filter, setFilter] = useState<InboxFilter>('ALL');
  const [channel, setChannel] = useState<Channel | undefined>(undefined);
  const [archived, setArchived] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const inbox = useInbox({ filter, channel, archived });
  const counts = useInboxCounts(true);

  return (
    <>
      <PageHeader
        title="Inbox"
        subtitle="Conversations from every connected channel"
      />

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-4">
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Inbox filter">
            {FILTERS.map((item) => {
              const count = counts.data?.[item.countKey];

              return (
                <button
                  key={item.value}
                  role="tab"
                  type="button"
                  aria-selected={filter === item.value}
                  onClick={() => setFilter(item.value)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    filter === item.value
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {item.label}
                  {count !== undefined && count > 0 && (
                    <span className="ml-1.5 tabular-nums opacity-70">{count}</span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <label className="sr-only" htmlFor="inbox-channel">
              Channel
            </label>
            <select
              id="inbox-channel"
              value={channel ?? ''}
              onChange={(e) => setChannel((e.target.value || undefined) as Channel | undefined)}
              className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            >
              {CHANNELS.map((item) => (
                <option key={item.label} value={item.value ?? ''}>
                  {item.label}
                </option>
              ))}
            </select>

            <label className="flex items-center gap-1.5 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={archived}
                onChange={(e) => setArchived(e.target.checked)}
              />
              Archived
            </label>
          </div>
        </div>

        {inbox.isPending ? (
          <SkeletonRows rows={5} />
        ) : inbox.isError ? (
          <ErrorNotice message="Could not load the inbox." />
        ) : inbox.data.items.length === 0 ? (
          <EmptyState
            icon="✉"
            title={archived ? 'Nothing archived' : 'No conversations'}
            description={
              filter === 'UNASSIGNED'
                ? 'Conversations nobody has picked up will appear here.'
                : 'Messages from connected channels will appear here.'
            }
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {inbox.data.items.map((row) => (
              <InboxRow key={row.id} row={row} onOpen={() => setOpen(row.id)} />
            ))}
          </ul>
        )}

        {inbox.data?.hasMore && (
          <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
            Showing the most recent conversations. Narrow the filters to see more.
          </p>
        )}
      </Card>

      {open && <ConversationDrawer conversationId={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function InboxRow({ row, onOpen }: { row: ReviewRow; onOpen: () => void }): React.JSX.Element {
  const channel = CHANNEL_PRESENTATION[row.channel];
  const state = LINK_STATE_PRESENTATION[row.linkState];

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full flex-wrap items-start gap-3 p-4 text-left transition hover:bg-slate-50"
      >
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${channel.tone}`}
        >
          <span aria-hidden="true">{channel.icon}</span>
          {channel.label}
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-slate-900">
            {row.contact?.name ?? 'Unknown sender'}
            {row.companyName && (
              <span className="font-normal text-slate-500"> · {row.companyName}</span>
            )}
          </p>
          {row.contact?.mobile && <p className="text-xs text-slate-500">{row.contact.mobile}</p>}

          {row.lastMessagePreview && (
            <p className="mt-1 line-clamp-1 text-sm text-slate-600">
              “{row.lastMessagePreview}”
            </p>
          )}

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
            {row.lead ? (
              <Link
                to={`/leads/${row.lead.id}`}
                onClick={(e) => e.stopPropagation()}
                className="font-mono hover:underline"
              >
                {row.lead.leadNumber}
              </Link>
            ) : (
              <span className={`rounded-full px-1.5 py-0.5 ${state.tone}`}>{state.label}</span>
            )}
            <span>{row.owner ? `Owner: ${row.owner.fullName}` : 'Unassigned'}</span>
          </div>
        </div>

        <span className="shrink-0 text-xs text-slate-400">
          {formatRelative(row.lastMessageAt)}
        </span>
      </button>
    </li>
  );
}
