import { Module } from '@nestjs/common';
import { AuditRepository } from '../../common/audit/audit.repository';
import { TeamsModule } from '../teams/teams.module';
import { TerritoriesModule } from '../territories/territories.module';
import { AssignmentRulesController } from './assignment-rules.controller';
import { AssignmentRulesService } from './assignment-rules.service';
import { AssignmentRulesRepository } from './assignment-rules.repository';

/**
 * Assignment rules.
 *
 * Imports TeamsModule rather than reading team membership itself: who is
 * eligible is J3's judgement, stated once, and a second copy here would be the
 * first thing to disagree the next time the policy changed. TerritoriesModule
 * arrives on exactly the same terms — where a place belongs is stated once, in
 * the coverage table, and a rule never parses an address.
 *
 * Exports the service so the phase that eventually converts an intake into a
 * lead can ask which team should take it — without reaching past this module
 * into the rules table.
 */
@Module({
  imports: [TeamsModule, TerritoriesModule],
  controllers: [AssignmentRulesController],
  providers: [AssignmentRulesService, AssignmentRulesRepository, AuditRepository],
  exports: [AssignmentRulesService],
})
export class AssignmentRulesModule {}
