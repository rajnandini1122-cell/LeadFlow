import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { PERMISSIONS } from '@leadflow/api-types';
import type { TenantPrincipal } from '../../../common/tenancy/tenant-context.service';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../../auth/decorators/permissions.decorator';
import { IdempotencyKey } from '../../../common/web/idempotency-key.decorator';
import { MAX_ATTACHMENT_BYTES } from './attachment-file-type';
import { UploadAttachmentDto } from './lead-attachments.dto';
import { LeadAttachmentsService, type UploadedFile as Upload } from './lead-attachments.service';

/**
 * Files on a lead: quotations, invoices, purchase orders, photos.
 *
 * Visibility is the lead's own: a caller who cannot see the lead gets the
 * same 404 as for another tenant's.
 */
@ApiTags('leads')
@Controller('leads')
export class LeadAttachmentsController {
  constructor(private readonly attachments: LeadAttachmentsService) {}

  @Get(':id/attachments')
  @RequirePermissions(PERMISSIONS.LEAD_VIEW_OWN)
  @ApiOperation({ summary: 'Files attached to a lead (metadata only)' })
  async list(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.attachments.list(id, principal);
  }

  /**
   * The size cap is enforced by the PARSER, before the bytes are fully read —
   * checking afterwards would accept an arbitrarily large upload into memory
   * in order to reject it.
   */
  @Post(':id/attachments')
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 } }))
  @ApiOperation({
    summary: 'Attach a file to a lead',
    description:
      'PDF, JPEG, PNG, WebP, Excel, Word, CSV or text, up to 10 MB, type detected from the bytes. ' +
      'A quotation can be marked as sent, which moves the stage forward to Quotation sent. ' +
      'Send an Idempotency-Key to make a retried upload safe.',
  })
  async upload(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @Body() dto: UploadAttachmentDto,
    @CurrentUser() principal: TenantPrincipal,
    @IdempotencyKey() idempotencyKey: string | null,
    @UploadedFile() file?: Upload,
  ) {
    return this.attachments.upload(id, file, dto, principal, idempotencyKey);
  }

  @Get(':id/attachments/:attachmentId/download')
  @RequirePermissions(PERMISSIONS.LEAD_VIEW_OWN)
  @ApiOperation({ summary: 'Download an attached file' })
  async download(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @Param('attachmentId', new ParseUUIDPipe({ version: '7' })) attachmentId: string,
    @CurrentUser() principal: TenantPrincipal,
    @Res() response: Response,
  ): Promise<void> {
    const file = await this.attachments.download(id, attachmentId, principal);

    response.setHeader('Content-Type', file.mimeType);
    response.setHeader('Content-Length', String(file.sizeBytes));
    // Always a download, never rendered in our origin; the name is RFC 5987
    // encoded so non-ASCII names survive and quotes cannot break the header.
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.fileName.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    response.setHeader('Cache-Control', 'private, no-store');
    response.end(Buffer.from(file.data));
  }

  @Delete(':id/attachments/:attachmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  @ApiOperation({ summary: 'Remove an attached file (kept, recoverable, on the record)' })
  async remove(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @Param('attachmentId', new ParseUUIDPipe({ version: '7' })) attachmentId: string,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<void> {
    await this.attachments.remove(id, attachmentId, principal);
  }
}
