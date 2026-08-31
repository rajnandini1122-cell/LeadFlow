import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
import type { NotificationType } from '../../generated/prisma/enums';

/**
 * Notification data access.
 *
 * `Notification` is registered in TENANT_SCOPED_MODELS, so reads here never
 * mention organizationId — the extension narrows them and fails closed without
 * context. That matters especially: a notification body quotes customer names
 * and deal values, so a leak here is a leak of exactly the information a
 * competitor would want.
 */
@Injectable()
export class NotificationsRepository {
  private readonly logger = new Logger(NotificationsRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Creates a notification, or does nothing if this exact one already exists.
   *
   * The idempotency mechanism, and the reason a retried job is safe. The
   * deterministic `dedupeKey` has a unique index behind it, so the second
   * attempt inserts nothing and returns false rather than producing a duplicate
   * alert.
   */
  async createIfAbsent(input: {
    userId: string;
    type: NotificationType;
    title: string;
    body?: string | undefined;
    entityType?: string | undefined;
    entityId?: string | undefined;
    dedupeKey: string;
  }): Promise<boolean> {
    /*
     * INSERT ... ON CONFLICT DO NOTHING, via createMany + skipDuplicates.
     *
     * Deliberately NOT insert-and-catch-P2002. Catching the violation works,
     * but it RAISES on the expected path — and a raised database error is not
     * free: PGlite drops the connection on error, so every subsequent query in
     * the process failed with "Server has closed the connection". A retried
     * job is the NORMAL case for this method, so the normal case must not be
     * an exception.
     *
     * This keeps the property that matters. The uniqueness is still decided by
     * the constraint inside a single statement, so two concurrent workers
     * cannot both insert — which check-then-insert could never guarantee.
     * The returned count tells the caller which one won.
     */
    const result = await this.prisma.client.notification.createMany({
      data: [
        {
          organizationId: this.tenantContext.requireOrganizationId(),
          userId: input.userId,
          type: input.type,
          title: input.title,
          body: input.body ?? null,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          dedupeKey: input.dedupeKey,
        },
      ],
      skipDuplicates: true,
    });

    return result.count > 0;
  }

  /** This user's notifications, newest first. */
  async list(userId: string, filters: { unreadOnly: boolean; limit: number }) {
    const where = {
      userId,
      ...(filters.unreadOnly ? { readAt: null } : {}),
    };

    const [items, unread] = await Promise.all([
      this.prisma.client.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: filters.limit,
      }),
      this.prisma.client.notification.count({ where: { userId, readAt: null } }),
    ]);

    return { items, unread };
  }

  /**
   * Marks one notification read.
   *
   * Scoped to the CALLER's own userId as well as the id. Without that, any
   * authenticated user could mark another user's notification read by guessing
   * an id — a small thing that quietly hides work from the person who owed it.
   */
  async markRead(id: string, userId: string): Promise<number> {
    const result = await this.prisma.client.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
    return result.count;
  }

  async markAllRead(userId: string): Promise<number> {
    const result = await this.prisma.client.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return result.count;
  }

  async unreadCount(userId: string): Promise<number> {
    return this.prisma.client.notification.count({ where: { userId, readAt: null } });
  }

  /**
   * Whether a notification with this key already exists.
   *
   * Used only for SUPPRESSION decisions — "have we already asked about this
   * customer this month" — never as a pre-check before creating, which would
   * reintroduce the race the unique constraint exists to win.
   */
  async exists(dedupeKey: string): Promise<boolean> {
    const row = await this.prisma.client.notification.findFirst({
      where: { dedupeKey },
      select: { id: true },
    });
    return row !== null;
  }

  /** Managers and admins in this organization, for escalation. */
  async escalationRecipients(): Promise<string[]> {
    const memberships = await this.prisma.client.organizationUser.findMany({
      where: { status: 'ACTIVE', role: { key: { in: ['OWNER', 'ADMIN', 'MANAGER'] } } },
      select: { userId: true },
    });

    return memberships.map((membership) => membership.userId);
  }
}
