import { Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { NotificationsRepository } from './notifications.repository';

export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
}

/**
 * In-app notifications.
 *
 * Reads are always scoped to the CALLER, never to a user id from the request.
 * A notification body quotes customer names and deal values, so letting a
 * caller name whose notifications to read would be an authorization hole in the
 * one place people would least think to look.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly repository: NotificationsRepository) {}

  async list(
    principal: TenantPrincipal,
    options: { unreadOnly?: boolean | undefined; limit?: number | undefined },
  ): Promise<{ items: NotificationView[]; unread: number }> {
    const { items, unread } = await this.repository.list(principal.userId, {
      unreadOnly: options.unreadOnly ?? false,
      limit: Math.min(options.limit ?? 30, 100),
    });

    return { items: items.map(toView), unread };
  }

  async unreadCount(principal: TenantPrincipal): Promise<{ unread: number }> {
    return { unread: await this.repository.unreadCount(principal.userId) };
  }

  /**
   * Marks one read.
   *
   * Scoped to the caller's own id as well as the notification id: without that
   * any authenticated user could mark another user's notification read by
   * guessing an id, quietly hiding work from the person who owed it.
   */
  async markRead(id: string, principal: TenantPrincipal): Promise<{ unread: number }> {
    const updated = await this.repository.markRead(id, principal.userId);

    if (updated === 0) {
      // Already read, or not this user's. The same 404 either way — confirming
      // the difference would leak that somebody else has a notification.
      throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Notification not found.');
    }

    return { unread: await this.repository.unreadCount(principal.userId) };
  }

  async markAllRead(principal: TenantPrincipal): Promise<{ cleared: number; unread: number }> {
    const cleared = await this.repository.markAllRead(principal.userId);
    return { cleared, unread: 0 };
  }
}

function toView(row: {
  id: string;
  type: string;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  readAt: Date | null;
  createdAt: Date;
}): NotificationView {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    entityType: row.entityType,
    entityId: row.entityId,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
