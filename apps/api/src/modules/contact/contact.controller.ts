import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { ContactService, type EnquiryReceipt } from './contact.service';
import { SubmitEnquiryDto } from './dto/contact.dto';

/**
 * The public contact form.
 *
 * There is deliberately no route to READ enquiries. Doing so would need a
 * platform-administrator concept that does not exist yet, and the alternative —
 * exposing them to organization admins — would show every tenant everybody
 * else's sales conversations. Until that exists, enquiries are read from the
 * sales inbox and the database.
 */
@ApiTags('contact')
@Controller('contact')
export class ContactController {
  constructor(private readonly contact: ContactService) {}

  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  /*
   * Far stricter than the global limit, and per IP.
   *
   * This endpoint sends mail on behalf of an anonymous caller, which makes it
   * the most attractive thing in the API to abuse. Five submissions an hour is
   * generous for a person and useless for a spammer.
   */
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @ApiOperation({
    summary: 'Send a message to the sales team',
    description:
      'Public. The enquiry is stored and then emailed, in that order, so a mail ' +
      'provider failure loses the notification rather than the enquiry. The ' +
      'destination address comes from configuration and can never be supplied ' +
      'by the caller.',
  })
  async submit(
    @Body() dto: SubmitEnquiryDto,
    @Req() request: Request,
  ): Promise<EnquiryReceipt> {
    return this.contact.submit(dto, {
      ipAddress: request.ip,
      userAgent: request.get('user-agent'),
    });
  }
}
