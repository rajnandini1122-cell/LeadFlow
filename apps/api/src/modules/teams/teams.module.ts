import { Module } from '@nestjs/common';
import { AuditRepository } from '../../common/audit/audit.repository';
import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';
import { TeamsRepository } from './teams.repository';

/**
 * Sales teams: the organizational structure future assignment rules read.
 *
 * Exports the service so the assignment phase can ask who is available
 * without reaching into the repository — and so there stays exactly one
 * definition of what an eligible agent is.
 */
@Module({
  controllers: [TeamsController],
  providers: [TeamsService, TeamsRepository, AuditRepository],
  exports: [TeamsService],
})
export class TeamsModule {}
