import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@leadflow/api-types';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ConversationLinkingService } from './conversation-linking.service';
import { ConversationReviewService } from './conversation-review.service';
import {
  ArchiveConversationDto,
  LinkConversationDto,
  ListConversationsDto,
  ReviewQueueDto,
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
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.LEAD_VIEW_OWN)
  @ApiOperation({ summary: 'Conversations linked to a lead' })
  async list(@Query() query: ListConversationsDto, @CurrentUser() principal: TenantPrincipal) {
    return this.linking.forLead(query.leadId, principal);
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
