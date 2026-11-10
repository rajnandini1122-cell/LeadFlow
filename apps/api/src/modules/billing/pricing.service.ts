import { Injectable } from '@nestjs/common';
import { ERROR_CODES, paiseToAmount, taxPaise, type BillingInterval } from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import { BillingRepository, livePriceWhere } from './billing.repository';

const DAY = 86_400_000;
/** Bounds for an administrator-entered price: ₹1 to ₹1,00,000, GST 0–28%. */
export const PRICE_BOUNDS = { minPaise: 100, maxPaise: 10_000_000, maxTaxBp: 2800 } as const;
const INTERVALS: BillingInterval[] = ['MONTHLY', 'YEARLY', 'LIFETIME'];

type Actor = string;

export interface DraftInput {
  interval: BillingInterval;
  baseAmountPaise: number;
  taxRateBp: number;
  effectiveFrom?: string | undefined;
  reason: string;
  expectedLatestVersion: number;
}

/**
 * Pricing management for platform super_admins (through the signed CRAVION
 * Admin API only).
 *
 * Prices are versions, never edits: a change is a DRAFT version that checkout
 * ignores; publishing makes it live from its effective date (now, or a
 * scheduled time). A payment references the exact version it was charged, a
 * created Razorpay order keeps its amount, and a paid entitlement keeps its
 * terms — so nothing already bought or started changes. Every step is in the
 * append-only pricing_changes trail.
 */
@Injectable()
export class PricingService {
  constructor(private readonly repository: BillingRepository) {}

  /** Every plan interval: what is live, what is scheduled, drafts, history, and the change log. */
  async overview(now = new Date()) {
    return this.repository.system('pricing overview', async () => {
      const db = this.repository.client;
      const plans = await db.plan.findMany({
        where: { prices: { some: {} } },
        select: { id: true, code: true, name: true, active: true, maxUsers: true, maxActiveLeads: true },
      });
      const rows = await db.planPrice.findMany({ orderBy: [{ interval: 'asc' }, { version: 'desc' }] });
      const live = await Promise.all(
        INTERVALS.map((interval) =>
          db.planPrice.findFirst({
            where: { ...livePriceWhere(now), interval },
            orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
            select: { id: true },
          }),
        ),
      );
      const liveIds = new Set(live.filter(Boolean).map((r) => r!.id));
      const changes = await db.pricingChange.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
      return {
        generatedAt: now.toISOString(),
        bounds: { minAmount: paiseToAmount(PRICE_BOUNDS.minPaise), maxAmount: paiseToAmount(PRICE_BOUNDS.maxPaise), maxTaxPercent: PRICE_BOUNDS.maxTaxBp / 100 },
        effectiveDatePolicy:
          'A published price applies to orders created at or after its effective date. Orders already created keep their amount; completed payments and paid periods are never changed.',
        plans: plans.map((plan) => ({
          ...plan,
          intervals: INTERVALS.map((interval) => {
            const versions = rows.filter((r) => r.planId === plan.id && r.interval === interval);
            return {
              interval,
              renewal: interval === 'LIFETIME' ? 'NONE' : 'MANUAL',
              latestVersion: versions[0]?.version ?? 0,
              onSale: versions.some((v) => v.status === 'PUBLISHED' && v.active),
              versions: versions.map((v) => ({
                id: v.id,
                version: v.version,
                status: v.status,
                state: liveIds.has(v.id)
                  ? 'LIVE'
                  : v.status === 'PUBLISHED' && v.effectiveFrom > now
                    ? 'SCHEDULED'
                    : v.status === 'PUBLISHED'
                      ? 'SUPERSEDED'
                      : v.status,
                active: v.active,
                currency: v.currency,
                baseAmount: paiseToAmount(v.baseAmountPaise),
                baseAmountPaise: v.baseAmountPaise,
                taxRatePercent: v.taxRateBp / 100,
                taxRateBp: v.taxRateBp,
                taxAmount: paiseToAmount(v.taxAmountPaise),
                totalAmount: paiseToAmount(v.totalAmountPaise),
                taxInclusive: v.taxInclusive,
                effectiveFrom: v.effectiveFrom.toISOString(),
                publishedAt: v.publishedAt?.toISOString() ?? null,
                publishedBy: v.publishedBy,
                createdBy: v.createdBy,
                reason: v.changeReason,
                createdAt: v.createdAt.toISOString(),
              })),
            };
          }),
        })),
        changes: changes.map((c) => ({
          id: c.id,
          interval: c.interval,
          action: c.action,
          actor: c.actorRef,
          reason: c.reason,
          before: c.before,
          after: c.after,
          at: c.createdAt.toISOString(),
        })),
      };
    });
  }

