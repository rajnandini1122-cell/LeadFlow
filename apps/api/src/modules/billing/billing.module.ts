import { Module } from '@nestjs/common';
import { EmailModule } from '../../common/email/email.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminSubscriptionsController } from './admin-subscriptions.controller';
import { AdminSubscriptionsService } from './admin-subscriptions.service';
import { BillingController, RazorpayWebhookController } from './billing.controller';
import { BillingNotifier } from './billing-notifier.service';
import { BillingRepository } from './billing.repository';
import { BillingService } from './billing.service';
import { RazorpayClient } from './razorpay.client';
import { SubscriptionGuard } from './subscription.guard';
import { SubscriptionSweeper } from './subscription-sweeper.service';

/**
 * LeadFlow billing: entitlement, Razorpay checkout and confirmation, the
 * signed CRAVION Admin subscription API, reminders and reconciliation.
 * SubscriptionGuard is exported for AppModule to register globally, after
 * authentication and permissions.
 */
@Module({
  imports: [EmailModule, NotificationsModule],
  controllers: [BillingController, RazorpayWebhookController, AdminSubscriptionsController],
  providers: [
    BillingRepository,
    BillingService,
    BillingNotifier,
    RazorpayClient,
    AdminSubscriptionsService,
    SubscriptionSweeper,
    SubscriptionGuard,
  ],
  exports: [BillingService, BillingRepository, SubscriptionGuard],
})
export class BillingModule {}
