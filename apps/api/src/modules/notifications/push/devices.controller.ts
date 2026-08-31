import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ERROR_CODES } from '@leadflow/api-types';
import { AppException } from '../../../common/errors/app.exception';
import { MetricsService } from '../../../common/observability/metrics.service';
import type { TenantPrincipal } from '../../../common/tenancy/tenant-context.service';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { DevicesRepository } from './devices.repository';
import { PUSH_METRIC } from './push-dispatch.service';
import type { DevicePlatform } from '../../../generated/prisma/enums';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

class RegisterDeviceDto {
  /**
   * The provider's push token.
   *
   * Note what is ABSENT from this DTO: no organizationId, no userId. Both come
   * from the authenticated principal. A client that could name its own tenant
   * could register a device against somebody else's.
   */
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  @Transform(trim)
  token!: string;

  @IsOptional()
  @IsIn(['ANDROID', 'IOS', 'WEB'])
  platform?: DevicePlatform;

  /** A label for the device list. Untrusted display text, length-capped. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  label?: string;
}

class UnregisterDeviceDto {
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  @Transform(trim)
  token!: string;
}

/**
 * Device registration.
 *
 * Deliberately under `/users/me` and with NO permission decorator: a person
 * manages their own phones and nobody else's. There is no role that should be
 * able to register a device for a colleague, so the boundary is the
 * authenticated identity rather than a permission — and every method below
 * passes `principal.userId` explicitly rather than accepting one.
 *
 * Rate limited harder than the default. A registration endpoint that accepts
 * arbitrary strings is an invitation to fill the table with junk, and each junk
 * row is a fan-out target the worker retries.
 *
 * Sixty an hour, not twenty. The client re-registers on every app launch, and
 * Android kills backgrounded apps aggressively on low-memory handsets — which
 * is exactly the device a salesperson in the field is carrying. Twenty would
 * have 429'd a real user in a restart loop while doing nothing extra against an
 * attacker, who is limited by the same ceiling either way: sixty an hour is
 * still decisively short of the thousands of rows bulk abuse would need.
 */
@ApiTags('devices')
@Controller('users/me/devices')
export class DevicesController {
  constructor(
    private readonly devices: DevicesRepository,
    private readonly metrics: MetricsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Your registered devices',
    description: 'Push tokens are never returned — they are credentials.',
  })
  async list(@CurrentUser() principal: TenantPrincipal) {
    return { items: await this.devices.listForUser(principal.userId) };
  }

  /**
   * Registers this device, or refreshes the registration it already has.
   *
   * Idempotent by construction: an upsert on (organization, token). FCM rotates
   * tokens on reinstall and on some upgrades, and the client re-registers on
   * every launch — without the upsert that would be a new row per launch.
   */
  @Post()
  @Throttle({ default: { limit: 60, ttl: 3600_000 } })
  @ApiOperation({ summary: 'Register this device for push notifications' })
  async register(@Body() dto: RegisterDeviceDto, @CurrentUser() principal: TenantPrincipal) {
    const device = await this.devices.register({
      // From the principal, never from the body.
      userId: principal.userId,
      token: dto.token,
      platform: dto.platform ?? 'ANDROID',
      label: dto.label,
    });

    this.metrics.increment(PUSH_METRIC.REGISTRATIONS);

    return device;
  }

  /**
   * Unregisters by TOKEN — what a signing-out client knows about itself.
   *
   * By token rather than by user, deliberately. Signing out on a phone must not
   * silence the same person's tablet, and a client does not know the id of a
   * row it never read back.
   */
  @Post('unregister')
  @Throttle({ default: { limit: 60, ttl: 3600_000 } })
  @ApiOperation({ summary: 'Stop push on this device — used at sign-out' })
  async unregister(@Body() dto: UnregisterDeviceDto, @CurrentUser() principal: TenantPrincipal) {
    const deactivated = await this.devices.deactivateByTokenForUser(dto.token, principal.userId);

    if (deactivated > 0) this.metrics.increment(PUSH_METRIC.DEREGISTRATIONS);

    /*
     * Reports what happened without confirming whether the token exists
     * elsewhere. A response that distinguished "not yours" from "not found"
     * would let one user probe for another's device tokens.
     */
    return { deactivated };
  }

  /** Removes one device from the list, by id. */
  @Delete(':id')
  @ApiOperation({ summary: 'Deactivate one of your devices' })
  async deactivate(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    const deactivated = await this.devices.deactivateOwn(id, principal.userId, 'removed by user');

    if (deactivated === 0) {
      // Same 404 whether it belongs to someone else or does not exist.
      throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Device not found.');
    }

    this.metrics.increment(PUSH_METRIC.DEREGISTRATIONS);

    return { deactivated };
  }
}
