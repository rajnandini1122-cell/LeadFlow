import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { ApiExcludeController, ApiOperation } from '@nestjs/swagger';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { AppException } from '../../../common/errors/app.exception';
import { ERROR_CODES } from '@leadflow/api-types';
import { Public } from '../../auth/decorators/public.decorator';
import { WebsiteIntakeService, type IntakeReceipt } from './website-intake.service';
import { WebsiteIntakeDto } from './dto/website-intake.dto';

/**
 * Website submissions, server to server.
 *
 * NOT a browser endpoint. There is no session and no bearer token; the caller
 * is an approved backend holding a shared secret, and it proves that by
 * signing each request. CORS, Origin, Referer, User-Agent and source IP are
 * not used for anything here — every one of them is set by whoever is calling,
 * which makes them decoration rather than authentication.
 *
 * Excluded from the API docs. It is not part of the product's public surface,
 * and publishing the header names and the signing scheme only helps somebody
 * probing an endpoint that must accept traffic from the internet.
 *
 * Rate limiting: the GENERAL policy, like any other route. Deliberately not
 * the credential one — five attempts per quarter hour is meant to make
 * password guessing expensive, and applying it to a trusted backend would
 * throttle a working integration into silence. Nor the anonymous contact
 * form's five per hour: that limit exists because anybody at all can post to
 * that form, which is not true here.
 */
@ApiExcludeController()
@Controller('integrations/website')
export class WebsiteIntakeController {
  constructor(private readonly intake: WebsiteIntakeService) {}

  /**
   * @param signature `sha256=<hex>` — HMAC of timestamp, event id and body
   * @param timestamp unix seconds, inside a five-minute window either way
   * @param eventId   the caller's own id for this submission, and the
   *                  idempotency key. Signed, so it cannot be altered in
   *                  flight, and carried in a header rather than the body so
   *                  there is exactly one place it can live.
   */
  /*
   * THROTTLING: deliberately the GENERAL policy, and deliberately not stricter.
   *
   * Examined and left alone on purpose, so the next person does not read the
   * absence of a @Throttle here as an oversight.
   *
   * Every legitimate request arrives from the approved backend's egress
   * addresses — a handful of IPs for the entire website. The throttler keys on
   * IP, so ANY stricter route-level limit is a shared bucket for every customer
   * at once: one busy afternoon, or one spam burst, and real enquiries are
   * refused collectively. That is a denial-of-service condition we would be
   * building ourselves, and it is worse than the abuse it would prevent.
   *
   * The real boundary is the signature, which this route cannot be reached
   * past: an unsigned or wrongly signed request is rejected before any work is
   * done, so the open internet cannot reach the pipeline at all. Replay is
   * bounded by the five-minute timestamp window, duplication by the unique
   * event id, and payload size by the 3 MB body cap plus per-field limits.
   *
   * Spam therefore has to come THROUGH the approved caller, which is where it
   * can be told apart from a real visitor — App Check, per-session limits and
   * bot signals all live at that layer, with the context to judge. Rate
   * limiting here cannot distinguish the two and would only choose how many
   * genuine customers to turn away.
   */
  @Post('intake')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive a submission from an approved integration' })
  async intakeEnquiry(
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-leadflow-signature') signature: string | undefined,
    @Headers('x-leadflow-timestamp') timestamp: string | undefined,
    @Headers('x-leadflow-event-id') eventId: string | undefined,
    @Body() dto: WebsiteIntakeDto,
  ): Promise<IntakeReceipt> {
    /*
     * A disabled integration is INVISIBLE, not forbidden.
     *
     * 404 is the honest answer for a route this deployment does not offer, and
     * it tells somebody scanning for integration endpoints nothing about
     * whether one exists here and is merely switched off.
     */
    if (!this.intake.enabled) {
      throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Not found.');
    }

    /*
     * Authenticity FIRST, before the body is read for anything.
     *
     * The DTO has already been validated by the global pipe, which is fine —
     * validation is not trust. What must not happen before this line is any
     * use of the payload to decide a tenant, find a customer or write a row.
     */
    this.intake.authenticate({
      rawBody: request.rawBody,
      signatureHeader: signature,
      timestampHeader: timestamp,
      eventId,
    });

    if (!eventId || eventId.trim().length === 0 || eventId.length > 120) {
      throw AppException.validation('A valid event id is required.', {
        'x-leadflow-event-id': ['must be present and at most 120 characters'],
      });
    }

    // rawBody is present: authenticate() refuses the request without it.
    return this.intake.submit({
      dto,
      rawBody: request.rawBody as Buffer,
      eventId: eventId.trim(),
    });
  }
}
