import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@leadflow/api-types';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { IntegrationsService } from './integrations.service';
import { SetIntegrationEnabledDto } from './dto/conversations.dto';

/**
 * Channel integration management.
 *
 * There is no `connect` endpoint, deliberately. No provider is implemented, so
 * anything that produced a CONNECTED row would be recording something that did
 * not happen — and an owner who believes their WhatsApp number is live stops
 * checking their phone. The settings screen reads `connectable` and says so
 * plainly instead.
 *
 * Reading requires `org.view` and changing requires `org.update`: this is
 * organization configuration, and it reuses the permissions that already guard
 * it rather than inventing an omnichannel-specific pair.
 */
@ApiTags('channel-integrations')
@Controller('channel-integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ORG_VIEW)
  @ApiOperation({ summary: 'Every supported channel and its connection state' })
  async list() {
    return this.integrations.list();
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.ORG_UPDATE)
  @ApiOperation({ summary: 'Switch an integration on or off' })
  async setEnabled(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetIntegrationEnabledDto,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.integrations.setEnabled(id, dto.enabled, principal.userId);
  }
}
