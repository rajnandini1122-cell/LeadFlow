import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { LeadStatus } from '@leadflow/api-types';
import { api, apiDelete, apiGet, apiPost } from '../../lib/api-client';
import { idempotencyHeaders } from '../../lib/idempotency';
import { saveFile } from '../../lib/save-file';
import { useRefreshLeadData } from './use-lead-mutations';

export const ATTACHMENT_KINDS = [
  'QUOTATION',
  'INVOICE',
  'PROFORMA',
  'PURCHASE_ORDER',
  'PRODUCT_PHOTO',
  'SAMPLE_PHOTO',
  'DOCUMENT',
  'OTHER',
] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export const ATTACHMENT_KIND_LABELS: Record<AttachmentKind, string> = {
  QUOTATION: 'Quotation',
  INVOICE: 'Invoice',
  PROFORMA: 'Proforma invoice',
  PURCHASE_ORDER: 'Purchase order',
  PRODUCT_PHOTO: 'Product photo',
  SAMPLE_PHOTO: 'Sample photo',
  DOCUMENT: 'Document',
  OTHER: 'Other',
};

/** Kinds that carry a money amount worth recording. */
export const KINDS_WITH_AMOUNT: readonly AttachmentKind[] = ['QUOTATION', 'INVOICE', 'PROFORMA', 'PURCHASE_ORDER'];

/** Mirrors the API: it decides the type from the bytes, this only guides the picker. */
export const ATTACHMENT_ACCEPT =
  '.pdf,.jpg,.jpeg,.png,.webp,.xlsx,.docx,.csv,.txt,application/pdf,image/jpeg,image/png,image/webp';
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface LeadAttachment {
  id: string;
  leadId: string;
  kind: AttachmentKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  note: string | null;
  amount: string | null;
  uploadedBy: { id: string; fullName: string } | null;
  createdAt: string;
  isImage: boolean;
}

export const attachmentDownloadPath = (leadId: string, attachmentId: string): string =>
  `/leads/${leadId}/attachments/${attachmentId}/download`;

export function useLeadAttachments(leadId: string | undefined): UseQueryResult<LeadAttachment[]> {
  return useQuery({
    queryKey: ['lead-attachments', leadId],
    queryFn: () => apiGet<LeadAttachment[]>(`/leads/${leadId as string}/attachments`),
    // An unexpected payload must never take the whole lead page down with it.
    select: (data) => (Array.isArray(data) ? data : []),
    enabled: Boolean(leadId),
  });
}

export interface UploadAttachmentInput {
  file: File;
  kind: AttachmentKind;
  note?: string;
  amount?: string;
  markQuotationSent?: boolean;
  idempotencyKey: string;
}

export function useUploadAttachment(leadId: string) {
  const queryClient = useQueryClient();
  const refresh = useRefreshLeadData();

  return useMutation({
    mutationFn: (input: UploadAttachmentInput) => {
      const form = new FormData();
      form.append('kind', input.kind);
      if (input.note) form.append('note', input.note);
      if (input.amount) form.append('amount', input.amount);
      if (input.markQuotationSent) form.append('markQuotationSent', 'true');
      form.append('file', input.file);
      return apiPost<{ attachment: LeadAttachment; leadStatus: LeadStatus; replayed: boolean }>(
        `/leads/${leadId}/attachments`,
        form,
        idempotencyHeaders(input.idempotencyKey),
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['lead-attachments', leadId] });
      // A quotation marked sent moves the stage, the queues and the timeline.
      refresh(leadId);
    },
  });
}

export function useRemoveAttachment(leadId: string) {
  const queryClient = useQueryClient();
  const refresh = useRefreshLeadData();

  return useMutation({
    mutationFn: (attachmentId: string) => apiDelete(`/leads/${leadId}/attachments/${attachmentId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['lead-attachments', leadId] });
      refresh(leadId);
    },
  });
}

/**
 * Saves an attachment to the device — or, in the Android app, opens the share
 * sheet so the quotation can go straight to WhatsApp or Drive.
 *
 * Fetched by code because the endpoint needs the Authorization header, which
 * a plain link cannot carry.
 */
export async function downloadAttachment(attachment: LeadAttachment): Promise<void> {
  const response = await api.get<Blob>(attachmentDownloadPath(attachment.leadId, attachment.id), {
    responseType: 'blob',
  });
  await saveFile(response.data, attachment.fileName);
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
