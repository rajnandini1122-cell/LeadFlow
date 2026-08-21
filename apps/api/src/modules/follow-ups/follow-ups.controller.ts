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
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@leadflow/api-types';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { FollowUpsService, type FollowUpView } from './follow-ups.service';
import {
  CancelFollowUpDto,
  CompleteFollowUpDto,
  ListFollowUpsDto,
  RescheduleFollowUpDto,
} from './dto/follow-ups.dto';

/**
 * The follow-up engine's HTTP surface.
 *
 * Visibility is derived server-side from permissions: a holder of
 * `followup.view.team` sees the whole organization, everyone else sees only
 * their own. The `assignedUserId` query parameter can NARROW that but never
 * widen it.
 */
@ApiTags('follow-ups')
@Controller('follow-ups')
export class FollowUpsController {
  constructor(private readonly followUps: FollowUpsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.LEAD_VIEW_OWN)
  @ApiOperation({
    summary: 'Follow-ups in a bucket',
    description:
      'Buckets are computed in the ORGANIZATION timezone, so "today" means ' +
      'today where the team actually is. Defaults to today.',
  })
  async list(
    @Query() dto: ListFollowUpsDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<FollowUpView[]> {
    return this.followUps.listBucket(dto.bucket ?? 'today', principal, {
      assignedUserId: dto.assignedUserId,
      limit: dto.limit,
    });
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.FOLLOW_UP_COMPLETE)
  @ApiOperation({
    summary: 'Complete a follow-up',
    description:
      'Requires either the next follow-up date or a terminal lead status — an ' +
      'open lead may not be left with no next action.',
  })
  async complete(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @Body() dto: CompleteFollowUpDto,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.followUps.complete(id, dto, principal);
  }

  @Post(':id/reschedule')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.FOLLOW_UP_CREATE)
  @ApiOperation({
    summary: 'Reschedule a follow-up',
    description:
      'Creates a replacement and links the original to it, so a missed attempt ' +
      'stays visible instead of one row silently changing date.',
  })
  async reschedule(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @Body() dto: RescheduleFollowUpDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<FollowUpView> {
    return this.followUps.reschedule(id, dto, principal);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.FOLLOW_UP_CREATE)
  @ApiOperation({
    summary: 'Cancel a follow-up',
    description:
      'Refused when it is the only open follow-up on a still-open lead, which ' +
      'would leave that lead with no next action.',
  })
  async cancel(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @Body() dto: CancelFollowUpDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<void> {
    await this.followUps.cancel(id, dto, principal);
  }
}
