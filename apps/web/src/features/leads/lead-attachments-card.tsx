import { useRef, useState } from 'react';
import { Card, CardHeader, EmptyState, ErrorNotice, SkeletonRows } from '../../components/ui';
import { useToast } from '../../components/toast';
import { formatCurrency, formatDateTime, formatRelative } from '../../lib/format';
import { newIdempotencyKey } from '../../lib/idempotency';
import { useAuthedImage } from '../../lib/use-authed-image';
import { Field, errorMessage, fieldErrorOf, inputClass } from './lead-dialogs';
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_KINDS,
  ATTACHMENT_KIND_LABELS,
  KINDS_WITH_AMOUNT,
  MAX_ATTACHMENT_BYTES,
  attachmentDownloadPath,
  downloadAttachment,
  formatFileSize,
  useLeadAttachments,
  useRemoveAttachment,
  useUploadAttachment,
  type AttachmentKind,
  type LeadAttachment,
} from './use-lead-attachments';

/**
 * Files on a lead: the quotation that was sent, the invoice, the purchase
 * order, photos of the product or the sample.
 *
 * Attaching a quotation "sent to the customer" is how a quotation is TRACKED:
 * the stage moves to Quotation sent and the lead waits in Awaiting response —
 * the file is the evidence of what was quoted, and when.
 */
