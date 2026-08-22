import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PERMISSIONS } from '@leadflow/api-types';
import {
  Card,
  EmptyState,
  ErrorNotice,
  PageHeader,
  SkeletonRows,
} from '../../components/ui';
import { formatRelative } from '../../lib/format';
import { useAuth } from '../auth/auth-context';
import { NewLeadDialog } from '../leads/new-lead-dialog';
import type { LeadSummary } from '../leads/use-leads';
import { ConversationDrawer } from './conversation-drawer';
import { LinkLeadDialog } from './link-lead-dialog';
import {
  CHANNEL_PRESENTATION,
  LINK_STATE_PRESENTATION,
  useArchiveConversation,
  useLinkConversation,
  useRestoreConversation,
  useReviewQueue,
  type Channel,
  type ReviewCategory,
  type ReviewRow,
} from './use-conversations';

/**
 * Channel lead review.
 *
 * The pile of incoming conversations the system deliberately refused to act on
 * by itself — someone it could not identify, someone it knows but with no open
 * deal, or someone with two open deals where guessing would have been worse
 * than asking. A person decides each one.
 *
 * Every action here goes through an existing flow. "Create lead" opens the
 * ordinary new-lead dialog and then links the conversation to whatever that
 * produced; it does not have a lead-creation path of its own.
 */

const CATEGORIES: { value: ReviewCategory; label: string; hint: string }[] = [
  { value: 'ALL', label: 'All', hint: 'Everything still waiting on a decision' },
  { value: 'POTENTIAL_LEAD', label: 'Potential leads', hint: 'Reads like a buying enquiry' },
  { value: 'UNRESOLVED', label: 'Unknown sender', hint: 'Nobody could be identified' },
  { value: 'UNLINKED', label: 'Needs a lead', hint: 'Known person, no open deal' },
  { value: 'REVIEW_REQUIRED', label: 'Review required', hint: 'Several deals matched' },
];

const CHANNELS: { value: Channel | undefined; label: string }[] = [
  { value: undefined, label: 'All channels' },
  { value: 'WHATSAPP', label: 'WhatsApp' },
  { value: 'FACEBOOK', label: 'Facebook' },
  { value: 'INSTAGRAM', label: 'Instagram' },
];