  /** Server-side calculation of what a customer would pay. Pure; changes nothing. */
  preview(input: { interval: BillingInterval; baseAmountPaise: number; taxRateBp: number }) {
    this.validateAmounts(input.baseAmountPaise, input.taxRateBp);
    const tax = taxPaise(input.baseAmountPaise, input.taxRateBp);
    const total = input.baseAmountPaise + tax;
    const per = input.interval === 'MONTHLY' ? '/month' : input.interval === 'YEARLY' ? '/year' : ' once';
    return {
      interval: input.interval,
      baseAmountPaise: input.baseAmountPaise,
      taxAmountPaise: tax,
      totalAmountPaise: total,
      baseAmount: paiseToAmount(input.baseAmountPaise),
      taxAmount: paiseToAmount(tax),
      totalAmount: paiseToAmount(total),
      taxRatePercent: input.taxRateBp / 100,
      customerText: `₹${rupees(input.baseAmountPaise)}${per} + ₹${rupees(tax)} GST (${input.taxRateBp / 100}%) = ₹${rupees(total)}`,
      renewal: input.interval === 'LIFETIME' ? 'One payment, no renewal' : 'Renewed manually',
    };
  }

  async createDraft(input: DraftInput, actor: Actor, now = new Date()) {
    this.validateAmounts(input.baseAmountPaise, input.taxRateBp);
    const reason = this.reason(input.reason);
    const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : now;
    if (Number.isNaN(effectiveFrom.getTime())) throw AppException.validation('effectiveFrom must be an ISO date.');
    if (effectiveFrom.getTime() > now.getTime() + 365 * DAY) throw AppException.validation('effectiveFrom must be within a year.');
    return this.repository.transaction('pricing: create draft', async (tx) => {
      const plan = await tx.plan.findUniqueOrThrow({ where: { code: 'PREMIUM' }, select: { id: true } });
      const latest = await tx.planPrice.findFirst({ where: { planId: plan.id, interval: input.interval }, orderBy: { version: 'desc' } });
      const latestVersion = latest?.version ?? 0;
      if (latestVersion !== input.expectedLatestVersion) {
        throw AppException.conflict(ERROR_CODES.CONFLICT, `Someone else changed ${input.interval} pricing (now at version ${latestVersion}). Reload and try again.`);
      }
      const tax = taxPaise(input.baseAmountPaise, input.taxRateBp);
      // The unique (plan, interval, version) index decides a concurrent race: the loser fails here.
      const row = await tx.planPrice.create({
        data: {
          planId: plan.id,
          interval: input.interval,
          version: latestVersion + 1,
          currency: 'INR',
          baseAmountPaise: input.baseAmountPaise,
          taxRateBp: input.taxRateBp,
          taxInclusive: false,
          taxAmountPaise: tax,
          totalAmountPaise: input.baseAmountPaise + tax,
          renewal: input.interval === 'LIFETIME' ? 'NONE' : 'MANUAL',
          active: true,
          status: 'DRAFT',
          effectiveFrom: new Date(Math.max(effectiveFrom.getTime(), now.getTime())),
          createdBy: actor,
          changeReason: reason,
        },
      });
      await tx.pricingChange.create({
        data: {
          planId: plan.id,
          planPriceId: row.id,
          interval: input.interval,
          action: 'draft.created',
          actorRef: actor,
          reason,
          before: latest ? priceFacts(latest) : {},
          after: priceFacts(row),
        },
      });
      return { id: row.id, version: row.version };
    });
  }

  async publish(priceId: string, input: { reason: string; confirm?: string | undefined }, actor: Actor, now = new Date()) {
    const reason = this.reason(input.reason);
    if (input.confirm !== 'PUBLISH') throw AppException.validation('Type PUBLISH to confirm.', { confirm: ['must be PUBLISH'] });
    return this.repository.transaction('pricing: publish', async (tx) => {
      const draft = await tx.planPrice.findUnique({ where: { id: priceId } });
      if (!draft) throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Price version not found.');
      const effectiveFrom = new Date(Math.max(draft.effectiveFrom.getTime(), now.getTime()));
      // Conditional: two publishers cannot both publish the same draft.
      const done = await tx.planPrice.updateMany({
        where: { id: priceId, status: 'DRAFT' },
        data: { status: 'PUBLISHED', publishedAt: now, publishedBy: actor, effectiveFrom },
      });
      if (done.count === 0) throw AppException.conflict(ERROR_CODES.CONFLICT, 'Only a draft can be published, and this one no longer is.');
      const published = await tx.planPrice.findUniqueOrThrow({ where: { id: priceId } });
      await tx.pricingChange.create({
        data: {
          planId: draft.planId,
          planPriceId: draft.id,
          interval: draft.interval,
          action: effectiveFrom.getTime() > now.getTime() ? 'version.scheduled' : 'version.published',
          actorRef: actor,
          reason,
          before: priceFacts(draft),
          after: priceFacts(published),
        },
      });
      return { id: published.id, version: published.version, effectiveFrom: published.effectiveFrom.toISOString() };
    });
  }

