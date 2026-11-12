import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../../auth/decorators/public.decorator';
import { ProviderEventsService, type ResendEvent } from './provider-events.service';

/**
 * Resend email events for one organization's mailbox.
 *
 * Public (Resend has no session), so nothing here is trusted until the Svix
 * signature over the RAW body verifies with that mailbox's own secret. The
 * mailbox id in the path only selects which secret to check with.
 */
@Controller('webhooks/email/resend')
export class ProviderEventsController {
  constructor(private readonly events: ProviderEventsService) {}

  @Post(':mailboxId')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  async resend(
    @Param('mailboxId', ParseUUIDPipe) mailboxId: string,
    @Req() request: RawBodyRequest<Request>,
    @Headers('svix-id') id: string | undefined,
    @Headers('svix-timestamp') timestamp: string | undefined,
    @Headers('svix-signature') signature: string | undefined,
    @Body() body: ResendEvent,
  ): Promise<{ applied: boolean }> {
    return this.events.handleResend(
      mailboxId,
      {
        ...(id ? { id } : {}),
        ...(timestamp ? { timestamp } : {}),
        ...(signature ? { signature } : {}),
      },
      request.rawBody,
      body,
    );
  }
}
