import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CredentialThrottle } from '../../common/throttler/credential-throttle.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { InvitationsService, type InvitationPreview } from './invitations.service';
import { AcceptInvitationDto } from './dto/invitations.dto';

/**
 * PUBLIC invitation redemption.
 *
 * Deliberately unauthenticated: the recipient has no account yet, and requiring
 * a session to accept an invitation would be circular. Possession of the token
 * IS the authorisation, which is why the token is 256 bits, stored only as a
 * hash, single-use and time-limited.
 *
 * Governed by the strict credential limiter — marked on the whole controller,
 * since both routes take the token — because an unauthenticated endpoint that
 * accepts a secret is a brute-force target, exactly like a login.
 */
@ApiTags('invitations')
@CredentialThrottle()
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Public()
  @Get(':token')
  @ApiOperation({
    summary: 'Preview an invitation',
    description:
      'Returns the organization name and invited role so the recipient knows ' +
      'what they are joining. Deliberately excludes the organization id and any ' +
      'other tenant data, because the link may be forwarded.',
  })
  async preview(@Param('token') token: string): Promise<InvitationPreview> {
    return this.invitations.preview(token);
  }

  @Public()
  @Post(':token/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept an invitation',
    description:
      'Single-use. Returns 410 Gone if the link was already accepted, revoked, ' +
      'superseded by a resend, or expired.',
  })
  async accept(@Param('token') token: string, @Body() dto: AcceptInvitationDto) {
    const result = await this.invitations.accept(token, dto);

    // Deliberately does NOT sign the user in. Requiring an explicit login means
    // the new password is exercised once immediately, and it keeps this public
    // endpoint from ever minting a session.
    return {
      accepted: true,
      email: result.email,
      role: result.role,
    };
  }
}
