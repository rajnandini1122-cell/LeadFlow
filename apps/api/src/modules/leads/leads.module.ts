import { Module } from '@nestjs/common';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { LeadsRepository } from './leads.repository';
import { LeadMutationsService } from './lead-mutations.service';
import { LeadImportService } from './import/lead-import.service';
import { forwardRef } from '@nestjs/common';
import { FollowUpsModule } from '../follow-ups/follow-ups.module';
import { ContactsModule } from '../contacts/contacts.module';

@Module({
  imports: [forwardRef(() => FollowUpsModule), ContactsModule],
  controllers: [LeadsController],
  providers: [LeadsService, LeadMutationsService, LeadImportService, LeadsRepository],
  exports: [LeadsService, LeadMutationsService, LeadsRepository],
})
export class LeadsModule {}
