import {
  Controller,
  Get,
  Headers,
  Logger,
  Query,
  Req,
  ServiceUnavailableException,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { Request } from 'express';
import { ERROR_CODES } from '@leadflow/api-types';
import { AuditRepository } from '../../common/audit/audit.repository';
import { AppConfig } from '../../common/config/config.module';
import { AppException } from '../../common/errors/app.exception';
import { Public } from '../auth/decorators/public.decorator';
import {
  REPLAY_WINDOW_SECONDS,
  verifyAdminSignature,
} from '../integrations/admin-control/admin-control-signature';
import { RedisService } from '../../common/redis/redis.service';
import { AdminAnalyticsService } from './admin-analytics.service';
import { seoStatus } from '../../common/web/seo';

export class RangeQueryDto {
  @IsOptional()
  @IsIn(['24h', '7d', '30d', 'custom'])
  range?: '24h' | '7d' | '30d' | 'custom';

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class UsersQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'INVITED', 'SUSPENDED'])
  status?: 'ACTIVE' | 'INVITED' | 'SUSPENDED';

  /**
   * Filter to one organization. Named `org`, not organizationId: the global
   * interceptor strips tenant fields from every request (anti-spoofing).
   */
  @IsOptional()
  @IsUUID()
  org?: string;

  @IsOptional()
  @IsISO8601()
  registeredFrom?: string;

  @IsOptional()
  @IsISO8601()
  registeredTo?: string;

  @IsOptional()
  @IsIn(['registered', 'lastLogin', 'lastActive', 'name'])
  sort?: 'registered' | 'lastLogin' | 'lastActive' | 'name';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  direction?: 'asc' | 'desc';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class ActivityQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(7)
  @Max(90)
  days?: number;
}

type Headers0 = Record<string, string | string[] | undefined>;

/**
 * Read-only, cross-tenant analytics for the CRAVION Admin panel.
 *
 * TRUST BOUNDARY. The browser never calls this. The CRAVION Admin backend
 * (a Firebase Function) checks that its own signed-in user is a CRAVION
 * super_admin, then signs the request with ADMIN_ANALYTICS_SIGNING_SECRET
 * (held only in that backend's secret store and in Railway). This route
 * verifies the HMAC over method, path, timestamp, request id, actor and body,
 * within the replay window, and records every read in the audit log with the
 * actor the Admin backend named.
 *
 * What a valid signature grants: these GET endpoints, nothing else. It is NOT
 * a LeadFlow login, carries no LeadFlow role, and cannot change any data. A
 * LeadFlow organization admin has no way to call it at all. Off (404) unless
 * ADMIN_ANALYTICS_ENABLED=true.
 */
@ApiExcludeController()
@Controller('integrations/admin-analytics')
@Public()
@Throttle({ default: { limit: 120, ttl: 60_000 } })
export class AdminAnalyticsController {
  private readonly logger = new Logger(AdminAnalyticsController.name);

  constructor(
    private readonly analytics: AdminAnalyticsService,
    private readonly config: AppConfig,
    private readonly audit: AuditRepository,
    private readonly redis: RedisService,
  ) {}

  @Get('overview')
  async overview(@Req() request: RawBodyRequest<Request>, @Headers() headers: Headers0) {
    await this.authorise(request, headers, 'overview', {});
    return this.analytics.overview();
  }

  @Get('users')
  async users(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Headers0,
    @Query() query: UsersQueryDto,
  ) {
    await this.authorise(request, headers, 'users', auditableUserQuery(query));
    return this.analytics.users(toUserQuery(query));
  }

  @Get('users/export')
  async usersExport(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Headers0,
    @Query() query: UsersQueryDto,
  ) {
    await this.authorise(request, headers, 'users.export', auditableUserQuery(query));
    return {
      filename: `leadflow-users-${new Date().toISOString().slice(0, 10)}.csv`,
      csv: await this.analytics.usersCsv(toUserQuery(query)),
    };
  }

  @Get('organizations')
  async organizations(@Req() request: RawBodyRequest<Request>, @Headers() headers: Headers0) {
    await this.authorise(request, headers, 'organizations', {});
    return this.analytics.organizations();
  }

  @Get('sessions')
  async sessions(@Req() request: RawBodyRequest<Request>, @Headers() headers: Headers0) {
    await this.authorise(request, headers, 'sessions', {});
    return this.analytics.sessions();
  }

