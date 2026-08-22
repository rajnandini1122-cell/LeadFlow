import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ErrorNotice, SkeletonRows } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import {
  CHANNEL_PRESENTATION,
  LINK_STATE_PRESENTATION,
  useConversation,
} from './use-conversations';

/**
 * A conversation, read-only.
 *
 * Read-only is a decision, not a gap. No provider is connected yet, so a reply
 * box would be a control that silently does nothing — and a salesperson who
 * believes they answered a customer is worse off than one who knows they have
 * not. The composer appears when `canSend` is true, which no channel reports
 * in this phase.
 */
export function ConversationDrawer({
  conversationId,
  onClose,
}: {
  conversationId: string;
  onClose: () => void;
}): React.JSX.Element {
  const conversation = useConversation(conversationId);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const data = conversation.data;
  const channel = data ? CHANNEL_PRESENTATION[data.channel] : null;
  const contactName = data?.contact
    ? [data.contact.firstName, data.contact.lastName].filter(Boolean).join(' ').trim()
    : '';

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Conversation"
        onClick={(event) => event.stopPropagation()}
        className="flex h-full w-full max-w-lg flex-col bg-white shadow-xl"
      >
        <header className="flex items-start gap-3 border-b border-slate-100 p-5">
          <div className="min-w-0 flex-1">
            {channel && (
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${channel.tone}`}
              >
                <span aria-hidden="true">{channel.icon}</span>
                {channel.label}
              </span>
            )}
            <h2 className="mt-2 text-base font-semibold text-slate-900">
              {contactName || 'Unknown sender'}
            </h2>
            {data?.contact?.mobile && (
              <p className="text-sm text-slate-500">{data.contact.mobile}</p>
            )}
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close conversation"
            className="rounded-lg px-2 py-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            ✕
          </button>
        </header>

        {data && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-b border-slate-100 p-5 text-sm">
            <dt className="text-slate-500">Linked lead</dt>
            <dd className="text-slate-900">
              {data.lead ? (
                <Link to={`/leads/${data.lead.id}`} className="font-mono hover:underline">
                  {data.lead.leadNumber}
                </Link>
              ) : (
                <span className={LINK_STATE_PRESENTATION[data.linkState].tone.split(' ')[1]}>
                  {LINK_STATE_PRESENTATION[data.linkState].label}
                </span>
              )}
            </dd>

            <dt className="text-slate-500">Owner</dt>
            <dd className="text-slate-900">{data.owner?.fullName ?? 'Unassigned'}</dd>

            {data.potentialLead && (
              <>
                <dt className="text-slate-500">Signals</dt>
                <dd className="text-slate-900">{data.potentialLeadSignals.join(', ')}</dd>
              </>
            )}

            {data.archivedAt && (
              <>
                <dt className="text-slate-500">Dismissed</dt>
                <dd className="text-slate-900">
                  {formatDateTime(data.archivedAt)}
                  {data.archivedReason ? ` — ${data.archivedReason}` : ''}
                </dd>
              </>
            )}
          </dl>
        )}

        <div className="flex-1 overflow-y-auto p-5">
          {conversation.isPending ? (
            <SkeletonRows rows={5} />
          ) : conversation.isError ? (
            <ErrorNotice message="This conversation does not exist, or you do not have access to it." />
          ) : !data || data.messages.length === 0 ? (
            <p className="text-sm text-slate-500">No messages stored for this conversation.</p>
          ) : (
            <ol className="space-y-3">
              {data.messages.map((message) => {
                const inbound = message.direction === 'INCOMING';

                return (
                  <li key={message.id} className={inbound ? '' : 'flex justify-end'}>
                    <div
                      className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 ${
                        inbound ? 'bg-slate-100 text-slate-900' : 'bg-slate-900 text-white'
                      }`}
                    >
                      <p className="text-xs opacity-70">
                        {inbound ? 'Customer' : message.senderType === 'SYSTEM' ? 'System' : 'Sales'}
                      </p>
                      {message.content ? (
                        <p className="mt-0.5 text-sm text-pretty whitespace-pre-wrap">
                          {message.content}
                        </p>
                      ) : (
                        <p className="mt-0.5 text-sm italic opacity-70">
                          {message.messageType.toLowerCase()} attachment
                        </p>
                      )}
                      <p className="mt-1 text-[11px] opacity-60">
                        {formatDateTime(message.sentAt ?? message.createdAt)}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        {/*
          No composer. `canSend` is false for every channel in this phase, and
          rendering a disabled input would still suggest replying is a thing
          that happens here.
        */}
        {data && !data.canSend && (
          <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
            Replying from LeadFlow is not available yet — this is the stored history.
          </p>
        )}
      </aside>
    </div>
  );
}
