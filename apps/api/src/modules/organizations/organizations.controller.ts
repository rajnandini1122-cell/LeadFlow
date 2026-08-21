import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type OrganizationDetail } from '@leadflow/api-types';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { OrganizationsService } from './organizations.service';
import { UsersService } from '../users/users.service';
import { OffboardingService } from '../users/offboarding.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { UpdateOrganizationDto } from './dto/organizations.dto';
import { AuditQueryDto, LeaveOrganizationDto } from '../users/dto/offboarding.dto';

/**
 * There is deliberately no `GET /organizations/:id`. The caller's organization
 * is derived from their token, so an id parameter would be either redundant or
 * an invitation to try someone else's.
 */
@ApiTags('organizations')
@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly organizations: OrganizationsService,
    private readonly users: UsersService,
    private readonly offboarding: OffboardingService,
  ) {}

  @Get('current')
  @RequirePermissions(PERMISSIONS.ORG_VIEW)
  @ApiOperation({ summary: 'Get the signed-in user’s organization and its settings' })
  async current(): Promise<OrganizationDetail> {
    return this.organizations.current();
  }

  @Patch('current')
  @RequirePermissions(PERMISSIONS.ORG_UPDATE)
  @ApiOperation({ summary: 'Update organization profile and follow-up settings' })
  async update(@Body() dto: UpdateOrganizationDto): Promise<OrganizationDetail> {
    return this.organizations.update(dto);
  }
  @Get('audit')
  @RequirePermissions(PERMISSIONS.USER_UPDATE)
  @ApiOperation({
    summary: 'Administrative audit trail for this organization',
    description:
      'Role changes, admin transfers, deactivations, removals and bulk lead ' +
      'reassignments, newest first. Scoped to the caller’s organization.',
  })
  async audit(@Query() query: AuditQueryDto) {
    return this.offboarding.auditTrail({ limit: query.limit, cursor: query.cursor });
  }

  @Post('leave')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Leave the current organization',
    description:
      'Refused for the last active administrator, and refused when the caller ' +
      'still owns active leads or open follow-ups unless they name a colleague ' +
      'to take them over. Memberships in other organizations are unaffected.',
  })
  async leave(
    @Body() dto: LeaveOrganizationDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<void> {
    await this.users.leave(principal, {
      reassignToId: dto.reassignToId,
      includeHistorical: dto.includeHistorical,
    });
  }
}