  /** Abandons a draft, or cancels a published version that has not taken effect yet. */
  async discard(priceId: string, input: { reason: string }, actor: Actor, now = new Date()) {
    const reason = this.reason(input.reason);
    return this.repository.transaction('pricing: discard', async (tx) => {
      const row = await tx.planPrice.findUnique({ where: { id: priceId } });
      if (!row) throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Price version not found.');
      const done = await tx.planPrice.updateMany({
        where: {
          id: priceId,
          OR: [{ status: 'DRAFT' }, { status: 'PUBLISHED', effectiveFrom: { gt: now } }],
        },
        data: { status: 'DISCARDED' },
      });
      if (done.count === 0) throw AppException.conflict(ERROR_CODES.CONFLICT, 'A price that is already in effect cannot be withdrawn; publish a new version instead.');
      await tx.pricingChange.create({
        data: {
          planId: row.planId,
          planPriceId: row.id,
          interval: row.interval,
          action: row.status === 'DRAFT' ? 'draft.discarded' : 'schedule.cancelled',
          actorRef: actor,
          reason,
          before: priceFacts(row),
          after: { ...priceFacts(row), status: 'DISCARDED' },
        },
      });
      return { id: row.id, status: 'DISCARDED' };
    });
  }

  /** Takes an interval off sale, or back on. Existing subscriptions and orders are unaffected. */
  async setOnSale(interval: BillingInterval, input: { active: boolean; reason: string; confirm?: string | undefined }, actor: Actor) {
    const reason = this.reason(input.reason);
    if (!input.active && input.confirm !== interval) {
      throw AppException.validation(`Type ${interval} to confirm taking it off sale.`, { confirm: [`must be ${interval}`] });
    }
    return this.repository.transaction('pricing: on sale', async (tx) => {
      const plan = await tx.plan.findUniqueOrThrow({ where: { code: 'PREMIUM' }, select: { id: true } });
      const changed = await tx.planPrice.updateMany({
        where: { planId: plan.id, interval, status: 'PUBLISHED', active: !input.active },
        data: { active: input.active },
      });
      await tx.pricingChange.create({
        data: {
          planId: plan.id,
          interval,
          action: input.active ? 'interval.activated' : 'interval.deactivated',
          actorRef: actor,
          reason,
          before: { onSale: !input.active },
          after: { onSale: input.active, versionsChanged: changed.count },
        },
      });
      return { interval, onSale: input.active, versionsChanged: changed.count };
    });
  }

  private validateAmounts(basePaise: number, taxBp: number): void {
    if (!Number.isInteger(basePaise) || basePaise < PRICE_BOUNDS.minPaise || basePaise > PRICE_BOUNDS.maxPaise) {
      throw AppException.validation(`The base price must be a whole number of paise from ${PRICE_BOUNDS.minPaise} to ${PRICE_BOUNDS.maxPaise}.`);
    }
    if (!Number.isInteger(taxBp) || taxBp < 0 || taxBp > PRICE_BOUNDS.maxTaxBp) {
      throw AppException.validation('The tax rate must be from 0% to 28%, in basis points.');
    }
  }

  private reason(value: string | undefined): string {
    const reason = value?.trim() ?? '';
    if (reason.length < 5) throw AppException.validation('A reason of at least 5 characters is required.', { reason: ['required'] });
    return reason.slice(0, 500);
  }
}

function priceFacts(row: {
  version: number;
  status: string;
  active: boolean;
  baseAmountPaise: number;
  taxRateBp: number;
  taxAmountPaise: number;
  totalAmountPaise: number;
  effectiveFrom: Date;
}) {
  return {
    version: row.version,
    status: row.status,
    active: row.active,
    baseAmountPaise: row.baseAmountPaise,
    taxRateBp: row.taxRateBp,
    taxAmountPaise: row.taxAmountPaise,
    totalAmountPaise: row.totalAmountPaise,
    effectiveFrom: row.effectiveFrom.toISOString(),
  };
}

function rupees(paise: number): string {
  const v = paise / 100;
  return v.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 });
}
