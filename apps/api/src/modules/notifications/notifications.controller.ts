import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';

class ListNotificationsDto {
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : undefined))
  @IsBoolean()
  unreadOnly?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

/**
 * The notification bell.
 *
 * Deliberately has NO permission decorator. Every authenticated user reads
 * their own notifications and nobody else's — the scoping is the caller's own
 * id inside the service, not a permission, because there is no role that should
 * be able to read another person's alerts.
 */
@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Your notifications, newest first' })
  async list(@Query() query: ListNotificationsDto, @CurrentUser() principal: TenantPrincipal) {
    return this.notifications.list(principal, query);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'How many you have not read' })
  async unreadCount(@CurrentUser() principal: TenantPrincipal) {
    return this.notifications.unreadCount(principal);
  }

  @Post(':id/read')
  @ApiOperation({ summary: 'Mark one read' })
  async markRead(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @CurrentUser() principal: TenantPrincipal,
  ) {
    return this.notifications.markRead(id, principal);
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Mark everything read' })
  async markAllRead(@CurrentUser() principal: TenantPrincipal) {
    return this.notifications.markAllRead(principal);
  }
}
