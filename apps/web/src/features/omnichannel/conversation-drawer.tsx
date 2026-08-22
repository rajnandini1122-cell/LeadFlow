import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ErrorNotice, SkeletonRows } from '../../components/ui';
import { ApiError } from '../../lib/api-client';
import { formatDateTime } from '../../lib/format';
import {
  CHANNEL_PRESENTATION,
  LINK_STATE_PRESENTATION,
  attachmentUrl,
  useConversation,
  useSendMessage,
  type ConversationDetail,
  type DeliveryStatus,
  type MessageAttachmentView,
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
                      {message.attachments?.length > 0 && (
                        <ul className="mt-1 space-y-1">
                          {message.attachments.map((attachment) => (
                            <li key={attachment.index}>
                              <Attachment
                                conversationId={data.id}
                                messageId={message.id}
                                attachment={attachment}
                                inbound={inbound}
                              />
                            </li>
                          ))}
                        </ul>
                      )}
                      {message.content ? (
                        <p className="mt-0.5 text-sm text-pretty whitespace-pre-wrap">
                          {message.content}
                        </p>
                      ) : (
                        message.attachments?.length === 0 && (
                          <p className="mt-0.5 text-sm italic opacity-70">
                            {message.messageType.toLowerCase()} attachment
                          </p>
                        )
                      )}
                      <p className="mt-1 flex items-center gap-1.5 text-[11px] opacity-60">
                        {formatDateTime(message.sentAt ?? message.createdAt)}
                        {!inbound && message.deliveryStatus && (
                          <span>· {DELIVERY_LABELS[message.deliveryStatus]}</span>
                        )}
                      </p>
                      {!inbound &&
                        message.deliveryStatus &&
                        EXPLAINED.includes(message.deliveryStatus) &&
                        message.failureReason && (
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
  /*
   * Deliberately not "Not delivered".
   *
   * The customer may well have received this one — we simply never got the
   * answer. Someone reading "not delivered" would send it again, and that is
   * exactly the duplicate the whole design exists to avoid.
   */
  UNCONFIRMED: '⚠ Delivery not confirmed',
};

/** Statuses whose explanation is worth showing under the message. */
const EXPLAINED: DeliveryStatus[] = ['FAILED', 'UNCONFIRMED'];

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
  const [file, setFile] = useState<File | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const channel = CHANNEL_PRESENTATION[conversation.channel];
  // The server's number, not a constant here: Instagram accepts 1000
  // characters where WhatsApp accepts 4096.
  const maxLength = conversation.maxTextLength ?? 4096;
  const remaining = maxLength - text.length;

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
    // A file on its own is a complete message; text on its own always was.
    if ((!content && !file) || send.isPending) return;

    setFailure(null);
    send.mutate(
      { content, idempotencyKey: idempotencyKey.current, file },
      {
        onSuccess: () => {
          setText('');
          setFile(null);
          if (fileInput.current) fileInput.current.value = '';
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

      {file && (
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-2 text-sm">
          <span aria-hidden="true">📎</span>
          <span className="min-w-0 flex-1 truncate">{file.name}</span>
          <span className="shrink-0 text-xs text-slate-500">{formatBytes(file.size)}</span>
          <button
            type="button"
            aria-label={`Remove ${file.name}`}
            disabled={send.isPending}
            onClick={() => {
              setFile(null);
              if (fileInput.current) fileInput.current.value = '';
            }}
            className="shrink-0 rounded px-1.5 text-slate-500 transition hover:bg-slate-200 disabled:opacity-50"
          >
            ✕
          </button>
        </div>
      )}

      <div className="flex items-end gap-2">
        <label className="sr-only" htmlFor="composer">
          Reply
        </label>

        <input
          ref={fileInput}
          id="attachment"
          type="file"
          className="sr-only"
          disabled={send.isPending}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            setFailure(null);
            setFile(event.target.files?.[0] ?? null);
          }}
        />
        <label
          htmlFor="attachment"
          aria-label="Attach a file"
          title="Attach a file"
          className={`cursor-pointer rounded-lg border border-slate-200 px-3 py-2 text-sm transition hover:bg-slate-50 ${
            send.isPending ? 'pointer-events-none opacity-50' : ''
          }`}
        >
          📎
        </label>
        <textarea
          id="composer"
          rows={2}
          value={text}
          maxLength={maxLength}
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
          placeholder={`Reply on ${channel.label}…`}
          className="min-h-[2.5rem] flex-1 resize-y rounded-lg border border-slate-200 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={send.isPending || (!text.trim() && !file)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
        >
          {send.isPending ? 'Sending…' : 'Send'}
        </button>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 text-xs text-slate-500">
        {conversation.windowExpiresAt && (
          <span>
            {channel.label} allows free replies until{' '}
            {formatDateTime(conversation.windowExpiresAt)}.
          </span>
        )}
        {/* Only once it matters, so the composer stays quiet most of the time. */}
        {remaining <= 200 && (
          <span className={remaining <= 0 ? 'text-red-600' : ''}>
            {remaining} characters left
          </span>
        )}
      </div>
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

/** Human-readable size. Only used for something the browser already knows. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One attachment in the history.
 *
 * Images render inline through our own authenticated endpoint. Everything else
 * gets a download link rather than a fake preview — a player for a format the
 * browser may not decode, or a thumbnail we do not have, would be a worse lie
 * than an honest link.
 *
 * The endpoint serves every file as `Content-Disposition: attachment` with
 * nosniff, so a customer-supplied file cannot execute in our origin even when
 * the browser fetches it for an <img>.
 */
function Attachment({
  conversationId,
  messageId,
  attachment,
  inbound,
}: {
  conversationId: string;
  messageId: string;
  attachment: MessageAttachmentView;
  inbound: boolean;
}): React.JSX.Element {
  const label = attachment.filename ?? `${attachment.type.toLowerCase()} attachment`;

  if (!attachment.retrievable) {
    return (
      <span className="text-xs italic opacity-70">
        {label} — no longer available
      </span>
    );
  }

  const href = attachmentUrl(conversationId, messageId, attachment.index);

  if (attachment.type === 'IMAGE') {
    return (
      <a href={href} target="_blank" rel="noreferrer" className="block">
        <img
          src={href}
          alt={label}
          loading="lazy"
          className="max-h-48 rounded-lg border border-black/10 object-cover"
        />
      </a>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`inline-flex items-center gap-1.5 text-sm underline ${
        inbound ? 'text-slate-700' : 'text-white'
      }`}
    >
      <span aria-hidden="true">📎</span>
      <span className="truncate">{label}</span>
      {attachment.sizeBytes && (
        <span className="text-xs opacity-70">({formatBytes(attachment.sizeBytes)})</span>
      )}
    </a>
  );
}
