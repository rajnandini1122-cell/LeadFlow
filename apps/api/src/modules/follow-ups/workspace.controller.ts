import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { PERMISSIONS } from '@leadflow/api-types';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { FollowUpsService, type WorkspaceSummary } from './follow-ups.service';

export class WorkspaceSummaryDto {
  /** Narrows a team view to one person. Can never widen a rep's own view. */
  @IsOptional()
  @IsUUID('7')
  assignedUserId?: string;
}

/**
 * "My work today" — the numbers a salesperson opens the app to see.
 *
 * Every count comes from the same predicates as the lists behind it (follow-up
 * buckets, lead filters), so a tile never claims a number its list does not
 * show. Scope follows permissions: a rep sees their own work, a manager the
 * team's unless they narrow it to one person.
 */
@ApiTags('workspace')
@Controller('workspace')
export class WorkspaceController {
  constructor(private readonly followUps: FollowUpsService) {}

  @Get('summary')
  @RequirePermissions(PERMISSIONS.LEAD_VIEW_OWN)
  @ApiOperation({ summary: 'Counts for the sales workspace, in the organization timezone' })
  async summary(
    @Query() dto: WorkspaceSummaryDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<WorkspaceSummary> {
    return this.followUps.workspaceSummary(principal, { assignedUserId: dto.assignedUserId });
  }
}
