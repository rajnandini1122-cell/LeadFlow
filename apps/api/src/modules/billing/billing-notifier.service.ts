import { Injectable, Logger } from '@nestjs/common';
import { paiseToAmount } from '@leadflow/api-types';
import { EmailService } from '../../common/email/email.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
import { NotificationsRepository } from '../notifications/notifications.repository';
import { BillingRepository } from './billing.repository';

type NotificationKind = 'BILLING_REMINDER' | 'BILLING_EXPIRED' | 'BILLING_PAYMENT';

/**
 * Tells an organization's OWNER and ADMIN members about their subscription:
 * reminders before a trial or paid period ends, the end itself, and payment
 * outcomes.
 *
 * In-app through the existing notification table, whose (organization,
 * dedupe_key) unique index makes every notice idempotent: a key is derived
 * from WHAT is being announced (this organization, this period end, this
 * threshold), so a sweep that runs twice, two API processes, or a restart
 * mid-sweep cannot announce it twice. Email goes to the same people through
 * the existing email integration, and only when the in-app notice was newly
 * created — so email inherits the same idempotency. Never throws.
 */
@Injectable()
export class BillingNotifier {
  private readonly logger = new Logger(BillingNotifier.name);

  constructor(
    private readonly repository: BillingRepository,
    private readonly notifications: NotificationsRepository,
    private readonly tenantContext: TenantContextService,
    private readonly email: EmailService,
  ) {}

  async notify(input: {
    organizationId: string;
    organizationName: string;
    kind: NotificationKind;
    dedupeKey: string;
    title: string;
    body: string;
    emailLines?: string[];
    cta?: string;
  }): Promise<number> {
    try {
      const contacts = await this.repository.billingContacts(input.organizationId);
      let created = 0;
      for (const contact of contacts) {
        const fresh = await this.tenantContext.runForOrganization(
          input.organizationId,
          'billing notice',
          () =>
            this.notifications.createIfAbsent({
              userId: contact.user.id,
              type: input.kind,
              title: input.title.slice(0, 200),
              body: input.body.slice(0, 1000),
              entityType: 'subscription',
              dedupeKey: `${input.dedupeKey}:${contact.user.id}`.slice(0, 200),
            }),
        );
        if (!fresh) continue;
        created += 1;
        if (input.emailLines) {
          await this.email.sendBillingNotice({
            to: contact.user.email,
            organizationName: input.organizationName,
            subject: input.title,
            lines: input.emailLines,
            cta: input.cta ?? 'Open billing',
          });
        }
      }
      return created;
    } catch (error) {
      this.logger.warn({ organizationId: input.organizationId, err: (error as Error).message }, 'Billing notice failed');
      return 0;
    }
  }

  async paymentSucceeded(payment: {
    id: string;
    organizationId: string;
    receipt: string;
    interval: string;
    totalAmountPaise: number;
    periodEnd: Date | null;
  }): Promise<void> {
    const org = await this.repository.organization(payment.organizationId);
    const until = payment.periodEnd ? ` Premium is active until ${payment.periodEnd.toISOString().slice(0, 10)}.` : ' Lifetime Premium is active.';
    await this.notify({
      organizationId: payment.organizationId,
      organizationName: org?.name ?? 'Your organization',
      kind: 'BILLING_PAYMENT',
      dedupeKey: `billing:payment:${payment.id}:paid`,
      title: 'Payment received — LeadFlow Premium is active',
      body: `Payment ${payment.receipt} of ₹${paiseToAmount(payment.totalAmountPaise)} was received.${until}`,
      emailLines: [`We received payment ${payment.receipt} of ₹${paiseToAmount(payment.totalAmountPaise)} (including GST).${until}`, 'Thank you for choosing LeadFlow.'],
      cta: 'View payment history',
    });
  }

  async paymentFailed(payment: { id: string; organizationId: string; receipt: string }): Promise<void> {
    const org = await this.repository.organization(payment.organizationId);
    await this.notify({
      organizationId: payment.organizationId,
      organizationName: org?.name ?? 'Your organization',
      kind: 'BILLING_PAYMENT',
      dedupeKey: `billing:payment:${payment.id}:failed`,
      title: 'A LeadFlow payment did not go through',
      body: `Payment ${payment.receipt} failed. No money was taken for it. You can try again from Billing.`,
      emailLines: [`Payment ${payment.receipt} for LeadFlow Premium did not go through, and no money was taken for it.`, 'You can try again from the Billing page.'],
      cta: 'Try again',
    });
  }
}
