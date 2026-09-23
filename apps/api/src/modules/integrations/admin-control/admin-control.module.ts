import { Module } from '@nestjs/common';
import { TeamsModule } from '../../teams/teams.module';
import { TerritoriesModule } from '../../territories/territories.module';
import { AssignmentRulesModule } from '../../assignment-rules/assignment-rules.module';
import { IntakeProcessingModule } from '../intake-processing/intake-processing.module';
import { AdminControlController } from './admin-control.controller';
import { AdminControlOperations } from './admin-control.operations';
import { AdminControlRepository } from './admin-control.repository';
import { AdminControlService } from './admin-control.service';

/**
 * The Central Admin control plane.
 *
 * It imports the phases it administers and adds no domain logic of its own.
 * That is the point of the module list below being exactly the existing ones:
 * a reviewer can see at a glance that there is nowhere for a second copy of a
 * business rule to live.
 *
 * Nothing is exported. The control plane is an inbound boundary; if some other
 * part of LeadFlow ever needed one of these operations it would call the domain
 * service directly, as the human-facing controllers already do.
 */
@Module({
  imports: [TeamsModule, TerritoriesModule, AssignmentRulesModule, IntakeProcessingModule],
  controllers: [AdminControlController],
  providers: [AdminControlService, AdminControlOperations, AdminControlRepository],
})
export class AdminControlModule {}
