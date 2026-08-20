import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type OrganizationDetail } from '@leadflow/api-types';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { OrganizationsService } from './organizations.service';
import { UsersService } from '../users/users.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { UpdateOrganizationDto } from './dto/organizations.dto';

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
  @Post('leave')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Leave the current organization',
    description:
      'Refused for the last active owner, which would leave the organization ' +
      'unadministrable. Memberships in other organizations are unaffected.',
  })
  async leave(@CurrentUser() principal: TenantPrincipal): Promise<void> {
    await this.users.leave(principal);
  }
}
