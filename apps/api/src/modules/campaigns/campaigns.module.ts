import { Module } from '@nestjs/common';
import { AuditRepository } from '../../common/audit/audit.repository';
import { MailboxController } from './mailbox/mailbox.controller';
import { MailboxRepository } from './mailbox/mailbox.repository';
import { MailboxService } from './mailbox/mailbox.service';
import { ConsentController } from './consent/consent.controller';
import { ConsentRepository } from './consent/consent.repository';
import { ConsentService } from './consent/consent.service';
import { UnsubscribeController } from './consent/unsubscribe.controller';
import { UnsubscribeRepository } from './consent/unsubscribe.repository';
import { BillingModule } from '../billing/billing.module';
import { AudienceRepository } from './campaigns/audience.repository';
import { CampaignsController } from './campaigns/campaigns.controller';
import { CampaignsRepository } from './campaigns/campaigns.repository';
import { CampaignsService } from './campaigns/campaigns.service';
import { DispatchRepository } from './dispatch/dispatch.repository';
import { EmailDispatcher } from './dispatch/email-dispatcher.service';
import { TemplatesController } from './templates/templates.controller';
import { TemplatesRepository } from './templates/templates.repository';
import { TemplatesService } from './templates/templates.service';

/**
 * Email campaigns: the organization's mailbox, marketing eligibility, the
 * campaign composer, the delivery queue and reply tracking.
 * See docs/email/LEADFLOW_EMAIL_ARCHITECTURE.md.
 */
@Module({
  imports: [BillingModule],
  controllers: [
    CampaignsController,
    MailboxController,
    ConsentController,
    UnsubscribeController,
    TemplatesController,
  ],
  providers: [
    MailboxService,
    MailboxRepository,
    ConsentService,
    ConsentRepository,
    UnsubscribeRepository,
    TemplatesService,
    TemplatesRepository,
    CampaignsService,
    CampaignsRepository,
    AudienceRepository,
    DispatchRepository,
    EmailDispatcher,
    AuditRepository,
  ],
  exports: [MailboxService, ConsentRepository, TemplatesService, EmailDispatcher],
})
export class CampaignsModule {}
