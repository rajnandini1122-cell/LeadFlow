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
import { TemplatesController } from './templates/templates.controller';
import { TemplatesRepository } from './templates/templates.repository';
import { TemplatesService } from './templates/templates.service';

/**
 * Email campaigns: the organization's mailbox, marketing eligibility, the
 * campaign composer, the delivery queue and reply tracking.
 * See docs/email/LEADFLOW_EMAIL_ARCHITECTURE.md.
 */
@Module({
  controllers: [MailboxController, ConsentController, UnsubscribeController, TemplatesController],
  providers: [
    MailboxService,
    MailboxRepository,
    ConsentService,
    ConsentRepository,
    UnsubscribeRepository,
    TemplatesService,
    TemplatesRepository,
    AuditRepository,
  ],
  exports: [MailboxService, ConsentRepository, TemplatesService],
})
export class CampaignsModule {}
