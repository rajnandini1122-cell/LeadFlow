import { Global, Module } from '@nestjs/common';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { InvitationsRepository } from './invitations.repository';

/**
 * Global because UsersController exposes the tenant-scoped management side
 * (list, resend, revoke) while this module owns the public redemption side.
 */
@Global()
@Module({
  controllers: [InvitationsController],
  providers: [InvitationsService, InvitationsRepository],
  exports: [InvitationsService],
})
export class InvitationsModule {}
