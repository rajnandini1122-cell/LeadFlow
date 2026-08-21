import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@leadflow/api-types';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { DashboardService, type DashboardSummary } from './dashboard.service';

@ApiTags('dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.DASHBOARD_VIEW_OWN)
  @ApiOperation({
    summary: 'Aggregated dashboard figures',
    description:
      'Computed by the database across the whole dataset and bucketed in the ' +
      "organization's timezone. The breadth of the figures follows the " +
      'caller\u2019s lead visibility: a sales rep sees their own pipeline, a ' +
      'manager or owner sees the team\u2019s.',
  })
  async summary(@CurrentUser() principal: TenantPrincipal): Promise<DashboardSummary> {
    return this.dashboard.summary(principal);
  }
}
