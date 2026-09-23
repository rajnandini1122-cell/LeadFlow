import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@leadflow/api-types';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ConversationLinkingService } from './conversation-linking.service';
import { ConversationReviewService } from './conversation-review.service';
import { OutboundMessagingService } from './outbound-messaging.service';
import { MediaService } from './media.service';
import { MAX_UPLOAD_BYTES, type UploadedMedia } from './message-attachment';
import {
  ArchiveConversationDto,
  AssignConversationDto,
  InboxQueryDto,
  LinkConversationDto,
  ListConversationsDto,
  ReviewQueueDto,
  SendMessageDto,
  SendTemplateDto,
} from './dto/conversations.dto';

/**
 * Conversation endpoints.
 *
 * Deliberately a separate controller rather than new routes on the leads
 * controller: the existing lead API keeps exactly the surface it has today, and
 * a client that never asks about conversations sees no change at all.
 *
 * Note what is NOT here: any way to create a lead. "Create lead" in the review
 * queue calls the ordinary POST /leads and then POST /conversations/:id/link,
 * so a lead born from a WhatsApp message passes through the same validation,
 * duplicate detection and assignment rules as one typed in by hand. A
 * convenience endpoint here would be a second lead-creation path, and the two
 * would drift.
 *
 * Permissions reuse the existing lead catalogue. Reading a conversation is
 * reading the lead it belongs to, and attaching one changes what the lead
 * shows, so `lead.view.own` and `lead.update` are the honest requirements.
 */
