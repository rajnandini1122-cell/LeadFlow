import { Module } from '@nestjs/common';
import { PlansController, SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsRepository } from './subscriptions.repository';
import { SubscriptionsService } from './subscriptions.service';
import { EntitlementsService } from './entitlements.service';
import { OrganizationTypeRepository } from './organization-type.repository';

@Module({
  controllers: [PlansController, SubscriptionsController],
  providers: [
    SubscriptionsService,
    SubscriptionsRepository,
    EntitlementsService,
    OrganizationTypeRepository,
  ],
  // EntitlementsService and OrganizationTypeRepository are exported because the
  // platform-admin surface needs both: one to report an organization's
  // entitlement, the other to recognise CRAVION's own organization.
  exports: [SubscriptionsService, EntitlementsService, OrganizationTypeRepository],
})
export class SubscriptionsModule {}
