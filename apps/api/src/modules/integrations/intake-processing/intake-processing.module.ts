import { Module } from '@nestjs/common';
import { AuditRepository } from '../../../common/audit/audit.repository';
import { ContactsRepository } from '../../contacts/contacts.repository';
import { LeadsRepository } from '../../leads/leads.repository';
import { FollowUpsRepository } from '../../follow-ups/follow-ups.repository';
import { TeamsModule } from '../../teams/teams.module';
import { TerritoriesModule } from '../../territories/territories.module';
import { AssignmentRulesModule } from '../../assignment-rules/assignment-rules.module';
import { IntakeOperationsController } from './intake-operations.controller';
import { IntakeOperationsRepository } from './intake-operations.repository';
import { IntakeOperationsService } from './intake-operations.service';
import { IntakeProcessingRepository } from './intake-processing.repository';
import { IntakeProcessingService } from './intake-processing.service';
import { IntakeSweepService } from './intake-sweep.service';

/**
 * Turning website enquiries into assigned work.
 *
 * It imports the phases it depends on rather than reimplementing them:
 * territories resolve geography, assignment rules choose the team, teams decide
 * who is eligible. This module owns exactly one new decision — WHICH of the
 * eligible people gets it — and the transaction that makes the whole thing
 * atomic.
 *
 * The repositories are provided directly rather than through their modules'
 * services because the conversion happens inside ONE transaction, and the
 * HTTP-facing services open their own. Those services also expect a human
 * principal, which a worker does not have and must not fabricate.
 *
 * Exports the sweep so the queue can drive it, and the processing service so a
 * retry can use exactly the same path a sweep does.
 */
@Module({
  imports: [TeamsModule, TerritoriesModule, AssignmentRulesModule],
  controllers: [IntakeOperationsController],
  providers: [
    IntakeProcessingService,
    IntakeProcessingRepository,
    IntakeSweepService,
    IntakeOperationsService,
    IntakeOperationsRepository,
    ContactsRepository,
    LeadsRepository,
    FollowUpsRepository,
    AuditRepository,
  ],
  exports: [IntakeProcessingService, IntakeSweepService, IntakeOperationsService],
})
export class IntakeProcessingModule {}