@ApiTags('conversations')
@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly linking: ConversationLinkingService,
    private readonly review: ConversationReviewService,
    private readonly outbound: OutboundMessagingService,
    private readonly media: MediaService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.LEAD_VIEW_OWN)
  @ApiOperation({ summary: 'Conversations linked to a lead' })
  async list(@Query() query: ListConversationsDto, @CurrentUser() principal: TenantPrincipal) {
    return this.linking.forLead(query.leadId, principal);
  }

  /**
   * The unified inbox.
   *
   * Same rows, same table and same visibility policy as the review queue — it
   * simply does not hide threads that have already been linked. There is no
   * second conversation store and nothing is copied between the two views.
   */
  @Get('inbox')
  @RequirePermissions(PERMISSIONS.LEAD_VIEW_OWN)
  @ApiOperation({ summary: 'Every conversation this user may see' })
  async inbox(@Query() query: InboxQueryDto, @CurrentUser() principal: TenantPrincipal) {
    return this.review.list(
      {
        ...(query.channel ? { channel: query.channel } : {}),
        ...(query.archived ? { archived: query.archived } : {}),
        ...(query.limit ? { limit: query.limit } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.filter === 'MINE' || query.filter === 'UNASSIGNED'
          ? { inboxFilter: query.filter }
          : {}),
        includeLinked: true,
      },
      principal,
    );
  }

  @Get('inbox/counts')
  @RequirePermissions(PERMISSIONS.LEAD_VIEW_OWN)
  @ApiOperation({ summary: 'Counts for the inbox tabs' })
  async inboxCounts(@CurrentUser() principal: TenantPrincipal) {
    return this.review.inboxCounts(principal);
  }

  @Get('review')
  @RequirePermissions(PERMISSIONS.LEAD_VIEW_OWN)
  @ApiOperation({ summary: 'Conversations waiting on a human decision' })
  async reviewQueue(@Query() query: ReviewQueueDto, @CurrentUser() principal: TenantPrincipal) {
    return this.review.list(query, principal);
  }

  @Get('review/count')
  @RequirePermissions(PERMISSIONS.LEAD_VIEW_OWN)
  @ApiOperation({ summary: 'How many conversations are waiting' })
  async reviewCount(@CurrentUser() principal: TenantPrincipal) {
    return this.review.pendingCount(principal);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.LEAD_VIEW_OWN)
  @ApiOperation({ summary: 'One conversation with its message history' })
  async detail(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.review.detail(id, principal);
  }

  /**
   * Reply to a customer.
   *
   * A message belongs to a conversation, so it lives under one — not under a
   * provider-shaped route. Nothing about WhatsApp appears in this signature,
   * and nothing needs to: the conversation already knows its channel.
   *
   * Permission is `lead.update`, the same as attaching a conversation to a
   * lead. Replying to a customer changes what the lead shows and is an action
   * on the pipeline, so it is not a read; inventing a separate messaging
   * permission would create a second thing to keep in step with lead access.
   */
  @Post(':id/messages')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  /*
   * One endpoint for text and for media.
   *
   * `FileInterceptor` handles a multipart body and passes a JSON one straight
   * through, so a text-only request is byte-for-byte what it was before media
   * existed. A second endpoint would have meant a second set of authorization,
   * visibility and idempotency checks to keep in step.
   *
   * The size limit is enforced HERE, by the parser, before the bytes are fully
   * read. Checking afterwards would mean accepting an arbitrarily large upload
   * into memory in order to reject it.
   */
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    }),
  )
  @ApiOperation({ summary: 'Send a reply on this conversation, optionally with a file' })
  async sendMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendMessageDto,
    @CurrentUser() principal: TenantPrincipal,
    @UploadedFile() file?: UploadedMedia,
  ) {
    return this.outbound.send(
      id,
      {
        content: dto.content ?? '',
        idempotencyKey: dto.idempotencyKey,
        ...(file ? { file } : {}),
      },
      principal,
    );
  }

  /**
   * Send an approved WhatsApp template.
   *
   * A SEPARATE endpoint from `POST :id/messages`, on purpose. Sending a
   * template is a different act with a different cost — it can reach a customer
   * whose 24-hour window has closed, and on most plans it is billed — so it is
   * something a person chooses, never something the ordinary send route falls
   * back to when the window check refuses. Folding it into the message endpoint
   * would make that fallback one `if` away.
   */
  @Post(':id/template-messages')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  @ApiOperation({ summary: 'Send an approved WhatsApp template on this conversation' })
  async sendTemplateMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendTemplateDto,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.outbound.sendTemplate(
      id,
      {
        templateName: dto.templateName,
        language: dto.language,
        parameters: {
          header: dto.headerParameters ?? [],
          body: dto.bodyParameters ?? [],
        },
        idempotencyKey: dto.idempotencyKey,
      },
      principal,
    );
  }

  /**
   * The bytes of one attachment.
   *
   * Both ids are in the path and both are verified: the conversation against
   * this caller's visibility, and the message against that conversation. The
   * attachment is addressed by its index within the message, which cannot be
   * walked across tenants the way a global id could.
   *
   * Deliberately not a redirect to the provider. Meta's media links are
   * unguessable capability URLs — handing one to a browser would give away
   * access to a customer's file and hand over something that expires.
   */
  @Get(':id/messages/:messageId/attachments/:index')
  @RequirePermissions(PERMISSIONS.LEAD_VIEW_OWN)
  @ApiOperation({ summary: 'Download an attachment on this conversation' })
  async downloadAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Param('index', ParseIntPipe) index: number,
    @CurrentUser() principal: TenantPrincipal,
    @Res() response: Response,
  ): Promise<void> {
    const media = await this.media.fetch(id, messageId, index, principal);

    /*
     * Served as an attachment, never inline.
     *
     * A customer-supplied file rendered inline in the application's own origin
     * is a stored-XSS vector — an SVG or an HTML file would execute with the
     * user's session. `Content-Disposition: attachment` plus nosniff means the
     * browser downloads it instead of running it.
     */
    response.setHeader('Content-Type', media.contentType);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${sanitiseFilename(media.filename)}"`,
    );
    // Private: this is one tenant's customer data, not something a shared
    // cache should ever hold.
    response.setHeader('Cache-Control', 'private, no-store');

    response.end(media.body);
  }

  @Post(':id/link')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  @ApiOperation({ summary: 'Attach a conversation to an existing lead' })
  async link(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LinkConversationDto,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.linking.link(id, dto.leadId, principal);
  }

  @Post(':id/unlink')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  @ApiOperation({ summary: 'Detach a conversation from its lead' })
  async unlink(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.linking.unlink(id, principal);
  }

  /**
   * Hand a conversation to someone.
   *
   * Conversation ownership ONLY. The linked lead keeps its assignee — passing
   * a thread to a colleague is not the same act as passing them the deal.
   */
  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  @ApiOperation({ summary: 'Set who is handling a conversation' })
  async assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignConversationDto,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.review.assign(id, dto.userId ?? null, principal);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  @ApiOperation({ summary: 'Dismiss a conversation from the review queue' })
  async archive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ArchiveConversationDto,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.review.archive(id, dto.reason ?? null, principal);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.LEAD_UPDATE)
  @ApiOperation({ summary: 'Return a dismissed conversation to the review queue' })
  async restore(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.review.restore(id, principal);
  }
}

/**
 * A filename safe to put in a Content-Disposition header.
 *
 * Path separators, quotes and control characters are stripped rather than
 * escaped: the name comes from a provider, it is only a hint to the browser,
 * and header injection through a quote or a newline is the failure worth
 * preventing. Everything else falls back to a neutral name.
 */
function sanitiseFilename(filename: string | null): string {
  if (!filename) return 'attachment';

  const cleaned = filename
    .replace(/[\r\n"\\]/g, '')
    .replace(/[/\\]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 120);

  return cleaned.length > 0 ? cleaned : 'attachment';
}
