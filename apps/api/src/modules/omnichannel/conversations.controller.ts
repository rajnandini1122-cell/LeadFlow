import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@leadflow/api-types';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ConversationLinkingService } from './conversation-linking.service';
import { LinkConversationDto, ListConversationsDto } from './dto/conversations.dto';

/**
 * Conversation endpoints.
 *
 * Deliberately a separate controller rather than new routes on the leads
 * controller: the existing lead API keeps exactly the surface it has today, and
 * a client that never asks about conversations sees no change at all.
 *
 * Permissions reuse the existing lead catalogue. Reading a conversation is
 * reading the lead it belongs to, and attaching one changes what the lead
 * shows, so `lead.view.own` and `lead.update` are the honest requirements —
 * inventing a parallel permission set would let the two drift apart.
 */
@ApiTags('conversations')
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly linking: ConversationLinkingService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.LEAD_VIEW_OWN)
  @ApiOperation({ summary: 'Conversations linked to a lead' })
  async list(@Query() query: ListConversationsDto, @CurrentUser() principal: TenantPrincipal) {
    return this.linking.forLead(query.leadId, principal);
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
}
