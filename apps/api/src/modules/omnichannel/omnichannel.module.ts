import { Module } from '@nestjs/common';
import { ConversationLinkingService } from './conversation-linking.service';
import { ConversationsController } from './conversations.controller';
import { IdentityResolutionService } from './identity-resolution.service';
import { IngestionService } from './ingestion.service';
import { OmnichannelRepository } from './omnichannel.repository';

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
  controllers: [ConversationsController],
  providers: [
    OmnichannelRepository,
    IdentityResolutionService,
    IngestionService,
    ConversationLinkingService,
  ],
  exports: [IngestionService, ConversationLinkingService],
})
export class OmnichannelModule {}
