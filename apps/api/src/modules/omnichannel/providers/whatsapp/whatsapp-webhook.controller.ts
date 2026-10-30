import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Header,
  Headers,
  Post,
  Query,
  Req,
  ForbiddenException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../../auth/decorators/public.decorator';
import { raw, type RawResponse } from '../../../../common/interceptors/response-envelope.interceptor';
import { WhatsAppWebhookService } from './whatsapp-webhook.service';

/**
 * Meta's delivery endpoint.
 *
 * Public in the sense that no LeadFlow session is involved — Meta has no
 * account here — but not unauthenticated: every POST is rejected unless its
 * HMAC signature matches, which is a stronger guarantee than a bearer token
 * that could be replayed from a log.
 *
 * Excluded from the API docs. It is not part of the product's API surface, and
 * publishing it invites probing of an endpoint that must accept traffic from
 * the public internet.
 */
@ApiExcludeController()
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  constructor(private readonly webhooks: WhatsAppWebhookService) {}

  /**
   * The subscription handshake, performed once when the URL is saved in Meta.
   *
   * A wrong or missing token is a flat 403 with no detail. Anything more
   * helpful would let someone confirm what the endpoint is and probe the token.
   */
  @Get()
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Header('Content-Type', 'text/plain; charset=utf-8')
  verify(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ): RawResponse<string> {
    const result = this.webhooks.verifySubscription({ mode, token, challenge });
    if (result === null) throw new ForbiddenException();

    // Meta compares the WHOLE response body with the challenge. Returned as a
    // plain value, the global envelope turned it into
    // {"success":true,"data":"<challenge>",...} and Meta's "Verify and save"
    // failed even with the right token (found 2026-10-30, before WhatsApp was
    // ever configured in production). raw() bypasses the envelope.
    return raw(result);
  }

  /**
   * Inbound events.
   *
   * Always 200 once the signature checks out, whatever happened afterwards.
   * Meta retries any non-2xx for hours, so returning an error for a message we
   * have deliberately ignored — an unknown number, a disabled integration —
   * would produce an endless redelivery loop over something that will never
   * succeed. An invalid signature is the exception: that IS a rejection, and
   * saying so is correct.
   *
   * The response body is deliberately empty. Meta ignores it, and anything
   * describing what happened would tell an unauthenticated caller whether a
   * given phone number id is connected here.
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
