import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../tenancy/tenant-context.service';

export interface AuditEntry {
  action: string;
  organizationId?: string | undefined;
  actorUserId?: string | undefined;
  entityType?: string | undefined;
  entityId?: string | undefined;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * Append-only audit trail (spec §19).
 *
 * `AuditLog` is deliberately excluded from automatic tenant scoping: some
 * auditable events have no resolvable tenant (a failed login against an unknown
 * email), and the write must succeed anyway. The tenant is therefore always set
 * explicitly here.
 *
 * Writes never throw. An audit failure must not roll back the business action
 * that succeeded — it is logged loudly instead.
 */
@Injectable()
export class AuditRepository {
  private readonly logger = new Logger(AuditRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.client.auditLog.create({
        data: {
          action: entry.action,
          organizationId: entry.organizationId ?? this.tenantContext.organizationId ?? null,
          actorUserId: entry.actorUserId ?? this.tenantContext.userId ?? null,
          entityType: entry.entityType ?? null,
          entityId: entry.entityId ?? null,
          before: (entry.before ?? null) as never,
          after: (entry.after ?? null) as never,
          ipAddress: entry.ipAddress ?? null,
          userAgent: entry.userAgent ?? null,
          requestId: this.tenantContext.requestId ?? null,
        },
      });
    } catch (error) {
      this.logger.error(
        { action: entry.action, err: error },
        'Failed to write audit log entry — business action was NOT rolled back',
      );
    }
  }
}

/** Audited action names. Kept together so the vocabulary stays consistent. */
export const AUDIT_ACTIONS = {
  LOGIN_SUCCESS: 'auth.login.success',
  LOGIN_FAILED: 'auth.login.failed',
  LOGOUT: 'auth.logout',
  TOKEN_REFRESHED: 'auth.token.refreshed',
  TOKEN_REUSE_DETECTED: 'auth.token.reuse_detected',
  USER_INVITED: 'user.invited',
  USER_UPDATED: 'user.updated',
  USER_SUSPENDED: 'user.suspended',
  ROLE_CHANGED: 'user.role_changed',
  ORGANIZATION_UPDATED: 'organization.updated',
  LEAD_ASSIGNED: 'lead.assigned',
  LEAD_DELETED: 'lead.deleted',
  ACCOUNT_CREATED: 'account.created',
  ACCOUNT_UPDATED: 'account.updated',
  /** Irreversible: two customer histories become one. Both ids are recorded. */
  ACCOUNT_MERGED: 'account.merged',
  /** What every acquisition and retention figure is counted from. */
  ACCOUNT_STATUS_CHANGED: 'account.status_changed',
  ACCOUNT_LEAD_LINKED: 'account.lead_linked',
  /** A new opportunity raised against an existing customer, with its origin. */
  REPEAT_OPPORTUNITY_CREATED: 'account.repeat_opportunity_created',
  ACCOUNT_FOLLOW_UP_CREATED: 'account.follow_up_created',
  ACCOUNT_CONTACT_LINKED: 'account.contact_linked',
  SUBSCRIPTION_CHANGED: 'subscription.changed',
} as const;
