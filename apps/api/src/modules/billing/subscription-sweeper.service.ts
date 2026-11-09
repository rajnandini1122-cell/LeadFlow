import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { PAST_DUE_GRACE_DAYS, REMINDER_DAYS, TRIAL_EXPIRED_MESSAGE } from '@leadflow/api-types';
import { AppConfig } from '../../common/config/config.module';
import { BillingNotifier } from './billing-notifier.service';
import { BillingRepository } from './billing.repository';
import { BillingService } from './billing.service';

const DAY = 86_400_000;

/**
 * The subscription sweep, every ten minutes in the API process:
 *
 *   1. reminders 7, 3 and 1 days before a trial or paid period ends, and a
 *      notice when it has ended (idempotent: see BillingNotifier);
 *   2. payment reconciliation (orders the browser never confirmed, abandoned
 *      orders, refunds made in the Razorpay Dashboard);
 *   3. stored status kept in step for reporting (TRIAL -> EXPIRED, ACTIVE ->
 *      PAST_DUE -> EXPIRED), each change in the audit trail.
 *
 * Access never waits for this sweep: the guard evaluates entitlement from the
 * stored dates on every request. The sweep only notifies and tidies, so a
 * missed run delays an email, never a lockout, and never grants access.
 */
@Injectable()
export class SubscriptionSweeper implements OnModuleInit, OnApplicationShutdown {
  static readonly EVERY_MS = 10 * 60_000;
  private readonly logger = new Logger(SubscriptionSweeper.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly repository: BillingRepository,
    private readonly billing: BillingService,
    private readonly notifier: BillingNotifier,
    private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.get('NODE_ENV') === 'test') return; // tests call sweep() directly
    this.timer = setInterval(() => void this.sweep(), SubscriptionSweeper.EVERY_MS);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  async sweep(now = new Date()): Promise<{ notices: number; statusChanges: number; reconciled: number }> {
    if (this.running) await this.running;
    let result = { notices: 0, statusChanges: 0, reconciled: 0 };
    this.running = (async () => {
      try {
        const notices = await this.remind(now);
        const statusChanges = await this.syncStatuses(now);
        const { checked } = await this.billing.reconcile(now);
        result = { notices, statusChanges, reconciled: checked };
      } catch (error) {
        this.logger.warn({ err: (error as Error).message }, 'Subscription sweep failed; retried next run');
      }
    })();
    await this.running;
    this.running = null;
    return result;
  }

