import { Module } from '@nestjs/common';
import { AuditRepository } from '../../common/audit/audit.repository';
import { TerritoriesController } from './territories.controller';
import { TerritoriesService } from './territories.service';
import { TerritoriesRepository } from './territories.repository';

/**
 * Territories.
 *
 * Exports the service so the assignment phase can turn geography into a
 * territory id before it evaluates anything — and so there stays exactly one
 * definition of where a place belongs. A second copy of the specificity order
 * would be the first thing to disagree.
 */
@Module({
  controllers: [TerritoriesController],
  providers: [TerritoriesService, TerritoriesRepository, AuditRepository],
  exports: [TerritoriesService],
})
export class TerritoriesModule {}
