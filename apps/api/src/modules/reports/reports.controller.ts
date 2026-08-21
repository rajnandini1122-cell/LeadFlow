import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@leadflow/api-types';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { DailyReportDto, ReportRangeDto } from './dto/reports.dto';
import {
  ReportsService,
  type DailyReport,
  type ReportOverview,
  type TeamReport,
} from './reports.service';

/**
 * Reporting endpoints.
 *
 * Everything here aggregates in the database over the complete tenant dataset.
 * The breadth of what a caller sees follows their EXISTING lead-visibility
 * permissions — there is no second authorization model for reports, because two
 * implementations of the same rule eventually disagree, and the one that is
 * wrong is the one nobody is testing.
 */
@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('overview')
  @RequirePermissions(PERMISSIONS.DASHBOARD_VIEW_OWN)
  @ApiOperation({
    summary: 'Headline metrics for a date range',
    description:
      'Range boundaries are wall-clock days in the ORGANIZATION timezone. The ' +
      'response carries a `basis` map naming the timestamp each metric is ' +
      'measured against — created date, won date, scheduled date — because ' +
      '"won this month" means different things depending on the answer.',
  })
  async overview(
    @Query() query: ReportRangeDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<ReportOverview> {
    return this.reports.overview(query, principal);
  }

  @Get('daily')
  @RequirePermissions(PERMISSIONS.DASHBOARD_VIEW_OWN)
  @ApiOperation({
    summary: 'One day of activity',
    description:
      'Defaults to today in the organization timezone. A sales rep sees their ' +
      'own day; a manager or owner sees the team\u2019s.',
  })
  async daily(
    @Query() query: DailyReportDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<DailyReport> {
    return this.reports.daily(query, principal);
  }

  @Get('team')
  @RequirePermissions(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({
    summary: 'Per-member performance for a date range',
    description:
      'Requires report.view, which a sales rep does not hold. A caller who ' +
      'holds it but can still only see their own leads gets only their own ' +
      'row — the permission grants the screen, not the scope.',
  })
  async team(
    @Query() query: ReportRangeDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<TeamReport> {
    return this.reports.team(query, principal);
  }
}
