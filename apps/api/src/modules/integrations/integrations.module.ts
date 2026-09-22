import { Module } from '@nestjs/common';
import { AuditRepository } from '../../common/audit/audit.repository';
import { WebsiteIntakeController } from './website/website-intake.controller';
import { WebsiteIntakeService } from './website/website-intake.service';
import { WebsiteIntakeRepository } from './website/website-intake.repository';

/**
 * Inbound integration boundaries.
 *
 * One module for traffic that arrives from an approved system rather than from
 * a person: no session, no bearer token, authenticity proved cryptographically
 * and the tenant decided by configuration. The omnichannel webhooks are the
 * same shape and live in their own module for historical reasons; a second
 * integration belongs here rather than inside whichever business module it
 * happens to feed.
 */
@Module({
  controllers: [WebsiteIntakeController],
  providers: [WebsiteIntakeService, WebsiteIntakeRepository, AuditRepository],
  exports: [WebsiteIntakeService],
})
export class IntegrationsModule {}
