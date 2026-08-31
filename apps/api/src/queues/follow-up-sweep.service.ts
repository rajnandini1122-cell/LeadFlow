import { Injectable, Logger } from '@nestjs/common';
import { TenantContextService } from '../common/tenancy/tenant-context.service';
import { NotificationsRepository } from '../modules/notifications/notifications.repository';
import { MetricsService, METRIC } from '../common/observability/metrics.service';
import { FollowUpSweepRepository } from './follow-up-sweep.repository';
import { jobPrincipal } from './job-context';
import {
  nextStatus,
  notificationKey,
  shouldEscalate,
  shouldNotifyOverdue,
  shouldRemind,
  type OpenStatus,
} from './follow-up-lifecycle';

export interface SweepResult {
  organizations: number;
  transitioned: number;
  reminders: number;
  overdueAlerts: number;
  escalations: number;
  failures: number;
}

/**
 * The sweep that makes "no lead left behind" a system property.
 *
 * Before this existed, `FollowUpStatus` implied a lifecycle that nothing drove:
 * a follow-up sat at UPCOMING forever, `isOverdue` was computed in JavaScript
 * when somebody opened a page, and a salesperson who did not open the app was
 * never reminded of anything. The promise was enforced only while someone was
 * looking at it.
 *
 * Three properties this has to have, and each is load-bearing:
 *
 *   TENANT-SAFE. One cross-tenant query finds which organizations have work;
 *   everything else runs inside `runWithTenant` with a synthetic principal
 *   scoped to that one organization. A processor cannot see another tenant's
 *   follow-ups even if its own WHERE clause is wrong.
 *
 *   IDEMPOTENT, twice over. A marker is claimed conditionally before any
 *   notification is written, and the notification itself carries a
 *   deterministic key with a unique index behind it. A retry has to defeat both
 *   to double-notify.
 *
 *   FAIL-SOFT PER TENANT. One organization's failure is logged and the sweep
 *   continues. A single bad row must not stop every other tenant's reminders,
 *   because the failure mode of this job is silently missed work.
 */
@Injectable()
export class FollowUpSweepService {
  private readonly logger = new Logger(FollowUpSweepService.name);

