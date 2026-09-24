import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  type EntitlementView,
  type PlanView,
  type SubscriptionView,
} from '@leadflow/api-types';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { SubscriptionsService } from './subscriptions.service';
import { EntitlementsService } from './entitlements.service';
import { ChangePlanDto } from './dto/subscriptions.dto';

/**
 * The plan catalogue.
 *
 * PUBLIC, and separated from the subscription routes for that reason. The
 * pricing page must render for a visitor who has never signed in, so this
 * endpoint has no tenant context and returns nothing tenant-specific — just
 * the catalogue every organization is offered.
 *
 * There is deliberately no write route. Plans are seeded and changed through
 * the catalogue in source, so no HTTP surface exists for editing one — which
 * is also why no permission guards a mutation that does not exist.
 */
@ApiTags('plans')
@Controller('plans')
export class PlansController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get()
  @Public()
  @ApiOperation({
    summary: 'The plan catalogue',
    description:
      'Requires no authentication — the public pricing page reads it. Returns ' +
      'only catalogue data; nothing about any organization.',
  })
  async list(): Promise<PlanView[]> {
    return this.subscriptions.listPlans();
  }
}

/**
 * An organization's own subscription.
 *
 * Everything here is tenant-scoped by the Prisma extension, so there is no id
 * parameter to tamper with: the organization comes from the token.
 */
@ApiTags('subscriptions')
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(
    private readonly subscriptions: SubscriptionsService,
    private readonly entitlements: EntitlementsService,
  ) {}

  @Get('current')
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_VIEW)
  @ApiOperation({ summary: 'The signed-in organization’s subscription' })
  async current(): Promise<SubscriptionView> {
    return this.subscriptions.current();
  }

  /**
   * What this organization is entitled to, and why.
   *
   * A SEPARATE endpoint from `current` rather than a change to it, because the
   * two answer different questions and one of them has no answer for CRAVION:
   * the platform organization has no subscription row, so `current` is a 404
   * there and should be — inventing one would mean fabricating a plan and a
   * period for an organization nobody bills.
   *
   * This is what a client should read to decide whether to show price, trial
   * countdown or upgrade prompt. It answers for both kinds of organization.
   */
  @Get('entitlement')
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_VIEW)
  @ApiOperation({
    summary: 'Entitlement — subscription-derived, or platform-internal',
    description:
      'Customers are entitled by their subscription. The CRAVION platform ' +
      'organization is entitled because it operates the platform: no plan, no ' +
      'period, no payment, and billable=false. A client must not present that ' +
      'as "paid".',
  })
  async entitlement(): Promise<EntitlementView> {
    return this.entitlements.current(this.subscriptions);
  }

  @Patch('current')
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_MANAGE)
  @ApiOperation({
    summary: 'Change plan or billing interval',
    description:
      'Cannot change status. A client asserting it is ACTIVE would be asserting ' +
      'that it has paid, which only a payment provider can know — sending a ' +
      '`status` field is rejected outright rather than ignored.',
  })
  async changePlan(
    @Body() dto: ChangePlanDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<SubscriptionView> {
    return this.subscriptions.changePlan(
      { planCode: dto.planCode, billingInterval: dto.billingInterval },
      principal,
    );
  }
}
