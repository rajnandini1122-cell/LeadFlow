import { Module, forwardRef } from '@nestjs/common';
import { FollowUpsController } from './follow-ups.controller';
import { FollowUpsService } from './follow-ups.service';
import { FollowUpsRepository } from './follow-ups.repository';
import { LeadsModule } from '../leads/leads.module';

/**
 * `forwardRef` because leads and follow-ups genuinely reference each other:
 * creating a follow-up lives on the lead's URL, while completing one can change
 * the lead's status. Splitting them into a third module to break the cycle
 * would move code away from the concept it belongs to for no benefit.
 */
@Module({
  imports: [forwardRef(() => LeadsModule)],
  controllers: [FollowUpsController],
  providers: [FollowUpsService, FollowUpsRepository],
  exports: [FollowUpsService, FollowUpsRepository],
})
export class FollowUpsModule {}