  constructor(
    private readonly repository: FollowUpSweepRepository,
    private readonly notifications: NotificationsRepository,
    private readonly tenantContext: TenantContextService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * One pass. Safe to run every minute, and safe to run twice at once.
   *
   * `now` is injected rather than read from the clock so the whole sweep is
   * testable at exact boundaries — the boundaries are where a reminder system
   * gets things wrong.
   */
  async sweep(now = new Date()): Promise<SweepResult> {
    const result: SweepResult = {
      organizations: 0,
      transitioned: 0,
      reminders: 0,
      overdueAlerts: 0,
      escalations: 0,
      failures: 0,
    };

    // The one cross-tenant read. Returns organization ids and nothing else.
    const organizationIds = await this.repository.organizationsWithDueWork(now);
    result.organizations = organizationIds.length;

    for (const organizationId of organizationIds) {
      try {
        // Every subsequent query is narrowed to this organization by the
        // extension, exactly as it would be for an HTTP request.
        await this.tenantContext.runWithTenant(jobPrincipal(organizationId), async () => {
          const tenantResult = await this.sweepOrganization(now);

          result.transitioned += tenantResult.transitioned;
          result.reminders += tenantResult.reminders;
          result.overdueAlerts += tenantResult.overdueAlerts;
          result.escalations += tenantResult.escalations;
        });
      } catch (error) {
        /*
         * Fail soft, per tenant. One organization's bad data must not stop
         * every other organization's reminders — the failure mode of this job
         * is work nobody hears about, which is the exact thing it exists to
         * prevent.
         */
        result.failures += 1;
        this.logger.error(
          { err: error, organizationId },
          'Follow-up sweep failed for one organization — continuing with the rest',
        );
      }
    }

    /*
     * Recorded every run, including the quiet ones.
     *
     * `lastSweepAt` is what makes a DEAD worker visible: a sweep that stopped
     * running produces no errors and no logs, so the only evidence is a
     * timestamp that stops moving. That is the failure this whole feature
     * exists to prevent, so it is the one most worth monitoring.
     */
    this.metrics.recordSweep(result);
    this.metrics.increment(
      METRIC.NOTIFICATIONS_CREATED,
      result.reminders + result.overdueAlerts + result.escalations,
    );

    if (result.transitioned || result.reminders || result.overdueAlerts || result.escalations) {
      this.logger.log(result, 'Follow-up sweep completed');
    }

    return result;
  }

  /** One organization. Already inside tenant context when this runs. */
  private async sweepOrganization(now: Date): Promise<Omit<SweepResult, 'organizations' | 'failures'>> {
    const settings = await this.repository.settings();
    const reminderMinutes = settings?.followupReminderMinutes ?? 30;
    const overdueMinutes = settings?.followupOverdueMinutes ?? 120;
    const escalateToManager = settings?.escalateToManager ?? false;

    let transitioned = 0;
    let reminders = 0;
    let overdueAlerts = 0;
    let escalations = 0;

    // --- advance reminders, for things not yet due --------------------------
    const reminderWindowEnd = new Date(now.getTime() + reminderMinutes * 60_000);
    const upcoming = await this.repository.upcomingFollowUps(now, reminderWindowEnd);

    for (const followUp of upcoming) {
      const due = shouldRemind({
        scheduledAt: followUp.scheduledAt,
        reminderSentAt: followUp.reminderSentAt,
        reminderMinutes,
        now,
      });
      if (!due) continue;

      // Claim first. A marker with no notification is a missed reminder and
      // recoverable; a notification with no marker repeats forever.
      const claimed = await this.repository.claimMarker(followUp.id, 'reminderSentAt');
      if (claimed === 0) continue;

      const created = await this.notifications.createIfAbsent({
        userId: followUp.assignedUserId,
        type: 'FOLLOW_UP_DUE',
        title: `Follow-up soon: ${describe(followUp)}`,
        body: followUp.title ?? undefined,
        entityType: 'FollowUp',
        entityId: followUp.id,
        dedupeKey: notificationKey(followUp.id, 'REMINDER'),
      });

      if (created) reminders += 1;
    }

    // --- status transitions, overdue alerts, escalation ---------------------
    const due = await this.repository.dueFollowUps(now);

    for (const followUp of due) {
      const target = nextStatus({
        status: followUp.status as OpenStatus,
        scheduledAt: followUp.scheduledAt,
        overdueMinutes,
        now,
      });

      if (target) {
        /*
         * Conditional on the status the sweep saw. If a rep completed this
         * between the read and the write, zero rows change — the sweep must
         * never resurrect a completed follow-up into OVERDUE.
         */
        const moved = await this.repository.advanceStatus({
          id: followUp.id,
          from: followUp.status,
          to: target,
        });
        if (moved > 0) transitioned += 1;
      }

      if (
        shouldNotifyOverdue({
          scheduledAt: followUp.scheduledAt,
          overdueNotifiedAt: followUp.overdueNotifiedAt,
          overdueMinutes,
          now,
        })
      ) {
        const claimed = await this.repository.claimMarker(followUp.id, 'overdueNotifiedAt');
        if (claimed > 0) {
          const created = await this.notifications.createIfAbsent({
            userId: followUp.assignedUserId,
            type: 'FOLLOW_UP_OVERDUE',
            title: `Overdue: ${describe(followUp)}`,
            body: followUp.title ?? undefined,
            entityType: 'FollowUp',
            entityId: followUp.id,
            dedupeKey: notificationKey(followUp.id, 'OVERDUE'),
          });
          if (created) overdueAlerts += 1;
        }
      }

      if (
        shouldEscalate({
          scheduledAt: followUp.scheduledAt,
          overdueNotifiedAt: followUp.overdueNotifiedAt,
          escalatedAt: followUp.escalatedAt,
          overdueMinutes,
          escalateToManager,
          now,
        })
      ) {
        const claimed = await this.repository.claimMarker(followUp.id, 'escalatedAt');
        if (claimed > 0) {
          const managers = await this.notifications.escalationRecipients();

          for (const managerId of managers) {
            // The rep already knows — telling them again as "escalated" is
            // noise, and telling their manager about their own escalation is
            // worse.
            if (managerId === followUp.assignedUserId) continue;

            const created = await this.notifications.createIfAbsent({
              userId: managerId,
              type: 'FOLLOW_UP_ESCALATED',
              title: `Still overdue: ${describe(followUp)}`,
              body: followUp.title ?? undefined,
              entityType: 'FollowUp',
              entityId: followUp.id,
              // Per recipient: two managers each need their own row, and one
              // key would let the first insert silence the second.
              dedupeKey: notificationKey(followUp.id, `ESCALATED:${managerId}`),
            });
            if (created) escalations += 1;
          }
        }
      }
    }

    return { transitioned, reminders, overdueAlerts, escalations };
  }
}

/**
 * What to call this follow-up in a notification.
 *
 * A person reading a phone lock screen needs to know WHO, not which record.
 * Falls back through the identifiers that actually mean something, and never
 * shows a bare uuid.
 */
function describe(followUp: {
  lead: { leadNumber: string; firstName: string | null; lastName: string | null; companyName: string | null } | null;
  account: { name: string } | null;
}): string {
  if (followUp.account) return followUp.account.name;

  if (followUp.lead) {
    const name = [followUp.lead.firstName, followUp.lead.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();

    return followUp.lead.companyName || name || followUp.lead.leadNumber;
  }

  return 'a follow-up';
}
