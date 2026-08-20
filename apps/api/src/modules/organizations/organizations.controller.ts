import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type OrganizationDetail } from '@idea001/api-types';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { OrganizationsService } from './organizations.service';
import { UpdateOrganizationDto } from './dto/organizations.dto';

/**
 * There is deliberately no `GET /organizations/:id`. The caller's organization
 * is derived from their token, so an id parameter would be either redundant or
 * an invitation to try someone else's.
 */
@ApiTags('organizations')
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

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
}