  /** Reminder thresholds crossed, and ends reached in the last two days. */
  async remind(now: Date): Promise<number> {
    const due = await this.repository.subscriptionsEndingBetween(
      new Date(now.getTime() - 2 * DAY),
      new Date(now.getTime() + Math.max(...REMINDER_DAYS) * DAY),
    );
    let sent = 0;
    for (const sub of due) {
      if (sub.entitlementDecision === 'PENDING_REVIEW') continue; // never told access is ending
      const trial = sub.status === 'TRIAL';
      const end = trial ? sub.trialEndsAt! : sub.currentPeriodEnd;
      if (!trial && sub.complimentaryUntil && sub.complimentaryUntil > end) continue;
      const endKey = end.toISOString();
      const name = sub.organization.name;
      const what = trial ? 'free trial' : 'LeadFlow Premium';
      if (end.getTime() <= now.getTime()) {
        sent += await this.notifier.notify({
          organizationId: sub.organizationId,
          organizationName: name,
          kind: 'BILLING_EXPIRED',
          dedupeKey: `billing:ended:${sub.organizationId}:${endKey}`,
          title: trial ? 'Your LeadFlow free trial has expired' : 'Your LeadFlow Premium period has ended',
          body: trial
            ? TRIAL_EXPIRED_MESSAGE
            : `Renew within ${PAST_DUE_GRACE_DAYS} days to keep using LeadFlow CRM without interruption.`,
          emailLines: [
            trial ? TRIAL_EXPIRED_MESSAGE : `Your LeadFlow Premium period ended on ${endKey.slice(0, 10)}. Renew within ${PAST_DUE_GRACE_DAYS} days to keep using LeadFlow CRM without interruption.`,
            'Your leads, contacts and records are kept safe.',
          ],
          cta: trial ? 'Upgrade to Premium' : 'Renew subscription',
        });
        continue;
      }
      const left = Math.ceil((end.getTime() - now.getTime()) / DAY);
      // The smallest threshold not yet passed: first seen at 5 days -> the 7-day
      // notice; at 2 days -> the 3-day notice. One notice per threshold.
      const threshold = [...REMINDER_DAYS].sort((a, b) => a - b).find((d) => left <= d);
      if (!threshold) continue;
      const when = left <= 1 ? 'tomorrow' : `in ${left} days`;
      sent += await this.notifier.notify({
        organizationId: sub.organizationId,
        organizationName: name,
        kind: 'BILLING_REMINDER',
        dedupeKey: `billing:reminder:${sub.organizationId}:${endKey}:${threshold}`,
        title: `Your ${what} ends ${when}`,
        body: `Your LeadFlow ${what} ends on ${endKey.slice(0, 10)}. ${trial ? 'Upgrade to Premium' : 'Renew'} to keep using LeadFlow CRM without interruption.`,
        emailLines: [
          `Your LeadFlow ${what} for ${name} ends on ${endKey.slice(0, 10)} (${when}).`,
          `${trial ? 'Upgrade to Premium' : 'Renew'} to keep using LeadFlow CRM without interruption. Your data stays exactly as it is.`,
        ],
        cta: trial ? 'View plans' : 'Renew subscription',
      });
    }
    return sent;
  }

  /** Stored status follows the dates, for reporting. Access does not depend on it. */
  async syncStatuses(now: Date): Promise<number> {
    const grace = new Date(now.getTime() - PAST_DUE_GRACE_DAYS * DAY);
    return this.repository.transaction('sync subscription statuses', async (tx) => {
      const customer = { organization: { organizationType: 'CUSTOMER' as const }, lifetime: false, exempt: false };
      const rules = [
        {
          where: { ...customer, status: 'TRIAL' as const, trialEndsAt: { lt: now }, OR: [{ entitlementDecision: null }, { entitlementDecision: { not: 'PENDING_REVIEW' } }] },
          to: 'EXPIRED' as const,
          action: 'status.trial_expired',
          reason: 'The free trial reached its end date.',
        },
        {
          where: { ...customer, status: 'ACTIVE' as const, currentPeriodEnd: { lt: now }, OR: [{ complimentaryUntil: null }, { complimentaryUntil: { lt: now } }] },
          to: 'PAST_DUE' as const,
          action: 'status.past_due',
          reason: `The paid period ended; ${PAST_DUE_GRACE_DAYS} days of grace to renew.`,
        },
        {
          where: { ...customer, status: 'PAST_DUE' as const, currentPeriodEnd: { lt: grace }, OR: [{ complimentaryUntil: null }, { complimentaryUntil: { lt: now } }] },
          to: 'EXPIRED' as const,
          action: 'status.expired',
          reason: 'The grace period after the paid period ended.',
        },
      ];
      let changed = 0;
      for (const rule of rules) {
        const rows = await tx.subscription.findMany({ where: rule.where, select: { organizationId: true, status: true } });
        for (const row of rows) {
          const done = await tx.subscription.updateMany({
            where: { organizationId: row.organizationId, status: row.status },
            data: { status: rule.to },
          });
          if (done.count === 0) continue;
          await tx.subscriptionChange.create({
            data: {
              organizationId: row.organizationId,
              action: rule.action,
              actorType: 'system',
              actorRef: 'subscription-sweeper',
              reason: rule.reason,
              before: { status: row.status },
              after: { status: rule.to },
            },
          });
          this.billing.invalidate(row.organizationId);
          changed += 1;
        }
      }
      return changed;
    });
  }
}
