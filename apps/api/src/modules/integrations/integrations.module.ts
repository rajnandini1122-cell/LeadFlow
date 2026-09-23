import { Module } from '@nestjs/common';
import { AuditRepository } from '../../common/audit/audit.repository';
import { WebsiteIntakeController } from './website/website-intake.controller';
import { WebsiteIntakeService } from './website/website-intake.service';
import { WebsiteIntakeRepository } from './website/website-intake.repository';
import { IntakeProcessingModule } from './intake-processing/intake-processing.module';
import { AdminControlModule } from './admin-control/admin-control.module';

/**
 * Inbound integration boundaries.
 *
 * One module for traffic that arrives from an approved system rather than from
 * a person: no session, no bearer token, authenticity proved cryptographically
 * and the tenant decided by configuration. The omnichannel webhooks are the
 * same shape and live in their own module for historical reasons; a second
 * integration belongs here rather than inside whichever business module it
 * happens to feed.
 *
 * What ARRIVES and what is DONE with it are separate modules on purpose. The
 * boundary above authenticates, stores and answers; the processing module
 * converts. A website request must not wait on the CRM pipeline, and a failure
 * in routing must not lose an enquiry that is already durable.
 *
 * The admin control plane is a THIRD boundary, and a separate trust domain from
 * the website: its own secret, its own signing contract, its own configured
 * tenant. A compromise of the public site's key must not become a way to
 * rewrite a tenant's routing table.
 */
@Module({
  imports: [IntakeProcessingModule, AdminControlModule],
  controllers: [WebsiteIntakeController],
  providers: [WebsiteIntakeService, WebsiteIntakeRepository, AuditRepository],
  exports: [WebsiteIntakeService, IntakeProcessingModule],
})
export class IntegrationsModule {}
