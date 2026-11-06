import { createHmac } from 'node:crypto';
import { Body, Controller, Headers, HttpCode, HttpStatus, Logger, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { AppConfig } from '../../common/config/config.module';
import { Public } from '../auth/decorators/public.decorator';
import { analyticsDay } from './analytics-time';
import { PlatformAnalyticsRepository } from './platform-analytics.repository';
import {
  WEB_EVENTS,
  classifySource,
  isBot,
  measuredPath,
  referrerDomain,
  type WebEvent,
} from './web-analytics';

export class CollectWebEventDto {
  @IsIn(WEB_EVENTS)
  event!: WebEvent;

  @IsString()
  @MaxLength(300)
  path!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  referrer?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  utmSource?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  utmMedium?: string;

  /** Random id the browser keeps in localStorage. Hashed before it is stored. */
  @IsUUID()
  visitorId!: string;

  /** Random id for this visit (30 minutes of inactivity starts a new one). */
  @IsUUID()
  sessionId!: string;
}

/**
 * First-party analytics for the PUBLIC LeadFlow website.
 *
 * Privacy: no IP address and no user agent are stored, no cookie is set, the
 * browser's ids are stored only as keyed hashes, only a closed list of public
 * paths is accepted, and only the referrer's host is kept. The web app sends
 * nothing under Do Not Track or Global Privacy Control, and never from the
 * signed-in CRM. Always answers 204 so it reveals nothing.
 */
@ApiTags('analytics')
@Controller('analytics')
export class WebAnalyticsController {
  private readonly logger = new Logger(WebAnalyticsController.name);
  private readonly hashKey: Buffer;
  private readonly ownHost: string;

  constructor(
    private readonly repository: PlatformAnalyticsRepository,
    private readonly config: AppConfig,
  ) {
    // Derived from a server secret, so a hash cannot be reversed by guessing ids.
    this.hashKey = createHmac('sha256', config.get('JWT_ACCESS_SECRET'))
      .update('leadflow web analytics v1')
      .digest();
    this.ownHost = new URL(config.get('API_BASE_URL')).hostname;
  }

  @Post('collect')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'Record a public-website page view or conversion (anonymous)' })
  async collect(
    @Body() dto: CollectWebEventDto,
    @Headers('user-agent') userAgent?: string,
  ): Promise<void> {
    if (!this.config.get('WEB_ANALYTICS_ENABLED') || isBot(userAgent)) return;
    const path = measuredPath(dto.path);
    if (!path) return;

    const domain = referrerDomain(dto.referrer, this.ownHost);
    const at = new Date();
    try {
      await this.repository.recordWebHit({
        visitorHash: this.hash(`v:${dto.visitorId}`),
        sessionHash: this.hash(`s:${dto.sessionId}`),
        day: analyticsDay(at),
        at,
        path,
        source: classifySource({
          referrerDomain: domain,
          utmSource: dto.utmSource,
          utmMedium: dto.utmMedium,
        }),
        referrerDomain: domain,
        event: dto.event,
      });
    } catch (error) {
      // Never an error to the browser: analytics must not affect the website.
      this.logger.warn({ err: error }, 'Could not record website analytics event');
    }
  }

  private hash(value: string): string {
    return createHmac('sha256', this.hashKey).update(value).digest('hex');
  }
}
