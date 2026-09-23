import { Module } from '@nestjs/common';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { LeadsRepository } from './leads.repository';
import { LeadMutationsService } from './lead-mutations.service';
import { LeadImportService } from './import/lead-import.service';
import { forwardRef } from '@nestjs/common';
import { FollowUpsModule } from '../follow-ups/follow-ups.module';
import { ContactsModule } from '../contacts/contacts.module';
import { IntakeProcessingModule } from '../integrations/intake-processing/intake-processing.module';

@Module({
  // IntakeProcessingModule for the source panel only: a lead created from a
  // website enquiry can show the customer's own words, read through the intake
  // relation rather than copied onto the lead.
  imports: [forwardRef(() => FollowUpsModule), ContactsModule, IntakeProcessingModule],
  controllers: [LeadsController],
  providers: [LeadsService, LeadMutationsService, LeadImportService, LeadsRepository],
  exports: [LeadsService, LeadMutationsService, LeadsRepository],
})
export class LeadsModule {}
