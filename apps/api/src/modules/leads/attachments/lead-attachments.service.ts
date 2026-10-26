import { createHash } from 'node:crypto';
import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { ERROR_CODES, type LeadStatus } from '@leadflow/api-types';
import { AppException } from '../../../common/errors/app.exception';
import type { TenantPrincipal } from '../../../common/tenancy/tenant-context.service';
import { FollowUpsRepository, findReplay } from '../../follow-ups/follow-ups.repository';
import { LeadsRepository } from '../leads.repository';
import { visibilityFilter } from '../lead-visibility';
import {
  MAX_ATTACHMENTS_PER_LEAD,
  MAX_ATTACHMENT_BYTES,
  detectAttachmentType,
  sanitizeFileName,
} from './attachment-file-type';
import { LeadAttachmentsRepository } from './lead-attachments.repository';
import type { UploadAttachmentDto } from './lead-attachments.dto';

export interface UploadedFile {
  buffer: Buffer;
  size: number;
  originalname?: string;
}

export interface AttachmentView {
  id: string;
  leadId: string;
  kind: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  note: string | null;
  /** Decimal as a string, like every other money value in this API. */
  amount: string | null;
  uploadedBy: { id: string; fullName: string } | null;
  createdAt: string;
  /** True for images, which the web shows as a thumbnail. */
  isImage: boolean;
}

/** Stages from which "quotation sent" is a step FORWARD. */
const BEFORE_QUOTATION: LeadStatus[] = ['NEW', 'CONTACTED', 'QUALIFIED', 'FOLLOW_UP'];

const KIND_LABELS: Record<string, string> = {
  QUOTATION: 'Quotation',
  INVOICE: 'Invoice',
  PROFORMA: 'Proforma invoice',
  PURCHASE_ORDER: 'Purchase order',
  PRODUCT_PHOTO: 'Product photo',
  SAMPLE_PHOTO: 'Sample photo',
  DOCUMENT: 'Document',
  OTHER: 'File',
};

/**
 * Files on a lead — and the quotation they so often are.
 *
 * Attaching a quotation can record that it was SENT: the stage moves forward
 * to Quotation sent (never backwards), which is what puts the lead in the
 * Awaiting response queue. File, stage and timeline entry commit together,
 * under the lead's row lock, idempotently — the same guarantees every other
 * lead write has.
 */
@Injectable()
export class LeadAttachmentsService {
  constructor(
    private readonly repository: LeadAttachmentsRepository,
    private readonly leads: LeadsRepository,
    @Inject(forwardRef(() => FollowUpsRepository))
    private readonly followUps: FollowUpsRepository,
  ) {}

  async upload(
    leadId: string,
    file: UploadedFile | undefined,
    dto: UploadAttachmentDto,
    principal: TenantPrincipal,
    idempotencyKey: string | null,
  ): Promise<{ attachment: AttachmentView; leadStatus: LeadStatus; replayed: boolean }> {
    await this.requireVisibleLead(leadId, principal);

    if (!file || file.size === 0) {
      throw AppException.validation('Choose a file to attach.', { file: ['is required'] });
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw AppException.validation('Files must be 10 MB or smaller.', { file: ['is too large'] });
    }
    const detected = detectAttachmentType(file.buffer, file.originalname ?? '');
    if (!detected) {
      throw AppException.validation(
        'That file type is not accepted. Attach a PDF, an image (JPEG, PNG, WebP), Excel, Word, CSV or text file.',
        { file: ['unsupported type'] },
      );
    }
    if (dto.markQuotationSent && dto.kind !== 'QUOTATION') {
      throw AppException.validation('Only a quotation can be marked as sent.', {
        markQuotationSent: ['requires kind QUOTATION'],
      });
    }
    if ((await this.repository.countForLead(leadId)) >= MAX_ATTACHMENTS_PER_LEAD) {
      throw AppException.validation(`A lead can hold at most ${MAX_ATTACHMENTS_PER_LEAD} files.`, {
        file: ['limit reached — remove an old file first'],
      });
    }

    const fileName = sanitizeFileName(file.originalname ?? 'attachment', detected.extension);
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const currency = await this.repository.organizationCurrency();

    const result = await this.followUps.inLeadTransaction(leadId, async (tx, lead) => {
      if (!lead) throw AppException.leadNotFound();

      // A double click or a retried upload is ONE attachment.
      const replay = await findReplay(tx, { leadId, activityType: 'DOCUMENT_ATTACHED', key: idempotencyKey });
      const replayedId = typeof replay?.['attachmentId'] === 'string' ? replay['attachmentId'] : null;
      if (replayedId) {
        const original = await this.repository.findMetadata(replayedId, leadId, tx);
        if (original) return { row: original, status: lead.status as LeadStatus, replayed: true };
      }

      const row = await this.repository.create(tx, {
        leadId,
        kind: dto.kind,
        fileName,
        mimeType: detected.mimeType,
        sizeBytes: file.size,
        sha256,
        data: file.buffer,
        note: dto.note,
        amount: dto.amount,
        uploadedBy: principal.userId,
      });

      // The quotation was sent: move the stage FORWARD only.
      let status = lead.status as LeadStatus;
      if (dto.markQuotationSent && BEFORE_QUOTATION.includes(status)) {
        await this.leads.applyStatusChange({ leadId, status: 'QUOTATION_SENT', actorId: principal.userId, tx });
        status = 'QUOTATION_SENT';
      }

      await this.followUps.recordLeadActivity(tx, {
        leadId,
        activityType: 'DOCUMENT_ATTACHED',
        description: describe(dto, fileName, currency),
        actorId: principal.userId,
        idempotencyKey,
        result: { attachmentId: row.id, kind: dto.kind },
      });

      return { row, status, replayed: false };
    });

    const names = await this.repository.memberNames(result.row.uploadedBy ? [result.row.uploadedBy] : []);
    return { attachment: toView(result.row, names), leadStatus: result.status, replayed: result.replayed };
  }

