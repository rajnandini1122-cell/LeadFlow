import { Module } from '@nestjs/common';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { LeadsRepository } from './leads.repository';

@Module({
  controllers: [LeadsController],
  providers: [LeadsService, LeadsRepository],
  exports: [LeadsService],
})
export class LeadsModule {}
