import { Module } from '@nestjs/common';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { LeadsRepository } from './leads.repository';
import { LeadMutationsService } from './lead-mutations.service';
import { LeadImportService } from './import/lead-import.service';
import { LeadImportRepository } from './import/lead-import.repository';
import { LeadLifecycleService } from './lead-lifecycle.service';
import { LeadAttachmentsController } from './attachments/lead-attachments.controller';
import { LeadAttachmentsService } from './attachments/lead-attachments.service';
import { LeadAttachmentsRepository } from './attachments/lead-attachments.repository';
import { LeadContactsController } from './contacts/lead-contacts.controller';
import { LeadContactsService } from './contacts/lead-contacts.service';
import { LeadContactsRepository } from './contacts/lead-contacts.repository';
import { LeadQualificationController } from './qualification/lead-qualification.controller';
import { LeadQualificationService } from './qualification/lead-qualification.service';
import { LeadQualificationRepository } from './qualification/lead-qualification.repository';
import { forwardRef } from '@nestjs/common';
import { FollowUpsModule } from '../follow-ups/follow-ups.module';
import { ContactsModule } from '../contacts/contacts.module';
import { IntakeProcessingModule } from '../integrations/intake-processing/intake-processing.module';

@Module({
  // IntakeProcessingModule for the source panel only: a lead created from a
  // website enquiry can show the customer's own words, read through the intake
  // relation rather than copied onto the lead.
  imports: [forwardRef(() => FollowUpsModule), ContactsModule, IntakeProcessingModule],
  controllers: [LeadsController, LeadAttachmentsController, LeadContactsController, LeadQualificationController],
  providers: [
    LeadsService,
    LeadMutationsService,
    LeadLifecycleService,
    LeadImportService,
    LeadImportRepository,
    LeadsRepository,
    LeadAttachmentsService,
    LeadAttachmentsRepository,
    LeadContactsService,
    LeadContactsRepository,
    LeadQualificationService,
    LeadQualificationRepository,
  ],
  exports: [LeadsService, LeadMutationsService, LeadLifecycleService, LeadsRepository, LeadContactsService, LeadContactsRepository],
})
export class LeadsModule {}
