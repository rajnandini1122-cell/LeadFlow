import { Module } from '@nestjs/common';
import { AuditRepository } from '../../common/audit/audit.repository';
import { MailboxController } from './mailbox/mailbox.controller';
import { MailboxRepository } from './mailbox/mailbox.repository';
import { MailboxService } from './mailbox/mailbox.service';

/**
 * Email campaigns: the organization's mailbox, marketing eligibility, the
 * campaign composer, the delivery queue and reply tracking.
 * See docs/email/LEADFLOW_EMAIL_ARCHITECTURE.md.
 */
@Module({
  controllers: [MailboxController],
  providers: [MailboxService, MailboxRepository, AuditRepository],
  exports: [MailboxService],
})
export class CampaignsModule {}