  @Get('activity')
  async activity(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Headers0,
    @Query() query: ActivityQueryDto,
  ) {
    await this.authorise(request, headers, 'activity', { days: query.days ?? 30 });
    return this.analytics.activity(new Date(), query.days ?? 30);
  }

  @Get('api')
  async api(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Headers0,
    @Query() query: RangeQueryDto,
  ) {
    await this.authorise(request, headers, 'api', { ...query });
    return this.analytics.api(query);
  }

  @Get('website')
  async website(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Headers0,
    @Query() query: RangeQueryDto,
  ) {
    await this.authorise(request, headers, 'website', { ...query });
    return this.analytics.website(query);
  }

  @Get('health')
  async health(@Req() request: RawBodyRequest<Request>, @Headers() headers: Headers0) {
    await this.authorise(request, headers, 'health', {});
    return this.analytics.health();
  }

  @Get('seo')
  async seo(@Req() request: RawBodyRequest<Request>, @Headers() headers: Headers0) {
    await this.authorise(request, headers, 'seo', {});
    return seoStatus(this.config.get('API_BASE_URL'));
  }

  @Get('audit')
  async auditLog(@Req() request: RawBodyRequest<Request>, @Headers() headers: Headers0) {
    await this.authorise(request, headers, 'audit', {});
    return this.analytics.audit();
  }

  private async authorise(
    request: RawBodyRequest<Request>,
    headers: Headers0,
    view: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (!this.config.get('ADMIN_ANALYTICS_ENABLED')) {
      throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Not found.');
    }
    const actorRef = header(headers, 'x-cravion-admin-actor');
    const result = verifyAdminSignature({
      method: request.method,
      // The path WITH its query string, exactly as received: the filters are
      // part of what the CRAVION backend signed and cannot be changed in transit.
      path: request.originalUrl,
      rawBody: request.rawBody,
      signatureHeader: header(headers, 'x-cravion-admin-signature'),
      timestampHeader: header(headers, 'x-cravion-admin-timestamp'),
      requestId: header(headers, 'x-cravion-admin-request-id'),
      actorRef,
      secret: this.config.get('ADMIN_ANALYTICS_SIGNING_SECRET'),
    });
    if (!result.valid) {
      this.logger.warn({ reason: result.reason }, 'Rejected admin analytics request');
      throw AppException.unauthorized('This request could not be authenticated.');
    }
    // Replay: the signature binds the request id, and each id is accepted
    // ONCE for longer than the timestamp window in either direction. If Redis
    // cannot be asked, reads fail closed -- except Health, which falls back to
    // the timestamp window alone so an outage stays visible.
    const claimed = await this.redis.claimOnce(
      `leadflow:admin-analytics:request:${header(headers, 'x-cravion-admin-request-id')}`,
      2 * REPLAY_WINDOW_SECONDS + 60,
    );
    if (claimed === false) {
      this.logger.warn({ view }, 'Rejected a replayed admin analytics request');
      throw AppException.unauthorized('This request could not be authenticated.');
    }
    if (claimed === null && view !== 'health') {
      throw new ServiceUnavailableException('Replay protection is unavailable; try again shortly.');
    }
    await this.audit.record({
      action: `platform.analytics.${view}`,
      actorUserId: null,
      externalActorRef: actorRef ?? null,
      entityType: 'platform_analytics',
      after: params,
    });
  }
}

function header(headers: Headers0, name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

function toUserQuery(query: UsersQueryDto) {
  const pageSize = query.pageSize ?? 25;
  return {
    search: query.search?.trim() || undefined,
    status: query.status,
    organizationId: query.org,
    registeredFrom: query.registeredFrom ? new Date(query.registeredFrom) : undefined,
    registeredTo: query.registeredTo ? new Date(query.registeredTo) : undefined,
    sort: query.sort ?? 'registered',
    direction: query.direction ?? 'desc',
    skip: ((query.page ?? 1) - 1) * pageSize,
    take: pageSize,
  } as const;
}

/** What is written to the audit log about a user search: never the search text (it may be an email). */
function auditableUserQuery(query: UsersQueryDto): Record<string, unknown> {
  const { search, ...rest } = query;
  return { ...rest, searched: Boolean(search) };
}
