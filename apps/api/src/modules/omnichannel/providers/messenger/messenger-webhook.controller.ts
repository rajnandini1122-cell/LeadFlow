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
import { MessengerWebhookService } from './messenger-webhook.service';
import {
  FACEBOOK_CHANNEL,
  INSTAGRAM_CHANNEL,
  type MessengerChannelConfig,
} from './messenger-channels';

/**
 * Meta's delivery endpoints for the Messenger-protocol channels.
 *
 * Two routes, because Meta configures a callback URL per product and each
 * product has its own app secret and verify token. One implementation, because
 * everything either does with a delivery is identical — and two copies of a
 * security check do not stay identical.
 *
 * Public in the sense that no LeadFlow session is involved — Meta has no
 * account here — but not unauthenticated: every POST is rejected unless its
 * HMAC matches, which is a stronger guarantee than a bearer token that could be
 * replayed from a log.
 */
abstract class MessengerWebhookController {
  protected abstract readonly channel: MessengerChannelConfig;

  /*
   * Each concrete controller declares its own constructor and calls super().
   *
   * Not redundant: TypeScript emits `design:paramtypes` only for a class that
   * declares a constructor, and Nest resolves dependencies from that metadata.
   * A subclass relying on the base constructor is instantiated with nothing
   * injected, and the failure surfaces as a 500 on the first request rather
   * than at startup.
   */
  protected constructor(protected readonly webhooks: MessengerWebhookService) {}

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
    const result = this.webhooks.verifySubscription(this.channel, { mode, token, challenge });
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
   * given account is connected here.
   */
  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Body() body: unknown,
  ): Promise<void> {
    const outcome = await this.webhooks.handle(
      this.channel,
      request.rawBody,
      signature,
      body,
    );

    if (outcome.status === 'REJECTED') throw new ForbiddenException();
  }
}

@ApiExcludeController()
@Controller('webhooks/instagram')
export class InstagramWebhookController extends MessengerWebhookController {
  protected readonly channel = INSTAGRAM_CHANNEL;

  constructor(webhooks: MessengerWebhookService) {
    super(webhooks);
  }
}

@ApiExcludeController()
@Controller('webhooks/facebook')
export class FacebookWebhookController extends MessengerWebhookController {
  protected readonly channel = FACEBOOK_CHANNEL;

  constructor(webhooks: MessengerWebhookService) {
    super(webhooks);
  }
}
