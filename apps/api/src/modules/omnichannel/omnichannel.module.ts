import { Module } from '@nestjs/common';
import { ConversationLinkingService } from './conversation-linking.service';
import { ConversationReviewService } from './conversation-review.service';
import { ConversationsController } from './conversations.controller';
import { IdentityResolutionService } from './identity-resolution.service';
import { IngestionService } from './ingestion.service';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { OmnichannelRepository } from './omnichannel.repository';
import { OutboundMessagingService } from './outbound-messaging.service';
import { OutboundRecoveryService } from './outbound-recovery.service';
import { WhatsAppOutboundService } from './providers/whatsapp/whatsapp-outbound.service';
import { WhatsAppIntegrationRepository } from './providers/whatsapp/whatsapp-integration.repository';
import { WhatsAppSetupService } from './providers/whatsapp/whatsapp-setup.service';
import { WhatsAppWebhookController } from './providers/whatsapp/whatsapp-webhook.controller';
import { WhatsAppWebhookService } from './providers/whatsapp/whatsapp-webhook.service';

/**
 * Omnichannel capture.
 *
 * Note what this module does NOT import: LeadsModule. Nothing here creates,
 * assigns or re-prices a lead, so it needs none of that surface — it reads
 * leads through its own scoped repository and writes only the association and
 * the timeline entry. Keeping the dependency out is what stops this becoming a
 * second lead service by accident.
 */
@Module({
  controllers: [ConversationsController, IntegrationsController, WhatsAppWebhookController],
  providers: [
    OmnichannelRepository,
    IdentityResolutionService,
    IngestionService,
    ConversationLinkingService,
    ConversationReviewService,
    IntegrationsService,
    WhatsAppIntegrationRepository,
    WhatsAppSetupService,
    WhatsAppWebhookService,
    WhatsAppOutboundService,
    OutboundMessagingService,
    OutboundRecoveryService,
  ],
  exports: [
    OutboundRecoveryService,
    IngestionService,
    ConversationLinkingService,
    ConversationReviewService,
    IntegrationsService,
  ],
})
export class OmnichannelModule {}
