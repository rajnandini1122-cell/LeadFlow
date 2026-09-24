import { Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type PlatformOrganizationView } from '@leadflow/api-types';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PlatformOwner } from '../auth/decorators/platform-owner.decorator';
import { PlatformAdminService } from './platform-admin.service';

/**
 * The CRAVION platform console.
 *
 * Every route carries BOTH `@PlatformOwner()` and a `platform.*` permission.
 * That is not redundancy: the role answers "is this CRAVION's operator", the
 * permission answers "may they do this particular thing", and a future CRAVION
 * staff role could hold some of the permissions without being the platform
 * owner. A customer's OWNER satisfies neither.
 *
 * The class-level decorators cover every handler, so a route added below is
 * guarded by default rather than by remembering. The guard that reads them is
 * registered globally, so an endpoint cannot be left unprotected by forgetting
 * to attach one.
 */
@ApiTags('platform')
@Controller('platform')
@PlatformOwner()
export class PlatformAdminController {
  constructor(private readonly platform: PlatformAdminService) {}

  @Get('organizations')
  @RequirePermissions(PERMISSIONS.PLATFORM_ORGANIZATION_VIEW)
  @ApiOperation({
    summary: 'Every organization on the platform',
    description:
      'Identity, lifecycle and size only — no customer business data. The ' +
      'platform organization is listed first and reports a PLATFORM_INTERNAL ' +
      'entitlement rather than a subscription.',
  })
  async organizations(): Promise<PlatformOrganizationView[]> {
    return this.platform.listOrganizations();
  }

  @Get('organizations/:id')
  @RequirePermissions(PERMISSIONS.PLATFORM_ORGANIZATION_VIEW)
  @ApiOperation({
    summary: 'One organization',
    description: 'Audited against the target organization, so the customer can see it happened.',
  })
  async organization(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PlatformOrganizationView> {
    return this.platform.findOrganization(id);
  }

  @Post('organizations/:id/suspend')
  @RequirePermissions(PERMISSIONS.PLATFORM_ORGANIZATION_MANAGE)
  @ApiOperation({
    summary: 'Suspend a customer organization',
    description:
      'Refused for the platform organization: suspending CRAVION would lock it ' +
      'out of the console needed to undo it.',
  })
  async suspend(@Param('id', ParseUUIDPipe) id: string): Promise<PlatformOrganizationView> {
    return this.platform.suspendOrganization(id);
  }

  @Post('organizations/:id/reactivate')
  @RequirePermissions(PERMISSIONS.PLATFORM_ORGANIZATION_MANAGE)
  @ApiOperation({ summary: 'Reactivate a suspended customer organization' })
  async reactivate(@Param('id', ParseUUIDPipe) id: string): Promise<PlatformOrganizationView> {
    return this.platform.reactivateOrganization(id);
  }
}
