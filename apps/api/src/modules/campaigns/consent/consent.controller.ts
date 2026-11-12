import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  type EmailSuppressionView,
  type MarketingEligibilityView,
} from '@leadflow/api-types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../../auth/decorators/permissions.decorator';
import { userActor } from '../../../common/audit/mutation-actor';
import type { TenantPrincipal } from '../../../common/tenancy/tenant-context.service';
import { ConsentService } from './consent.service';
import { GrantConsentDto, SuppressDto, UnsuppressDto, WithdrawConsentDto } from './dto/consent.dto';

/**
 * Marketing eligibility and the suppression list. Viewing needs campaign.view;
 * changing who may receive promotional mail is Owner/Admin
 * (marketing.consent.manage), and every change is audited.
 */
@ApiTags('email')
@Controller('email')
export class ConsentController {
  constructor(private readonly consent: ConsentService) {}

  @Get('eligibility')
  @RequirePermissions(PERMISSIONS.CAMPAIGN_VIEW)
  @ApiQuery({ name: 'search', required: false })
  @ApiOperation({
    summary: 'Addresses on leads and contacts, with their marketing eligibility and suppression',
  })
  async eligibility(@Query('search') search?: string): Promise<MarketingEligibilityView[]> {
    return this.consent.eligibility(search ?? null);
  }

  @Post('eligibility/grant')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.MARKETING_CONSENT_MANAGE)
  @ApiOperation({ summary: 'Record that addresses may receive promotional email, and why' })
  async grant(@Body() dto: GrantConsentDto, @CurrentUser() principal: TenantPrincipal) {
    return this.consent.grant(dto, userActor(principal));
  }

  @Post('eligibility/withdraw')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.MARKETING_CONSENT_MANAGE)
  @ApiOperation({ summary: 'Withdraw marketing eligibility' })
  async withdraw(@Body() dto: WithdrawConsentDto, @CurrentUser() principal: TenantPrincipal) {
    return this.consent.withdraw(dto, userActor(principal));
  }

  @Get('suppressions')
  @RequirePermissions(PERMISSIONS.CAMPAIGN_VIEW)
  @ApiOperation({ summary: 'Addresses that receive no campaign email' })
  async suppressions(): Promise<EmailSuppressionView[]> {
    return this.consent.suppressions();
  }

  @Post('suppressions')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.MARKETING_CONSENT_MANAGE)
  @ApiOperation({ summary: 'Suppress addresses manually' })
  async suppress(@Body() dto: SuppressDto, @CurrentUser() principal: TenantPrincipal) {
    return this.consent.suppress(dto, userActor(principal));
  }

  @Post('suppressions/remove')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.MARKETING_CONSENT_MANAGE)
  @ApiOperation({
    summary:
      'Remove a manual or bounce suppression. Unsubscribes and complaints cannot be removed.',
  })
  async unsuppress(
    @Body() dto: UnsuppressDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<void> {
    await this.consent.unsuppress(dto.email, dto.note, userActor(principal));
  }
}
