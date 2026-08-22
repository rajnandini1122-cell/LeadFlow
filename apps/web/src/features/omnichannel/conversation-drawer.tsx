import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ErrorNotice, SkeletonRows } from '../../components/ui';
import { ApiError } from '../../lib/api-client';
import { formatDateTime } from '../../lib/format';
import {
  CHANNEL_PRESENTATION,
  LINK_STATE_PRESENTATION,
  useConversation,
  useSendMessage,
  type ConversationDetail,
  type DeliveryStatus,
} from './use-conversations';

/**
 * A conversation, with a composer where replying is actually possible.
 *
 * `canSend` is calculated by the API and treated as authoritative here. The
 * client never decides for itself: the rules depend on integration state and on
 * WhatsApp's 24-hour window, and a composer over a conversation that cannot
 * send lets a salesperson type a reply and watch it fail while a customer
 * waits.
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
                      <p className="mt-1 flex items-center gap-1.5 text-[11px] opacity-60">
                        {formatDateTime(message.sentAt ?? message.createdAt)}
                        {!inbound && message.deliveryStatus && (
                          <span>· {DELIVERY_LABELS[message.deliveryStatus]}</span>
                        )}
                      </p>
                      {!inbound && message.deliveryStatus === 'FAILED' && message.failureReason && (
                        <p className="mt-1 text-[11px] text-red-200">{message.failureReason}</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        {data && (data.canSend ? <Composer conversation={data} /> : <ReplyBlocked conversation={data} />)}
      </aside>
    </div>
  );
}

/**
 * What each delivery state is called.
 *
 * "Sending" rather than "Sent" for PENDING, deliberately: a message that has
 * not been accepted by WhatsApp has not reached anyone, and showing it as sent
 * would have a salesperson believe the customer has it.
 */
const DELIVERY_LABELS: Record<DeliveryStatus, string> = {
  PENDING: 'Sending…',
  SENT: 'Sent',
  DELIVERED: 'Delivered',
  READ: 'Read',
  FAILED: 'Not delivered',
};

/**
 * The reply box.
 *
 * No optimistic bubble. The message appears once the server confirms WhatsApp
 * accepted it — an optimistic one would show as sent for the moment before a
 * failure came back, which is precisely the moment a salesperson decides they
 * have answered and moves on.
 */
function Composer({ conversation }: { conversation: ConversationDetail }): React.JSX.Element {
  const send = useSendMessage(conversation.id);
  const [text, setText] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  /*
   * One key per composed message.
   *
   * Regenerated only after a success, so every retry of the SAME message —
   * a double click, a re-submit after a timeout — carries the key the server
   * already knows and cannot produce a second delivery.
   */
  const idempotencyKey = useRef(crypto.randomUUID());

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const content = text.trim();
    if (!content || send.isPending) return;

    setFailure(null);
    send.mutate(
      { content, idempotencyKey: idempotencyKey.current },
      {
        onSuccess: () => {
          setText('');
          idempotencyKey.current = crypto.randomUUID();
        },
        onError: (error) => {
          setFailure(
            error instanceof ApiError
              ? error.message
              : 'Could not send the message. Please try again.',
          );
        },
      },
    );
  };

  return (
    <form onSubmit={submit} className="border-t border-slate-100 p-4">
      {failure && (
        <p role="alert" className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {failure}
        </p>
      )}

      <div className="flex items-end gap-2">
        <label className="sr-only" htmlFor="composer">
          Reply
        </label>
        <textarea
          id="composer"
          rows={2}
          value={text}
          maxLength={4096}
          disabled={send.isPending}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter breaks the line — what people expect
            // from a messaging box.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit(event);
            }
          }}
          placeholder="Write a reply…"
          className="min-h-[2.5rem] flex-1 resize-y rounded-lg border border-slate-200 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={send.isPending || !text.trim()}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
        >
          {send.isPending ? 'Sending…' : 'Send'}
        </button>
      </div>

      {conversation.windowExpiresAt && (
        <p className="mt-1.5 text-xs text-slate-500">
          WhatsApp allows free replies until {formatDateTime(conversation.windowExpiresAt)}.
        </p>
      )}
    </form>
  );
}

/** Why there is no composer. The server's words, shown verbatim. */
function ReplyBlocked({ conversation }: { conversation: ConversationDetail }): React.JSX.Element {
  return (
    <p className="border-t border-slate-100 px-5 py-3 text-xs text-pretty text-slate-500">
      {conversation.sendDisabledReason ?? 'Replying is not available for this conversation.'}
    </p>
  );
}
