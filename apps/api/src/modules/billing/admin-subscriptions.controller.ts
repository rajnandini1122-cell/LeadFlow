import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { Request } from 'express';
import { ENTITLEMENT_STATES, ERROR_CODES } from '@leadflow/api-types';
import { AppConfig } from '../../common/config/config.module';
import { AppException } from '../../common/errors/app.exception';
import { RedisService } from '../../common/redis/redis.service';
import { Public } from '../auth/decorators/public.decorator';
import {
  REPLAY_WINDOW_SECONDS,
  verifyAdminSignature,
} from '../integrations/admin-control/admin-control-signature';
import { ADMIN_ACTIONS, AdminSubscriptionsService, type AdminAction } from './admin-subscriptions.service';

class OrganizationsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsIn(ENTITLEMENT_STATES)
  state?: string;
}

export class AdminActionDto {
  @IsIn(ADMIN_ACTIONS)
  action!: AdminAction;

  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  days?: number;

  @IsOptional()
  @IsISO8601()
  until?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  planCode?: string;

  @IsOptional()
  @IsIn(['GRANDFATHERED', 'PENDING_REVIEW'])
  decision?: 'GRANDFATHERED' | 'PENDING_REVIEW';

  @IsOptional()
  @IsBoolean()
  exempt?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  confirm?: string;

  @IsOptional()
  @IsUUID()
  paymentId?: string;
}

type Headers0 = Record<string, string | string[] | undefined>;

/**
 * Subscription management for the CRAVION Admin panel, server to server.
 *
 * Its OWN signing secret (ADMIN_SUBSCRIPTIONS_SIGNING_SECRET), never the
 * analytics one: the analytics key stays read-only. Same scheme as the other
 * admin integrations — method, path with query, timestamp, request id, actor
 * and body digest under HMAC, a timestamp window, and each request id accepted
 * once. 404 unless ADMIN_SUBSCRIPTIONS_ENABLED.
 */
@Controller('integrations/admin-subscriptions')
@Public()
@ApiExcludeController()
@Throttle({ default: { limit: 120, ttl: 60_000 } })
export class AdminSubscriptionsController {
  private readonly logger = new Logger(AdminSubscriptionsController.name);

  constructor(
    private readonly service: AdminSubscriptionsService,
    private readonly config: AppConfig,
    private readonly redis: RedisService,
  ) {}

  @Get('overview')
  async overview(@Req() request: RawBodyRequest<Request>, @Headers() headers: Headers0) {
    await this.authorise(request, headers);
    return this.service.overview();
  }

  @Get('organizations')
  async organizations(@Req() request: RawBodyRequest<Request>, @Headers() headers: Headers0, @Query() query: OrganizationsQueryDto) {
    await this.authorise(request, headers);
    return this.service.organizations({ search: query.search, state: query.state });
  }

  @Get('organizations/:id')
  async organization(@Req() request: RawBodyRequest<Request>, @Headers() headers: Headers0, @Param('id', ParseUUIDPipe) id: string) {
    await this.authorise(request, headers);
    return this.service.organization(id);
  }

  @Post('organizations/:id/actions')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async act(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Headers0,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminActionDto,
  ) {
    const actor = await this.authorise(request, headers);
    return this.service.act(id, dto, actor);
  }

  private async authorise(request: RawBodyRequest<Request>, headers: Headers0): Promise<string> {
    if (!this.config.get('ADMIN_SUBSCRIPTIONS_ENABLED')) throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Not found.');
    const actorRef = header(headers, 'x-cravion-admin-actor');
    const requestId = header(headers, 'x-cravion-admin-request-id');
    const result = verifyAdminSignature({
      method: request.method,
      path: request.originalUrl,
      rawBody: request.rawBody,
      signatureHeader: header(headers, 'x-cravion-admin-signature'),
      timestampHeader: header(headers, 'x-cravion-admin-timestamp'),
      requestId,
      actorRef,
      secret: this.config.get('ADMIN_SUBSCRIPTIONS_SIGNING_SECRET'),
    });
    if (!result.valid || !actorRef) {
      this.logger.warn({ reason: result.valid ? 'NO_ACTOR' : result.reason }, 'Rejected admin subscriptions request');
      throw AppException.unauthorized('This request could not be authenticated.');
    }
    const claimed = await this.redis.claimOnce(`leadflow:admin-subscriptions:request:${requestId}`, 2 * REPLAY_WINDOW_SECONDS + 60);
    if (claimed === false) {
      this.logger.warn('Rejected a replayed admin subscriptions request');
      throw AppException.unauthorized('This request could not be authenticated.');
    }
    // Writes change entitlements: without replay protection, refuse rather than risk a replay.
    if (claimed === null) throw new ServiceUnavailableException('Replay protection is unavailable; try again shortly.');
    return actorRef;
  }
}

function header(headers: Headers0, name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}
