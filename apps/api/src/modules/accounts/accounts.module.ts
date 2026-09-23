import { Module } from '@nestjs/common';
import { LeadsModule } from '../leads/leads.module';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { AccountsRepository } from './accounts.repository';
import { Account360Service } from './account-360.service';
import { Account360Repository } from './account-360.repository';
import { AccountKpiService } from './account-kpi.service';
import { AccountKpiRepository } from './account-kpi.repository';
import { AccountLifecycleService } from './account-lifecycle.service';
import { AccountLifecycleRepository } from './account-lifecycle.repository';
import { AccountMappingService } from './account-mapping.service';
import { AccountMappingRepository } from './account-mapping.repository';
import { RetentionService } from './retention.service';
import { RetentionRepository } from './retention.repository';
import { FollowUpsModule } from '../follow-ups/follow-ups.module';

/**
 * Customers, Customer 360, and the relationship lifecycle.
 *
 * Imports LeadsModule for the organization's timezone that date-bucketing
 * needs — the same dependency reports and products already take, for the same
 * reason. Nothing here reimplements lead visibility or lead access.
 *
 * `AccountsRepository` and `AccountLifecycleService` are exported so the leads
 * module can validate an account id through the SAME tenant-scoped query, and
 * promote a customer when a deal is won. That export is what closes the gap the
 * Prisma extension cannot: the extension scopes QUERIES, but a foreign key
 * assignment is not a query, so attaching an account to a lead has to be
 * validated explicitly.
 */
@Module({
  /*
   * FollowUpsModule for customer-level follow-ups, and LeadsModule for lead
   * creation — the repeat-business workflow delegates to LeadsService rather
   * than writing its own insert, so a repeat opportunity is an ORDINARY lead
   * with the same validation, timeline and follow-up rule as any other.
   */
  imports: [LeadsModule, FollowUpsModule],
  controllers: [AccountsController],
  providers: [
    AccountsService,
    AccountsRepository,
    Account360Service,
    Account360Repository,
    AccountKpiService,
    AccountKpiRepository,
    AccountLifecycleService,
    AccountLifecycleRepository,
    AccountMappingService,
    AccountMappingRepository,
    RetentionService,
    RetentionRepository,
  ],
  exports: [AccountsRepository, AccountLifecycleService],
})
export class AccountsModule {}
