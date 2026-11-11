import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  PERMISSIONS,
  type EmailAudiencePreview,
  type EmailCampaignListItem,
  type EmailCampaignRecipientView,
  type EmailCampaignView,
  type EmailRecipientStatus,
  type EmailRenderedPreview,
  type EmailReplyView,
} from '@leadflow/api-types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../../auth/decorators/permissions.decorator';
import { userActor } from '../../../common/audit/mutation-actor';
import { AppException } from '../../../common/errors/app.exception';
import type { TenantPrincipal } from '../../../common/tenancy/tenant-context.service';
import { CampaignsService } from './campaigns.service';
import { AudiencePreviewDto, ConfirmCampaignDto, SaveCampaignDto } from './dto/campaigns.dto';

const RECIPIENT_STATUSES: EmailRecipientStatus[] = [
  'QUEUED',
  'SENDING',
  'ACCEPTED',
  'FAILED',
  'UNCERTAIN',
  'CANCELLED',
  'SKIPPED',
];

/**
 * Email campaigns.
 *
 * Managers draft, preview and test-send (campaign.manage). Sending to customers
 * — confirming, scheduling, pausing, resuming, cancelling — is Owner/Admin
 * (campaign.send), and nothing is sent without the explicit confirmation call.
 */
@ApiTags('email')
@Controller('email/campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.CAMPAIGN_VIEW)
  async list(): Promise<EmailCampaignListItem[]> {
    return this.campaigns.list();
  }

  @Post()
  @RequirePermissions(PERMISSIONS.CAMPAIGN_MANAGE)
  @ApiOperation({ summary: 'Create a draft campaign' })
  async create(
    @Body() dto: SaveCampaignDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<EmailCampaignView> {
    return this.campaigns.create(dto, userActor(principal));
  }

  @Post('audience')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CAMPAIGN_MANAGE)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'How many people a filter reaches, and why some are excluded. Changes nothing.',
  })
  async audience(
    @Body() dto: AudiencePreviewDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<EmailAudiencePreview> {
    return this.campaigns.previewAudience(dto, principal);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.CAMPAIGN_VIEW)
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<EmailCampaignView> {
    return this.campaigns.get(id);
  }

  @Put(':id')
  @RequirePermissions(PERMISSIONS.CAMPAIGN_MANAGE)
  @ApiOperation({ summary: 'Edit a draft' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveCampaignDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<EmailCampaignView> {
    return this.campaigns.update(id, dto, userActor(principal));
  }

  @Get(':id/preview')
  @RequirePermissions(PERMISSIONS.CAMPAIGN_VIEW)
  @ApiOperation({ summary: 'The rendered message (subject, HTML, text, attachments)' })
  async preview(@Param('id', ParseUUIDPipe) id: string): Promise<EmailRenderedPreview> {
    return this.campaigns.renderPreview(id);
  }

  @Post(':id/test')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CAMPAIGN_MANAGE)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Send one test copy to your own address' })
  async test(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() principal: TenantPrincipal) {
    return this.campaigns.testSend(id, principal);
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CAMPAIGN_SEND)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Confirm and send (or schedule). Idempotent on submitKey.',
    description: 'Refused unless eligibleCount equals the audience at this moment.',
  })
  async confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmCampaignDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<EmailCampaignView> {
    return this.campaigns.confirm(id, dto, principal);
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CAMPAIGN_SEND)
  async pause(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() principal: TenantPrincipal) {
    return this.campaigns.pause(id, userActor(principal));
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CAMPAIGN_SEND)
  async resume(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() principal: TenantPrincipal) {
    return this.campaigns.resume(id, userActor(principal));
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CAMPAIGN_SEND)
  async cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() principal: TenantPrincipal) {
    return this.campaigns.cancel(id, userActor(principal));
  }

  @Get(':id/recipients')
  @RequirePermissions(PERMISSIONS.CAMPAIGN_VIEW)
  @ApiQuery({ name: 'status', required: false, enum: RECIPIENT_STATUSES })
  async recipients(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('status') status?: string,
  ): Promise<EmailCampaignRecipientView[]> {
    if (status && !RECIPIENT_STATUSES.includes(status as EmailRecipientStatus)) {
      throw AppException.validation(`status must be one of: ${RECIPIENT_STATUSES.join(', ')}`);
    }
    return this.campaigns.recipients(id, status as EmailRecipientStatus | undefined);
  }

  @Get(':id/replies')
  @RequirePermissions(PERMISSIONS.CAMPAIGN_VIEW)
  async replies(@Param('id', ParseUUIDPipe) id: string): Promise<EmailReplyView[]> {
    return this.campaigns.replies(id);
  }
}
