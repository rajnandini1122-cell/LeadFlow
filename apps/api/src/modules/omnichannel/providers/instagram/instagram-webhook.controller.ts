import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../../auth/decorators/public.decorator';
import { InstagramWebhookService } from './instagram-webhook.service';

/**
 * Meta's Instagram delivery endpoint.
 *
 * A separate route from the WhatsApp one because Meta configures a callback URL
 * per product, and because the two payloads share nothing but their envelope.
 * They do share the security: the same HMAC verification, the same fail-closed
 * behaviour, the same refusal to read a payload before it is proven genuine.
 *
 * Public in the sense that no LeadFlow session is involved — Meta has no
 * account here — but not unauthenticated.
 */
@ApiExcludeController()
@Controller('webhooks/instagram')
export class InstagramWebhookController {
  constructor(private readonly webhooks: InstagramWebhookService) {}

  /**
   * The subscription handshake, performed once when the URL is saved at Meta.
   *
   * A wrong or missing token is a bare 403. Anything more helpful would let
   * someone confirm what the endpoint is and probe the token.
   */
  @Get()
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  verify(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ): string {
    const result = this.webhooks.verifySubscription({ mode, token, challenge });
    if (result === null) throw new ForbiddenException();

    return result;
  }

  /**
   * Inbound events.
   *
   * Always 200 once the signature checks out, whatever happened afterwards.
   * Meta retries any non-2xx for hours, so returning an error for a message
   * deliberately ignored — an unknown account, a disabled integration — would
   * produce an endless loop over something that will never succeed. An invalid
   * signature is the exception: that IS a rejection.
   *
   * The response body is empty on purpose. Meta ignores it, and anything
   * describing what happened would tell an unauthenticated caller whether a
   * given Instagram account is connected here.
   */
  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Body() body: unknown,
  ): Promise<void> {
    const outcome = await this.webhooks.handle(request.rawBody, signature, body);

    if (outcome.status === 'REJECTED') throw new ForbiddenException();
  }
}