export function LeadAttachmentsCard({
  leadId,
  canEdit,
}: {
  leadId: string;
  canEdit: boolean;
}): React.JSX.Element {
  const attachments = useLeadAttachments(leadId);
  const count = attachments.data?.length ?? 0;

  return (
    <Card>
      <CardHeader
        title="Files & quotations"
        subtitle={attachments.data ? `${count} file${count === 1 ? '' : 's'}` : 'Loading…'}
      />
      {canEdit && <UploadForm leadId={leadId} />}
      {attachments.isPending ? (
        <SkeletonRows rows={2} />
      ) : attachments.isError ? (
        <ErrorNotice message="Could not load the files." />
      ) : count === 0 ? (
        <EmptyState
          title="No files yet"
          description="Attach the quotation you sent, an invoice, a purchase order or product photos."
        />
      ) : (
        <ul className="divide-y divide-slate-100" aria-label="Attached files">
          {attachments.data.map((attachment) => (
            <AttachmentRow key={attachment.id} attachment={attachment} canEdit={canEdit} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function UploadForm({ leadId }: { leadId: string }): React.JSX.Element {
  const toast = useToast();
  const upload = useUploadAttachment(leadId);
  const fileInput = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<AttachmentKind>('QUOTATION');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [sent, setSent] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);
  // One key per chosen file: a double click or a retry is the same upload.
  const [key, setKey] = useState(newIdempotencyKey);

  const reset = (): void => {
    setFile(null);
    setAmount('');
    setNote('');
    setLocalError(null);
    setKey(newIdempotencyKey());
    if (fileInput.current) fileInput.current.value = '';
  };

  const choose = (chosen: File | null): void => {
    setKey(newIdempotencyKey());
    if (chosen && chosen.size > MAX_ATTACHMENT_BYTES) {
      setFile(null);
      setLocalError('Files must be 10 MB or smaller.');
      return;
    }
    setLocalError(null);
    setFile(chosen);
    // A picture is far more likely to be a photo than a quotation.
    if (chosen?.type.startsWith('image/') && kind === 'QUOTATION') setKind('PRODUCT_PHOTO');
  };

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!file) {
      // Keep a reason already shown (a file too large) rather than replace it.
      setLocalError((current) => current ?? 'Choose a file to attach.');
      return;
    }
    upload.mutate(
      {
        file,
        kind,
        idempotencyKey: key,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(amount && KINDS_WITH_AMOUNT.includes(kind) ? { amount } : {}),
        ...(kind === 'QUOTATION' && sent ? { markQuotationSent: true } : {}),
      },
      {
        onSuccess: (result) => {
          toast.success(
            result.leadStatus === 'QUOTATION_SENT' && kind === 'QUOTATION' && sent
              ? 'Quotation attached — the lead is now awaiting the customer.'
              : `${ATTACHMENT_KIND_LABELS[kind]} attached.`,
          );
          reset();
        },
        onError: (error) => toast.error(errorMessage(error, 'Could not attach the file.')),
      },
    );
  };

  const fileError = localError ?? fieldErrorOf(upload.error, 'file');

  return (
    <form onSubmit={submit} className="space-y-3 border-b border-slate-100 px-5 py-4" aria-label="Attach a file">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="File" htmlFor="attachment-file" error={fileError} hint="PDF, image, Excel, Word, CSV — up to 10 MB.">
          <input
            ref={fileInput}
            id="attachment-file"
            type="file"
            accept={ATTACHMENT_ACCEPT}
            onChange={(e) => choose(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-800 hover:file:bg-slate-200"
          />
        </Field>
        <Field label="What is it?" htmlFor="attachment-kind">
          <select
            id="attachment-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as AttachmentKind)}
            className={inputClass}
          >
            {ATTACHMENT_KINDS.map((value) => (
              <option key={value} value={value}>
                {ATTACHMENT_KIND_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {KINDS_WITH_AMOUNT.includes(kind) && (
          <Field label="Amount" htmlFor="attachment-amount" error={fieldErrorOf(upload.error, 'amount')}>
            <input
              id="attachment-amount"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className={inputClass}
              placeholder="Optional"
            />
          </Field>
        )}
        <Field label="Note" htmlFor="attachment-note" error={fieldErrorOf(upload.error, 'note')}>
          <input
            id="attachment-note"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            className={inputClass}
            placeholder="e.g. Q-104, CIF Jebel Ali, valid 30 days"
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        {kind === 'QUOTATION' ? (
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={sent}
              onChange={(e) => setSent(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            Sent to the customer — move to Quotation sent
          </label>
        ) : (
          <span />
        )}
        <button
          type="submit"
          disabled={upload.isPending}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-60"
        >
          {upload.isPending ? 'Attaching…' : 'Attach file'}
        </button>
      </div>
    </form>
  );
}

function AttachmentRow({
  attachment,
  canEdit,
}: {
  attachment: LeadAttachment;
  canEdit: boolean;
}): React.JSX.Element {
  const toast = useToast();
  const remove = useRemoveAttachment(attachment.leadId);
  const [downloading, setDownloading] = useState(false);

  const save = async (): Promise<void> => {
    setDownloading(true);
    try {
      await downloadAttachment(attachment);
    } catch {
      toast.error('Could not download the file.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <li className="flex items-start gap-3 px-5 py-3">
      <Thumbnail attachment={attachment} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
            {ATTACHMENT_KIND_LABELS[attachment.kind] ?? attachment.kind}
          </span>
          {attachment.amount !== null && (
            <span className="text-sm font-semibold text-slate-900">{formatCurrency(attachment.amount)}</span>
          )}
        </div>
        <p className="mt-1 truncate text-sm font-medium text-slate-900" title={attachment.fileName}>
          {attachment.fileName}
        </p>
        {attachment.note && <p className="mt-0.5 text-sm text-slate-600">{attachment.note}</p>}
        <p className="mt-0.5 text-xs text-slate-500">
          {formatFileSize(attachment.sizeBytes)} · {attachment.uploadedBy?.fullName ?? 'Unknown'} ·{' '}
          <time dateTime={attachment.createdAt} title={formatDateTime(attachment.createdAt)}>
            {formatRelative(attachment.createdAt)}
          </time>
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center">
        <button
          type="button"
          onClick={() => void save()}
          disabled={downloading}
          aria-label={`Download ${attachment.fileName}`}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
        >
          {downloading ? 'Saving…' : 'Download'}
        </button>
        {canEdit && (
          <button
            type="button"
            disabled={remove.isPending}
            aria-label={`Remove ${attachment.fileName}`}
            onClick={() => {
              if (window.confirm(`Remove ${attachment.fileName}? It stays on the record, hidden.`)) {
                remove.mutate(attachment.id, {
                  onSuccess: () => toast.success('File removed.'),
                  onError: (error) => toast.error(errorMessage(error, 'Could not remove the file.')),
                });
              }
            }}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-red-700 transition hover:bg-red-50 disabled:opacity-60"
          >
            Remove
          </button>
        )}
      </div>
    </li>
  );
}

function Thumbnail({ attachment }: { attachment: LeadAttachment }): React.JSX.Element {
  const src = useAuthedImage(attachment.isImage ? attachmentDownloadPath(attachment.leadId, attachment.id) : null);
  if (src) {
    return <img src={src} alt="" className="h-12 w-12 shrink-0 rounded-lg border border-slate-200 object-cover" />;
  }
  const label = attachment.mimeType === 'application/pdf' ? 'PDF' : (attachment.fileName.split('.').pop() ?? 'FILE').toUpperCase();
  return (
    <span
      aria-hidden="true"
      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-xs font-semibold text-slate-500"
    >
      {label.slice(0, 4)}
    </span>
  );
}

/** The most recent quotation, for the Commercial details card. */
export function latestQuotation(attachments: LeadAttachment[] | undefined): LeadAttachment | null {
  return attachments?.find((a) => a.kind === 'QUOTATION') ?? null;
}