  async list(leadId: string, principal: TenantPrincipal): Promise<AttachmentView[]> {
    await this.requireVisibleLead(leadId, principal);
    const rows = await this.repository.listForLead(leadId);
    const names = await this.repository.memberNames(
      [...new Set(rows.map((row) => row.uploadedBy).filter((id): id is string => !!id))],
    );
    return rows.map((row) => toView(row, names));
  }

  async download(leadId: string, attachmentId: string, principal: TenantPrincipal) {
    await this.requireVisibleLead(leadId, principal);
    const file = await this.repository.findWithData(attachmentId, leadId);
    if (!file) throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'File not found.');
    return file;
  }

  async remove(leadId: string, attachmentId: string, principal: TenantPrincipal): Promise<void> {
    await this.requireVisibleLead(leadId, principal);

    await this.followUps.inLeadTransaction(leadId, async (tx, lead) => {
      if (!lead) throw AppException.leadNotFound();
      const existing = await this.repository.findMetadata(attachmentId, leadId, tx);
      if (!existing) throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'File not found.');

      await this.repository.softDelete(tx, attachmentId, leadId, principal.userId);
      await this.followUps.recordLeadActivity(tx, {
        leadId,
        activityType: 'DOCUMENT_REMOVED',
        description: `${KIND_LABELS[existing.kind] ?? 'File'} removed: ${existing.fileName}`,
        actorId: principal.userId,
        result: { attachmentId },
      });
    });
  }

  /** Same visibility as the lead itself: a 404, like another tenant's lead. */
  private async requireVisibleLead(leadId: string, principal: TenantPrincipal) {
    const lead = await this.leads.findById(leadId, visibilityFilter(principal)?.assignedToId);
    if (!lead) throw AppException.leadNotFound();
    return lead;
  }
}

function describe(dto: UploadAttachmentDto, fileName: string, currency: string): string {
  const label = KIND_LABELS[dto.kind] ?? 'File';
  const amount =
    dto.amount !== undefined
      ? ` · ${new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(dto.amount)}`
      : '';
  const sent = dto.markQuotationSent ? ' — sent to the customer' : '';
  const note = dto.note ? ` — ${dto.note}` : '';
  return `${label} attached: ${fileName}${amount}${sent}${note}`.slice(0, 1000);
}

function toView(
  row: {
    id: string;
    leadId: string;
    kind: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    note: string | null;
    amount: { toString(): string } | null;
    uploadedBy: string | null;
    createdAt: Date;
  },
  names: Map<string, string>,
): AttachmentView {
  return {
    id: row.id,
    leadId: row.leadId,
    kind: row.kind,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    note: row.note,
    amount: row.amount?.toString() ?? null,
    uploadedBy: row.uploadedBy ? { id: row.uploadedBy, fullName: names.get(row.uploadedBy) ?? 'Former member' } : null,
    createdAt: row.createdAt.toISOString(),
    isImage: row.mimeType.startsWith('image/'),
  };
}
