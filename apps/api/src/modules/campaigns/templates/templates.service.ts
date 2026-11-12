import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  EMAIL_MERGE_FIELDS,
  type EmailAssetView,
  type EmailTemplateView,
} from '@leadflow/api-types';
import { AppException } from '../../../common/errors/app.exception';
import { AuditRepository } from '../../../common/audit/audit.repository';
import { auditAttribution, type MutationActor } from '../../../common/audit/mutation-actor';
import {
  detectAttachmentType,
  sanitizeFileName,
} from '../../leads/attachments/attachment-file-type';
import { htmlToPlainText, sanitizeEmailHtml, unknownMergeFields } from '../content/email-content';
import { TemplatesRepository } from './templates.repository';
import type { SaveTemplateDto } from './dto/templates.dto';

/** Per file. Mail servers commonly refuse messages over 10–25 MB in total. */
export const MAX_EMAIL_ASSET_BYTES = 5 * 1024 * 1024;
/** All attachments of one campaign together. */
export const MAX_CAMPAIGN_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const EMAIL_ASSET_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg']);

export interface UploadedAsset {
  buffer: Buffer;
  size: number;
  originalname?: string;
}

/** Validated, sanitized email content, shared by templates and campaigns. */
export function prepareContent(input: {
  subject: string;
  html: string;
  text?: string | undefined;
}): {
  subject: string;
  html: string;
  text: string;
} {
  const unknown = unknownMergeFields(input.subject, input.html, input.text ?? '');
  if (unknown.length > 0) {
    throw AppException.validation(
      `Unknown merge field${unknown.length > 1 ? 's' : ''}: ${unknown.map((f) => `{{${f}}}`).join(', ')}. ` +
        `Available: ${EMAIL_MERGE_FIELDS.map((f) => `{{${f}}}`).join(', ')}.`,
    );
  }
  if (/[\r\n]/.test(input.subject)) throw AppException.validation('The subject must be one line.');
  const html = sanitizeEmailHtml(input.html);
  const text = (input.text ?? '').trim() || htmlToPlainText(html);
  if (!text.trim()) throw AppException.validation('The email has no content.');
  return { subject: input.subject.trim(), html, text };
}

@Injectable()
export class TemplatesService {
  constructor(
    private readonly repository: TemplatesRepository,
    private readonly audit: AuditRepository,
  ) {}

  async list(includeArchived: boolean): Promise<EmailTemplateView[]> {
    return (await this.repository.listTemplates(includeArchived)).map(toTemplateView);
  }

  async create(dto: SaveTemplateDto, actor: MutationActor): Promise<EmailTemplateView> {
    const content = prepareContent(dto);
    const created = await this.repository.createTemplate({
      name: dto.name,
      category: dto.category,
      ...content,
      by: actor.kind === 'USER' ? actor.userId : null,
    });
    await this.audit.record({
      action: 'email.template.created',
      entityType: 'EmailTemplate',
      entityId: created.id,
      ...auditAttribution(actor),
      after: { name: dto.name, category: dto.category },
    });
    return toTemplateView(created);
  }

  async update(id: string, dto: SaveTemplateDto, actor: MutationActor): Promise<EmailTemplateView> {
    const existing = await this.repository.findTemplate(id);
    if (!existing) throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Template not found.');
    const content = prepareContent(dto);
    const updated = await this.repository.updateTemplate(id, {
      name: dto.name,
      category: dto.category,
      ...content,
      updatedBy: actor.kind === 'USER' ? actor.userId : null,
    });
    await this.audit.record({
      action: 'email.template.updated',
      entityType: 'EmailTemplate',
      entityId: id,
      ...auditAttribution(actor),
      before: { name: existing.name },
      after: { name: dto.name, category: dto.category },
    });
    return toTemplateView(updated);
  }

  async setArchived(
    id: string,
    archived: boolean,
    actor: MutationActor,
  ): Promise<EmailTemplateView> {
    const existing = await this.repository.findTemplate(id);
    if (!existing) throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Template not found.');
    const updated = await this.repository.updateTemplate(id, {
      archivedAt: archived ? new Date() : null,
    });
    await this.audit.record({
      action: archived ? 'email.template.archived' : 'email.template.restored',
      entityType: 'EmailTemplate',
      entityId: id,
      ...auditAttribution(actor),
    });
    return toTemplateView(updated);
  }

  // --- attachments -------------------------------------------------------------

  async assets(): Promise<EmailAssetView[]> {
    return (await this.repository.listAssets()).map(toAssetView);
  }

  async upload(
    file: UploadedAsset | undefined,
    productId: string | undefined,
    actor: MutationActor,
  ): Promise<EmailAssetView> {
    if (!file || file.size === 0) throw AppException.validation('Choose a file to upload.');
    if (file.size > MAX_EMAIL_ASSET_BYTES)
      throw AppException.validation('Email attachments must be 5 MB or smaller.');
    // The type is read from the bytes, not trusted from the name or the browser.
    const detected = detectAttachmentType(file.buffer, file.originalname ?? '');
    if (!detected || !EMAIL_ASSET_TYPES.has(detected.mimeType)) {
      throw AppException.validation('Email attachments must be PDF, PNG or JPEG files.');
    }
    if (productId && !(await this.repository.productExists(productId))) {
      throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Product not found.');
    }
    const created = await this.repository.createAsset({
      fileName: sanitizeFileName(file.originalname ?? 'attachment', detected.extension),
      mimeType: detected.mimeType,
      sizeBytes: file.size,
      sha256: createHash('sha256').update(file.buffer).digest('hex'),
      data: file.buffer,
      productId: productId ?? null,
      by: actor.kind === 'USER' ? actor.userId : null,
    });
    await this.audit.record({
      action: 'email.asset.uploaded',
      entityType: 'EmailAsset',
      entityId: created.id,
      ...auditAttribution(actor),
      after: {
        fileName: created.fileName,
        sizeBytes: created.sizeBytes,
        productId: created.productId,
      },
    });
    return toAssetView(created);
  }

  async deleteAsset(id: string, actor: MutationActor): Promise<void> {
    if (!(await this.repository.deleteAsset(id)))
      throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Attachment not found.');
    await this.audit.record({
      action: 'email.asset.deleted',
      entityType: 'EmailAsset',
      entityId: id,
      ...auditAttribution(actor),
    });
  }

  /** Checks ids belong to this organization and fit the size budget. */
  async requireAssets(ids: string[]): Promise<EmailAssetView[]> {
    const unique = [...new Set(ids)];
    const found = await this.repository.findAssets(unique);
    if (found.length !== unique.length)
      throw AppException.validation('One or more attachments no longer exist.');
    const total = found.reduce((sum, asset) => sum + asset.sizeBytes, 0);
    if (total > MAX_CAMPAIGN_ATTACHMENT_BYTES)
      throw AppException.validation('Attachments may total at most 10 MB per email.');
    return found.map(toAssetView);
  }
}

type TemplateRow = Awaited<ReturnType<TemplatesRepository['findTemplate']>> & object;
type AssetRow = Awaited<ReturnType<TemplatesRepository['listAssets']>>[number];

function toTemplateView(row: TemplateRow): EmailTemplateView {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    subject: row.subject,
    html: row.html,
    text: row.text,
    archived: row.archivedAt !== null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toAssetView(row: AssetRow): EmailAssetView {
  return {
    id: row.id,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    productId: row.productId,
    productName: row.product?.name ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
