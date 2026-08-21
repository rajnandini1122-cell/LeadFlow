import { Module } from '@nestjs/common';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { LeadsRepository } from './leads.repository';
import { LeadMutationsService } from './lead-mutations.service';
import { forwardRef } from '@nestjs/common';
import { FollowUpsModule } from '../follow-ups/follow-ups.module';

@Module({
  imports: [forwardRef(() => FollowUpsModule)],
  controllers: [LeadsController],
  providers: [LeadsService, LeadMutationsService, LeadsRepository],
  exports: [LeadsService, LeadMutationsService, LeadsRepository],
})
export class LeadsModule {}
