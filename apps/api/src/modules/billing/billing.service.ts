import { randomBytes } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  ERROR_CODES,
  LIFETIME_SCOPE,
  PERMISSIONS,
  SUBSCRIPTION_EXPIRED_MESSAGE,
  TRIAL_EXPIRED_MESSAGE,
  daysRemaining,
  evaluateEntitlement,
  paiseToAmount,
  periodEnd,
  type BillingInterval,
  type BillingPaymentStatus,
  type BillingPaymentView,
  type BillingSummaryView,
  type CheckoutOrderView,
  type EntitlementFacts,
  type EntitlementResult,
  type PlanPriceView,
} from '@leadflow/api-types';
import { AppConfig } from '../../common/config/config.module';
import { AppException } from '../../common/errors/app.exception';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { BillingNotifier } from './billing-notifier.service';
import { BillingRepository, lockSubscription, type priceSelect } from './billing.repository';
import { RazorpayClient, RazorpayError, type RazorpayPayment } from './razorpay.client';

type OrganizationRow = NonNullable<Awaited<ReturnType<BillingRepository['organization']>>>;
type PriceRow = NonNullable<Awaited<ReturnType<BillingRepository['activePrice']>>>;
type PaymentRow = NonNullable<Awaited<ReturnType<BillingRepository['paymentById']>>>;
export type Actor = { type: 'payment' | 'admin' | 'system' | 'user'; ref: string };

/** How long an unpaid order is reused for a repeat checkout of the same plan. */
const REUSE_ORDER_MS = 30 * 60_000;
/** Unpaid orders older than this are marked EXPIRED by the sweep. */
export const ORDER_EXPIRY_MS = 3 * 86_400_000;

export function entitlementFacts(org: OrganizationRow): EntitlementFacts {
  const sub = org.subscription;
  return {
    organizationType: org.organizationType,
    organizationStatus: org.status,
    deleted: org.deletedAt !== null,
    subscription: sub && {
      status: sub.status,
      trialEndsAt: sub.trialEndsAt,
      currentPeriodEnd: sub.currentPeriodEnd,
      lifetime: sub.lifetime,
      complimentaryUntil: sub.complimentaryUntil,
      exempt: sub.exempt,
      accessHold: sub.accessHold,
      entitlementDecision: sub.entitlementDecision,
    },
  };
}

export function toPriceView(row: Pick<PriceRow, keyof typeof priceSelect>): PlanPriceView {
  return {
    id: row.id,
    planCode: row.plan.code,
    planName: row.plan.name,
    interval: row.interval,
    version: row.version,
    currency: row.currency,
    baseAmount: paiseToAmount(row.baseAmountPaise),
    taxRatePercent: (row.taxRateBp / 100).toString(),
    taxAmount: paiseToAmount(row.taxAmountPaise),
    totalAmount: paiseToAmount(row.totalAmountPaise),
    taxInclusive: row.taxInclusive,
    renewal: row.renewal === 'NONE' ? 'NONE' : 'MANUAL',
  };
}