export function ChannelReviewPage(): React.JSX.Element {
  const { can } = useAuth();
  const canAct = can(PERMISSIONS.LEAD_UPDATE);

  const [category, setCategory] = useState<ReviewCategory>('ALL');
  const [channel, setChannel] = useState<Channel | undefined>(undefined);
  const [showArchived, setShowArchived] = useState(false);

  const [openConversation, setOpenConversation] = useState<string | null>(null);
  const [linking, setLinking] = useState<ReviewRow | null>(null);
  const [creatingFrom, setCreatingFrom] = useState<ReviewRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const queue = useReviewQueue({ category, channel, archived: showArchived });
  const archive = useArchiveConversation();
  const restore = useRestoreConversation();
  const link = useLinkConversation();

  const onLeadCreated = (lead: LeadSummary): void => {
    const conversation = creatingFrom;
    if (!conversation) return;

    // The lead exists first, created by the ordinary flow. Only then is the
    // conversation attached to it.
    link.mutate(
      { conversationId: conversation.id, leadId: lead.id },
      {
        onSuccess: () => setNotice(`Lead ${lead.leadNumber} created and conversation linked.`),
      },
    );
    setCreatingFrom(null);
  };

  return (
    <>
      <PageHeader
        title="Channel lead review"
        subtitle="Incoming conversations the system would not decide on its own"
      />

      {notice && (
        <p
          role="status"
          aria-live="polite"
          className="mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {notice}
        </p>
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-4">
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Review category">
            {CATEGORIES.map((item) => (
              <button
                key={item.value}
                role="tab"
                type="button"
                aria-selected={category === item.value}
                title={item.hint}
                onClick={() => setCategory(item.value)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                  category === item.value
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <label className="sr-only" htmlFor="channel-filter">
              Channel
            </label>
            <select
              id="channel-filter"
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
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              Dismissed
            </label>
          </div>
        </div>

        {queue.isPending ? (
          <SkeletonRows rows={4} />
        ) : queue.isError ? (
          <ErrorNotice message="Could not load the review queue." />
        ) : queue.data.items.length === 0 ? (
          <EmptyState
            title={showArchived ? 'Nothing dismissed' : 'Nothing waiting'}
            description={
              showArchived
                ? 'Conversations you dismiss will appear here, and can be put back.'
                : 'Incoming conversations that need a decision will appear here.'
            }
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {queue.data.items.map((row) => (
              <ReviewCard
                key={row.id}
                row={row}
                canAct={canAct}
                onOpen={() => setOpenConversation(row.id)}
                onLink={() => setLinking(row)}
                onCreate={() => setCreatingFrom(row)}
                onArchive={() =>
                  archive.mutate(
                    { conversationId: row.id },
                    { onSuccess: () => setNotice('Conversation dismissed. It is still stored.') },
                  )
                }
                onRestore={() =>
                  restore.mutate(
                    { conversationId: row.id },
                    { onSuccess: () => setNotice('Conversation returned to the queue.') },
                  )
                }
              />
            ))}
          </ul>
        )}
      </Card>

      {openConversation && (
        <ConversationDrawer
          conversationId={openConversation}
          onClose={() => setOpenConversation(null)}
        />
      )}

      {linking && (
        <LinkLeadDialog
          conversationId={linking.id}
          contactName={linking.contact?.name ?? null}
          onClose={() => setLinking(null)}
          onLinked={(leadNumber) => {
            setLinking(null);
            setNotice(`Conversation linked to ${leadNumber}.`);
          }}
        />
      )}

      <NewLeadDialog
        open={creatingFrom !== null}
        onClose={() => setCreatingFrom(null)}
        prefill={creatingFrom ? prefillFrom(creatingFrom) : undefined}
        onCreated={onLeadCreated}
      />
    </>
  );
}

/**
 * What we can honestly pre-fill from a conversation.
 *
 * Only fields the conversation actually carries. Guessing a company from a
 * display name, or a product from a keyword, would put words in the customer's
 * mouth on a record the sales team then works from.
 */
function prefillFrom(row: ReviewRow): {
  firstName?: string;
  lastName?: string;
  mobile?: string;
  email?: string;
  companyName?: string;
  source: string;
} {
  const [first, ...rest] = (row.contact?.name ?? '').trim().split(/\s+/).filter(Boolean);

  return {
    ...(first ? { firstName: first } : {}),
    ...(rest.length ? { lastName: rest.join(' ') } : {}),
    ...(row.contact?.mobile ? { mobile: row.contact.mobile } : {}),
    ...(row.contact?.email ? { email: row.contact.email } : {}),
    ...(row.companyName ? { companyName: row.companyName } : {}),
    source: CHANNEL_PRESENTATION[row.channel].label,
  };
}

function ReviewCard({
  row,
  canAct,
  onOpen,
  onLink,
  onCreate,
  onArchive,
  onRestore,
}: {
  row: ReviewRow;
  canAct: boolean;
  onOpen: () => void;
  onLink: () => void;
  onCreate: () => void;
  onArchive: () => void;
  onRestore: () => void;
}): React.JSX.Element {
  const channel = CHANNEL_PRESENTATION[row.channel];
  const state = LINK_STATE_PRESENTATION[row.linkState];
  const dismissed = row.archivedAt !== null;

  return (
    <li className="p-4">
      <div className="flex flex-wrap items-start gap-3">
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
          {row.contact?.mobile && (
            <p className="text-xs text-slate-500">{row.contact.mobile}</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {row.potentialLead && (
            <span
              className="rounded-full bg-sky-50 px-2 py-1 text-xs font-medium text-sky-700"
              title={`Matched: ${row.potentialLeadSignals.join(', ')}`}
            >
              Potential lead
            </span>
          )}
          <span
            className={`rounded-full px-2 py-1 text-xs font-medium ${state.tone}`}
            title={state.meaning}
          >
            {state.label}
          </span>
        </div>
      </div>

      {row.lastMessagePreview && (
        <p className="mt-2 line-clamp-2 text-sm text-pretty text-slate-600">
          “{row.lastMessagePreview}”
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
        {row.lastMessageAt && <span>{formatRelative(row.lastMessageAt)}</span>}
        {row.owner && <span>Owner: {row.owner.fullName}</span>}
        {row.lead && (
          <Link to={`/leads/${row.lead.id}`} className="font-mono text-slate-600 hover:underline">
            {row.lead.leadNumber}
          </Link>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onOpen}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
        >
          Open conversation
        </button>

        {canAct && !dismissed && row.linkState !== 'LINKED' && (
          <>
            <button
              type="button"
              onClick={onCreate}
              className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-slate-800"
            >
              Create lead
            </button>
            <button
              type="button"
              onClick={onLink}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Link existing lead
            </button>
            <button
              type="button"
              onClick={onArchive}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 transition hover:bg-slate-100"
            >
              Not a lead
            </button>
          </>
        )}

        {canAct && dismissed && (
          <button
            type="button"
            onClick={onRestore}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Put back in the queue
          </button>
        )}
      </div>
    </li>
  );
}
