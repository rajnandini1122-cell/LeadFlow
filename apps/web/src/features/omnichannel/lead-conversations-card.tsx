import { useState } from 'react';
import { Card, CardHeader, ErrorNotice, SkeletonRows } from '../../components/ui';
import { formatRelative } from '../../lib/format';
import { ConversationDrawer } from './conversation-drawer';
import { CHANNEL_PRESENTATION, useLeadConversations } from './use-conversations';

/**
 * Channel conversations attached to one lead.
 *
 * A Card in the existing column rather than a tab, because the lead detail page
 * is built from Cards and has no tab pattern to join — introducing one here
 * would restructure a screen this phase is meant to extend.
 *
 * Renders nothing at all when a lead has no conversations. Every lead in the
 * product predates this feature, and an empty "Conversations" panel on all of
 * them would be a permanent piece of furniture advertising a feature the
 * organization may not even have switched on.
 */
export function LeadConversationsCard({ leadId }: { leadId: string }): React.JSX.Element | null {
  const conversations = useLeadConversations(leadId);
  const [open, setOpen] = useState<string | null>(null);

  if (conversations.isPending) {
    return (
      <Card>
        <CardHeader title="Conversations" />
        <SkeletonRows rows={2} />
      </Card>
    );
  }

  if (conversations.isError) {
    return (
      <Card>
        <CardHeader title="Conversations" />
        <ErrorNotice message="Could not load conversations for this lead." />
      </Card>
    );
  }

  if (conversations.data.length === 0) return null;

  return (
    <>
      <Card>
        <CardHeader
          title="Conversations"
          subtitle={`${conversations.data.length} linked from messaging channels`}
        />

        <ul className="divide-y divide-slate-100">
          {conversations.data.map((conversation) => {
            const channel = CHANNEL_PRESENTATION[conversation.channel];
            const latest = conversation.messages[0];
            const name = conversation.contact
              ? [conversation.contact.firstName, conversation.contact.lastName]
                  .filter(Boolean)
                  .join(' ')
                  .trim()
              : '';

            return (
              <li key={conversation.id} className="flex flex-wrap items-start gap-3 p-4">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${channel.tone}`}
                >
                  <span aria-hidden="true">{channel.icon}</span>
                  {channel.label}
                </span>

                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-900">{name || 'Unknown sender'}</p>
                  {latest?.content && (
                    <p className="mt-0.5 line-clamp-2 text-sm text-pretty text-slate-600">
                      “{latest.content}”
                    </p>
                  )}
                  <p className="mt-1 text-xs text-slate-500">
                    {formatRelative(conversation.lastMessageAt)}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setOpen(conversation.id)}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                >
                  Open
                </button>
              </li>
            );
          })}
        </ul>
      </Card>

      {open && <ConversationDrawer conversationId={open} onClose={() => setOpen(null)} />}
    </>
  );
}