export function toPaymentView(row: PaymentRow): BillingPaymentView {
  return {
    id: row.id,
    receipt: row.receipt,
    interval: row.interval,
    status: row.status as BillingPaymentStatus,
    currency: row.currency,
    baseAmount: paiseToAmount(row.baseAmountPaise),
    taxAmount: paiseToAmount(row.taxAmountPaise),
    totalAmount: paiseToAmount(row.totalAmountPaise),
    refundedAmount: paiseToAmount(row.refundedPaise),
    providerPaymentId: row.providerPaymentId,
    periodStart: row.periodStart?.toISOString() ?? null,
    periodEnd: row.periodEnd?.toISOString() ?? null,
    paidAt: row.paidAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * LeadFlow billing: entitlement, Razorpay checkout, payment confirmation,
 * failures, refunds and reconciliation.
 *
 * THE RULE: paid access is granted only after LeadFlow itself confirms the
 * payment with Razorpay — the checkout signature proves the browser's message
 * came from Razorpay, and a server-side fetch of the payment proves it was
 * captured, for this order, for exactly this amount. A frontend saying "paid"
 * grants nothing. Applying a payment is idempotent (CREATED/FAILED -> PAID is a
 * conditional update) and serialised per organization (row lock), so a
 * checkout confirmation, a webhook and the reconciliation sweep can all see
 * the same payment and it is applied once.
 *
 * Payments are LeadFlow's own records (billing_payments) on the shared CRAVION
 * merchant account, told apart by an "LF-" receipt and notes.product =
 * "leadflow". CRAVION's store webhook acknowledges and ignores them.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  /** Short per-process entitlement cache for the guard; cleared on every change. */
  private readonly cache = new Map<string, { at: number; result: EntitlementResult }>();
  private static readonly CACHE_MS = 30_000;

  constructor(
    private readonly repository: BillingRepository,
    private readonly razorpay: RazorpayClient,
    private readonly config: AppConfig,
    private readonly notifier: BillingNotifier,
  ) {}

  // --- entitlement -------------------------------------------------------------

  async entitlement(organizationId: string, now = new Date()): Promise<EntitlementResult> {
    const hit = this.cache.get(organizationId);
    if (hit && now.getTime() - hit.at < BillingService.CACHE_MS) return hit.result;
    const org = await this.repository.organization(organizationId);
    const result: EntitlementResult = org
      ? evaluateEntitlement(entitlementFacts(org), now)
      : { state: 'SUSPENDED', grantsAccess: false, accessEndsAt: null };
    this.cache.set(organizationId, { at: now.getTime(), result });
    if (this.cache.size > 5_000) this.cache.clear();
    return result;
  }

  invalidate(organizationId: string): void {
    this.cache.delete(organizationId);
  }

  async summary(principal: TenantPrincipal, now = new Date()): Promise<BillingSummaryView> {
    const org = await this.requireOrganization(principal.organizationId);
    const result = evaluateEntitlement(entitlementFacts(org), now);
    const sub = org.subscription;
    const billable = org.organizationType === 'CUSTOMER' && !sub?.exempt;
    const [prices, payments] = await Promise.all([
      this.repository.activePrices(),
      this.repository.payments(org.id),
    ]);
    const trialOver = sub?.status === 'TRIAL' || sub?.entitlementDecision === 'TRIAL_ALREADY_USED';
    return {
      state: result.state,
      grantsAccess: result.grantsAccess,
      billable,
      accessEndsAt: result.accessEndsAt?.toISOString() ?? null,
      daysRemaining: daysRemaining(result.accessEndsAt, now),
      trialStartsAt: sub?.trialStartsAt?.toISOString() ?? null,
      trialEndsAt: sub?.trialEndsAt?.toISOString() ?? null,
      planName: sub ? sub.plan.name : null,
      interval: sub && sub.status !== 'TRIAL' ? sub.billingInterval : null,
      lifetime: sub?.lifetime ?? false,
      message:
        result.state === 'EXPIRED' || result.state === 'CANCELLED'
          ? trialOver
            ? TRIAL_EXPIRED_MESSAGE
            : SUBSCRIPTION_EXPIRED_MESSAGE
          : null,
      enforcementEnabled: this.config.get('SUBSCRIPTION_ENFORCEMENT_ENABLED'),
      checkoutEnabled: this.checkoutAvailable(),
      canPay: billable && principal.permissions.includes(PERMISSIONS.SUBSCRIPTION_MANAGE),
      prices: billable ? prices.map(toPriceView) : [],
      payments: payments.map(toPaymentView),
      lifetimeScope: LIFETIME_SCOPE,
      supportEmail: this.config.get('BILLING_SUPPORT_EMAIL'),
    };
  }

  checkoutAvailable(): boolean {
    return this.config.get('BILLING_CHECKOUT_ENABLED') && this.razorpay.configured;
  }

  // --- checkout ------------------------------------------------------------------

  async checkout(
    principal: TenantPrincipal,
    interval: BillingInterval,
    buyer: { name: string; email: string },
    now = new Date(),
  ): Promise<CheckoutOrderView> {
    if (!this.checkoutAvailable()) {
      throw new AppException(
        ERROR_CODES.BILLING_CHECKOUT_DISABLED,
        'Online payment is not available yet. Please contact support to subscribe.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (!principal.permissions.includes(PERMISSIONS.SUBSCRIPTION_MANAGE)) throw AppException.forbidden();
    const org = await this.requireOrganization(principal.organizationId);
    if (org.organizationType === 'INTERNAL' || org.subscription?.exempt) {
      throw AppException.conflict(ERROR_CODES.CONFLICT, 'This organization is exempt from payment.');
    }
    if (org.subscription?.lifetime) {
      throw AppException.conflict(ERROR_CODES.CONFLICT, 'This organization already has Lifetime Premium.');
    }
    if (org.status === 'SUSPENDED' || org.deletionRequestedAt) {
      throw AppException.forbiddenWithCode(ERROR_CODES.FORBIDDEN, 'This organization cannot be billed while it is suspended.');
    }
    const price = await this.repository.activePrice(interval);
    if (!price) throw AppException.notFound(ERROR_CODES.PLAN_NOT_FOUND, 'That plan is not offered.');

    // A second click, a reload, a back button: reuse the unpaid order rather than create another.
    const open = await this.repository.openPayment(org.id, interval, new Date(now.getTime() - REUSE_ORDER_MS));
    const payment =
      open && open.totalAmountPaise === price.totalAmountPaise && open.planPriceId === price.id
        ? open
        : await this.createOrder(org.id, principal.userId, price);

    return {
      paymentId: payment.id,
      providerOrderId: payment.providerOrderId,
      keyId: this.razorpay.keyId,
      amountPaise: payment.totalAmountPaise,
      currency: payment.currency,
      receipt: payment.receipt,
      description: `${price.plan.name} — ${interval.toLowerCase()} (incl. ${price.taxRateBp / 100}% GST)`,
      organizationName: org.name,
      prefill: buyer,
    };
  }

  private async createOrder(organizationId: string, userId: string, price: PriceRow) {
    const receipt = `LF-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(4).toString('hex')}`;
    let order;
    try {
      order = await this.razorpay.createOrder({
        amountPaise: price.totalAmountPaise,
        currency: price.currency,
        receipt,
        notes: {
          product: 'leadflow',
          organization_id: organizationId,
          plan: price.plan.code,
          interval: price.interval,
          plan_price_id: price.id,
        },
      });
    } catch (error) {
      this.logger.error({ err: describe(error) }, 'Razorpay order creation failed');
      throw new AppException(
        ERROR_CODES.PAYMENT_VERIFICATION_FAILED,
        'The payment could not be started. Please try again in a moment.',
        HttpStatus.BAD_GATEWAY,
      );
    }
    if (order.amount !== price.totalAmountPaise || order.currency !== price.currency) {
      throw new AppException(ERROR_CODES.PAYMENT_VERIFICATION_FAILED, 'The payment provider returned an unexpected order.', HttpStatus.BAD_GATEWAY);
    }
    return this.repository.createPayment({
      organizationId,
      planPriceId: price.id,
      interval: price.interval,
      currency: price.currency,
      baseAmountPaise: price.baseAmountPaise,
      taxAmountPaise: price.taxAmountPaise,
      totalAmountPaise: price.totalAmountPaise,
      receipt,
      providerOrderId: order.id,
      createdByUserId: userId,
    });
  }

  /**
   * The browser's checkout callback. Signature first (it came from Razorpay),
   * then the payment as Razorpay holds it (captured, this order, this amount).
   */
  async verifyCheckout(
    principal: TenantPrincipal,
    input: { orderId: string; paymentId: string; signature: string },
  ): Promise<BillingPaymentView> {
    const payment = await this.repository.paymentByOrder(input.orderId);
    // Another organization's order is "not found", not "forbidden": no oracle.
    if (!payment || payment.organizationId !== principal.organizationId) {
      throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Payment not found.');
    }
    if (!this.razorpay.verifyCheckoutSignature(input.orderId, input.paymentId, input.signature)) {
      this.logger.warn({ paymentId: payment.id }, 'Rejected a checkout callback with an invalid signature');
      throw new AppException(ERROR_CODES.PAYMENT_VERIFICATION_FAILED, 'The payment could not be verified.', HttpStatus.BAD_REQUEST);
    }
    const provider = await this.fetchPayment(input.paymentId);
    const applied = await this.settleFromProvider(payment, provider, { type: 'payment', ref: `razorpay:${provider.id}` });
    if (applied.status !== 'PAID') {
      throw new AppException(
        ERROR_CODES.PAYMENT_VERIFICATION_FAILED,
        provider.status === 'failed' ? 'The payment failed. No money was taken for LeadFlow.' : 'The payment is not complete yet.',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    return toPaymentView(applied);
  }

  // --- applying provider truth ----------------------------------------------------

  /**
   * Brings one billing payment in line with Razorpay's record of one of its
   * payments. Shared by checkout confirmation, the webhook and reconciliation.
   */
  async settleFromProvider(payment: PaymentRow, provider: RazorpayPayment, actor: Actor): Promise<PaymentRow> {
    if (provider.order_id !== payment.providerOrderId) {
      this.logger.warn({ paymentId: payment.id }, 'Provider payment belongs to another order; ignored');
      return payment;
    }
    if (provider.amount !== payment.totalAmountPaise || provider.currency !== payment.currency) {
      this.logger.error({ paymentId: payment.id, amount: provider.amount }, 'Provider amount differs from the order; not applied');
      return payment;
    }
    if (provider.status === 'authorized') {
      // Captured by LeadFlow if the account does not auto-capture.
      provider = await this.razorpay.capture(provider.id, payment.totalAmountPaise, payment.currency);
    }
    if (provider.status === 'captured' || provider.status === 'refunded' || provider.amount_refunded > 0) {
      const paid = await this.applyPaid(payment.id, provider.id, actor);
      if (provider.amount_refunded > 0) return this.applyRefund(paid, provider.amount_refunded, actor);
      return paid;
    }
    if (provider.status === 'failed') {
      if (await this.repository.markFailed(payment.id, provider.error_description ?? 'Payment failed')) {
        await this.notifier.paymentFailed(payment);
      }
    }
    return (await this.repository.paymentById(payment.id)) as PaymentRow;
  }

  /** CREATED/FAILED -> PAID once, and the entitlement it buys, in one transaction. */
  async applyPaid(paymentId: string, providerPaymentId: string, actor: Actor, now = new Date()): Promise<PaymentRow> {
    const premiumPlanId = await this.repository.premiumPlanId();
    const outcome = await this.repository.transaction('apply payment', async (tx) => {
      const claimed = await tx.billingPayment.updateMany({
        where: { id: paymentId, status: { in: ['CREATED', 'FAILED', 'EXPIRED'] } },
        data: { status: 'PAID', providerPaymentId, paidAt: now, failureReason: null, lastCheckedAt: now },
      });
      const payment = await tx.billingPayment.findUniqueOrThrow({ where: { id: paymentId } });
      if (claimed.count === 0) return { payment, applied: false };

      let sub = await lockSubscription(tx, payment.organizationId);
      if (!sub) {
        // A customer whose trial row was never created: create it now, paid.
        await tx.subscription.create({
          data: {
            organizationId: payment.organizationId,
            planId: premiumPlanId ?? (await tx.plan.findFirstOrThrow({ select: { id: true } })).id,
            status: 'ACTIVE',
            billingInterval: payment.interval,
            currentPeriodStart: now,
            currentPeriodEnd: now,
          },
        });
        sub = await lockSubscription(tx, payment.organizationId);
      }
      const current = sub!;
      const before = snapshot(current);
      let start = now;
      let end: Date | null = null;
      const data: Record<string, unknown> = {
        status: 'ACTIVE',
        billingInterval: payment.interval,
        planPriceId: payment.planPriceId,
        entitlementDecision: 'PAID',
        decisionReason: `Payment ${payment.receipt}`,
        decisionAt: now,
        decisionBy: actor.ref,
        cancelledAt: null,
        ...(premiumPlanId ? { planId: premiumPlanId } : {}),
      };
      if (payment.interval === 'LIFETIME') {
        data['lifetime'] = true;
      } else {
        // A renewal extends from whichever is later: now, the remaining trial,
        // or the end of the paid period already bought. Paying early never
        // loses days.
        const candidates = [now.getTime()];
        if (current.status === 'TRIAL' && current.trialEndsAt) candidates.push(current.trialEndsAt.getTime());
        if ((current.status === 'ACTIVE' || current.status === 'PAST_DUE') && !current.lifetime) {
          candidates.push(current.currentPeriodEnd.getTime());
        }
        start = new Date(Math.max(...candidates));
        end = periodEnd(start, payment.interval)!;
        data['currentPeriodStart'] = start;
        data['currentPeriodEnd'] = end;
      }
      await tx.subscription.update({ where: { organizationId: payment.organizationId }, data });
      const updated = await tx.billingPayment.update({
        where: { id: paymentId },
        data: { periodStart: start, periodEnd: end },
      });
      await tx.subscriptionChange.create({
        data: {
          organizationId: payment.organizationId,
          action: 'payment.applied',
          actorType: actor.type,
          actorRef: actor.ref,
          reason: `Verified payment ${payment.receipt} (${payment.interval}, ${paiseToAmount(payment.totalAmountPaise)} ${payment.currency})`,
          before: before as object,
          after: { ...before, status: 'ACTIVE', billingInterval: payment.interval, lifetime: payment.interval === 'LIFETIME' || current.lifetime, currentPeriodEnd: end?.toISOString() ?? (before['currentPeriodEnd'] as string), entitlementDecision: 'PAID' } as object,
        },
      });
      return { payment: updated, applied: true };
    });
    this.invalidate(outcome.payment.organizationId);
    if (outcome.applied) await this.notifier.paymentSucceeded(outcome.payment);
    return outcome.payment;
  }

  /**
   * Refund rule (documented on the billing page):
   *   - a partial refund changes no access and is recorded for review;
   *   - a full refund removes what that payment bought: a refunded Lifetime
   *     payment ends Lifetime; a refunded period payment ends paid access now
   *     unless another paid period still covers today, and the subscription is
   *     CANCELLED. Data is never touched.
   */
  async applyRefund(payment: PaymentRow, refundedPaise: number, actor: Actor, now = new Date()): Promise<PaymentRow> {
    if (refundedPaise <= payment.refundedPaise && payment.status !== 'PAID') return payment;
    const full = refundedPaise >= payment.totalAmountPaise;
    const outcome = await this.repository.transaction('apply refund', async (tx) => {
      const updated = await tx.billingPayment.update({
        where: { id: payment.id },
        data: { refundedPaise, status: full ? 'REFUNDED' : 'PARTIALLY_REFUNDED', lastCheckedAt: now },
      });
      if (!full || payment.status === 'REFUNDED') return updated;
      const sub = await lockSubscription(tx, payment.organizationId);
      if (!sub) return updated;
      const before = snapshot(sub);
      const data: Record<string, unknown> = {};
      if (payment.interval === 'LIFETIME') {
        const otherLifetime = await tx.billingPayment.count({
          where: { organizationId: payment.organizationId, interval: 'LIFETIME', status: 'PAID', id: { not: payment.id } },
        });
        if (otherLifetime === 0) data['lifetime'] = false;
      }
      const otherCover = await tx.billingPayment.findFirst({
        where: { organizationId: payment.organizationId, status: 'PAID', id: { not: payment.id }, periodEnd: { gt: now } },
        orderBy: { periodEnd: 'desc' },
      });
      if (payment.interval !== 'LIFETIME' || data['lifetime'] === false) {
        if (otherCover?.periodEnd) {
          data['currentPeriodEnd'] = otherCover.periodEnd;
        } else {
          data['status'] = 'CANCELLED';
          data['cancelledAt'] = now;
          data['currentPeriodEnd'] = now;
        }
      }
      await tx.subscription.update({ where: { organizationId: payment.organizationId }, data });
      await tx.subscriptionChange.create({
        data: {
          organizationId: payment.organizationId,
          action: 'payment.refunded',
          actorType: actor.type,
          actorRef: actor.ref,
          reason: `Full refund of ${payment.receipt}`,
          before: before as object,
          after: { ...before, ...serialise(data) } as object,
        },
      });
      return updated;
    });
    this.invalidate(payment.organizationId);
    return outcome;
  }

  // --- webhook ---------------------------------------------------------------------

  async handleWebhook(eventId: string, body: WebhookBody): Promise<string> {
    const entity = body.payload?.payment?.entity ?? null;
    const refund = body.payload?.refund?.entity ?? null;
    const orderId = entity?.order_id ?? null;
    const payment = orderId
      ? await this.repository.paymentByOrder(orderId)
      : refund?.payment_id
        ? await this.repository.paymentByProviderPayment(refund.payment_id)
        : null;
    const fresh = await this.repository.recordEvent({
      eventId,
      eventType: body.event.slice(0, 60),
      paymentId: payment?.id ?? null,
      outcome: payment ? 'received' : 'not_leadflow',
    });
    if (!fresh) return 'duplicate';
    if (!payment) return 'not_leadflow';

    const actor: Actor = { type: 'payment', ref: `razorpay-webhook:${eventId}` };
    const paymentId = entity?.id ?? refund?.payment_id;
    if (!paymentId) return 'ignored';
    // The event says something happened; Razorpay's current record says what is true.
    const provider = await this.fetchPayment(paymentId);
    await this.settleFromProvider(payment, provider, actor);
    return 'applied';
  }

  // --- reconciliation ---------------------------------------------------------------

  /** Settles orders the browser never confirmed, expires abandoned ones, catches refunds. */
  async reconcile(now = new Date()): Promise<{ checked: number; expired: number }> {
    if (!this.razorpay.configured) return { checked: 0, expired: 0 };
    const expired = await this.repository.expireStale(new Date(now.getTime() - ORDER_EXPIRY_MS));
    const due = await this.repository.paymentsToReconcile(
      new Date(now.getTime() - ORDER_EXPIRY_MS),
      new Date(now.getTime() - 2 * 60_000),
      new Date(now.getTime() - 5 * 60_000),
    );
    let checked = 0;
    for (const payment of due) {
      try {
        const attempts = await this.razorpay.fetchOrderPayments(payment.providerOrderId);
        const captured = attempts.find((p) => p.status === 'captured' || p.status === 'authorized' || p.amount_refunded > 0);
        if (captured) {
          await this.settleFromProvider(payment, captured, { type: 'system', ref: 'reconciliation' });
        } else {
          const failed = attempts.find((p) => p.status === 'failed');
          if (failed && payment.status === 'CREATED') {
            await this.settleFromProvider(payment, failed, { type: 'system', ref: 'reconciliation' });
          }
          await this.repository.touchChecked(payment.id);
        }
        checked += 1;
      } catch (error) {
        this.logger.warn({ paymentId: payment.id, err: describe(error) }, 'Reconciliation check failed; retried later');
      }
    }
    const paid = await this.repository.paidToCheckForRefunds(
      new Date(now.getTime() - 180 * 86_400_000),
      new Date(now.getTime() - 86_400_000),
    );
    for (const payment of paid) {
      try {
        if (!payment.providerPaymentId) continue;
        const provider = await this.razorpay.fetchPayment(payment.providerPaymentId);
        if (provider.amount_refunded > payment.refundedPaise) {
          await this.applyRefund(payment, provider.amount_refunded, { type: 'system', ref: 'reconciliation' });
        } else {
          await this.repository.touchChecked(payment.id);
        }
        checked += 1;
      } catch (error) {
        this.logger.warn({ paymentId: payment.id, err: describe(error) }, 'Refund check failed; retried later');
      }
    }
    return { checked, expired: expired.count };
  }

  /** Re-checks one payment with Razorpay now (admin action). */
  async reconcileOne(paymentId: string, actor: Actor): Promise<PaymentRow> {
    const payment = await this.repository.paymentById(paymentId);
    if (!payment) throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Payment not found.');
    if (!this.razorpay.configured) return payment;
    if (payment.providerPaymentId) {
      return this.settleFromProvider(payment, await this.fetchPayment(payment.providerPaymentId), actor);
    }
    const attempts = await this.razorpay.fetchOrderPayments(payment.providerOrderId);
    const best = attempts.find((p) => p.status === 'captured' || p.status === 'authorized') ?? attempts.find((p) => p.status === 'failed');
    return best ? this.settleFromProvider(payment, best, actor) : payment;
  }

  // --- helpers -----------------------------------------------------------------------

  private async fetchPayment(paymentId: string): Promise<RazorpayPayment> {
    try {
      return await this.razorpay.fetchPayment(paymentId);
    } catch (error) {
      this.logger.error({ err: describe(error) }, 'Could not read a payment from Razorpay');
      throw new AppException(ERROR_CODES.PAYMENT_VERIFICATION_FAILED, 'The payment could not be confirmed yet. It will be checked again shortly.', HttpStatus.BAD_GATEWAY);
    }
  }

  private async requireOrganization(organizationId: string): Promise<OrganizationRow> {
    const org = await this.repository.organization(organizationId);
    if (!org) throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Organization not found.');
    return org;
  }
}

export interface WebhookBody {
  event: string;
  payload?: {
    payment?: { entity?: { id: string; order_id?: string | null } };
    refund?: { entity?: { id: string; payment_id: string; amount: number } };
  };
}

/** The entitlement-relevant fields of a subscription, as plain JSON for the audit trail. */
export function snapshot(sub: {
  status: string;
  billingInterval: string;
  currentPeriodEnd: Date;
  trialEndsAt: Date | null;
  lifetime: boolean;
  complimentaryUntil: Date | null;
  exempt: boolean;
  accessHold: string | null;
  entitlementDecision: string | null;
  plan?: { code: string };
}): Record<string, unknown> {
  return {
    status: sub.status,
    plan: sub.plan?.code ?? null,
    billingInterval: sub.billingInterval,
    currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
    trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
    lifetime: sub.lifetime,
    complimentaryUntil: sub.complimentaryUntil?.toISOString() ?? null,
    exempt: sub.exempt,
    accessHold: sub.accessHold,
    entitlementDecision: sub.entitlementDecision,
  };
}

export function serialise(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]));
}

function describe(error: unknown): string {
  return error instanceof RazorpayError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message.slice(0, 200) : 'unknown';
}
