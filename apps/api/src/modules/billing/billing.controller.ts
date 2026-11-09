import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { IsIn, IsString, Matches, MaxLength } from 'class-validator';
import {
  ERROR_CODES,
  PERMISSIONS,
  type BillingInterval,
  type BillingPaymentView,
  type BillingSummaryView,
  type CheckoutOrderView,
} from '@leadflow/api-types';
import { AppConfig } from '../../common/config/config.module';
import { AppException } from '../../common/errors/app.exception';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { BillingRepository } from './billing.repository';
import { BillingService, type WebhookBody } from './billing.service';
import { webhookSignatureValid } from './razorpay.client';

export class CheckoutDto {
  @IsIn(['MONTHLY', 'YEARLY', 'LIFETIME'])
  interval!: BillingInterval;
}

export class VerifyPaymentDto {
  @IsString()
  @Matches(/^order_[A-Za-z0-9]{6,40}$/)
  razorpay_order_id!: string;

  @IsString()
  @Matches(/^pay_[A-Za-z0-9]{6,40}$/)
  razorpay_payment_id!: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[a-f0-9]{64}$/)
  razorpay_signature!: string;
}

/**
 * Billing for the signed-in organization. Reachable after the trial or paid
 * period has ended (see OPEN_AFTER_EXPIRY): paying is how access returns.
 */
@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly repository: BillingRepository,
  ) {}

  @Get('summary')
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_VIEW)
  @ApiOperation({ summary: 'Subscription status, days remaining, plans with GST, payment history' })
  summary(@CurrentUser() principal: TenantPrincipal): Promise<BillingSummaryView> {
    return this.billing.summary(principal);
  }

  @Post('checkout')
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_MANAGE)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Create (or reuse) a Razorpay order for a Premium plan. Amount is server-side.' })
  async checkout(
    @CurrentUser() principal: TenantPrincipal,
    @Body() dto: CheckoutDto,
  ): Promise<CheckoutOrderView> {
    const buyer = await this.repository.system('read buyer', () => this.buyer(principal.userId));
    return this.billing.checkout(principal, dto.interval, buyer);
  }

  @Post('verify')
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_MANAGE)
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Confirm a completed checkout with Razorpay; grants access only when verified' })
  verify(@CurrentUser() principal: TenantPrincipal, @Body() dto: VerifyPaymentDto): Promise<BillingPaymentView> {
    return this.billing.verifyCheckout(principal, {
      orderId: dto.razorpay_order_id,
      paymentId: dto.razorpay_payment_id,
      signature: dto.razorpay_signature,
    });
  }

  private async buyer(userId: string): Promise<{ name: string; email: string }> {
    const user = await this.repository.user(userId);
    return { name: user?.fullName ?? '', email: user?.email ?? '' };
  }
}

/**
 * The LeadFlow Razorpay webhook (a webhook of its own in the Razorpay
 * Dashboard, with its own secret; CRAVION's store webhook is separate and
 * ignores LeadFlow orders). Signature over the RAW body; each event id is
 * processed once; events for orders LeadFlow did not create are acknowledged
 * and ignored. 404 until RAZORPAY_WEBHOOK_SECRET is configured.
 */
@Controller('billing/razorpay')
export class RazorpayWebhookController {
  private readonly logger = new Logger(RazorpayWebhookController.name);

  constructor(
    private readonly billing: BillingService,
    private readonly config: AppConfig,
  ) {}

  @Post('webhook')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  async webhook(
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-razorpay-signature') signature: string | undefined,
    @Headers('x-razorpay-event-id') eventId: string | undefined,
    @Body() body: WebhookBody,
  ): Promise<{ received: string }> {
    const secret = this.config.get('RAZORPAY_WEBHOOK_SECRET');
    if (!secret) throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Not found.');
    if (!request.rawBody || !signature || !webhookSignatureValid(request.rawBody, signature, secret)) {
      this.logger.warn('Rejected a Razorpay webhook with a missing or invalid signature');
      throw AppException.unauthorized('Invalid signature.');
    }
    if (!eventId || !/^[A-Za-z0-9_-]{6,80}$/.test(eventId) || typeof body?.event !== 'string') {
      throw AppException.validation('Malformed event.');
    }
    return { received: await this.billing.handleWebhook(eventId, body) };
  }
}
