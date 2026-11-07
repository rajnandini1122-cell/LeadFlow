import { createHmac } from 'node:crypto';
import {
  ERROR_CODES,
  TRIAL_DAYS,
  daysRemaining,
  evaluateEntitlement,
  periodEnd,
  taxPaise,
  type EntitlementFacts,
} from '@leadflow/api-types';
import { PRICE_CATALOGUE } from '../subscriptions/plan-catalogue';
import { checkoutSignatureValid, webhookSignatureValid } from './razorpay.client';
import { SubscriptionGuard, isOpenAfterExpiry } from './subscription.guard';

const NOW = new Date('2026-11-07T10:00:00.000Z');
const DAY = 86_400_000;

function facts(sub: Partial<NonNullable<EntitlementFacts['subscription']>> | null, org: Partial<EntitlementFacts> = {}): EntitlementFacts {
  return {
    organizationType: 'CUSTOMER',
    organizationStatus: 'ACTIVE',
    deleted: false,
    ...org,
    subscription:
      sub === null
        ? null
        : {
            status: 'TRIAL',
            trialEndsAt: new Date(NOW.getTime() + DAY),
            currentPeriodEnd: new Date(NOW.getTime() + DAY),
            lifetime: false,
            complimentaryUntil: null,
            exempt: false,
            accessHold: null,
            entitlementDecision: 'NEW_TRIAL',
            ...sub,
          },
  };
}

describe('entitlement rule', () => {
  it('a trial grants access until the instant it ends, and not a millisecond after', () => {
    const end = new Date(NOW.getTime() + 1);
    expect(evaluateEntitlement(facts({ trialEndsAt: end }), NOW)).toMatchObject({ state: 'TRIALING', grantsAccess: true });
    expect(evaluateEntitlement(facts({ trialEndsAt: end }), end)).toMatchObject({ state: 'EXPIRED', grantsAccess: false });
  });

  it('the CRAVION INTERNAL organization is exempt whatever its subscription says', () => {
    const r = evaluateEntitlement(facts({ status: 'EXPIRED', trialEndsAt: new Date(0) }, { organizationType: 'INTERNAL' }), NOW);
    expect(r).toMatchObject({ state: 'EXEMPT', grantsAccess: true, accessEndsAt: null });
    expect(evaluateEntitlement(facts(null, { organizationType: 'INTERNAL' }), NOW).state).toBe('EXEMPT');
  });

  it('existing organizations PENDING_REVIEW keep access even with a trial long expired', () => {
    const r = evaluateEntitlement(facts({ status: 'TRIAL', trialEndsAt: new Date('2026-10-01'), entitlementDecision: 'PENDING_REVIEW' }), NOW);
    expect(r).toMatchObject({ state: 'PENDING_REVIEW', grantsAccess: true });
  });

  it('a suspension or deactivation outranks every entitlement, Lifetime and exemption included', () => {
    expect(evaluateEntitlement(facts({ lifetime: true, accessHold: 'SUSPENDED' }), NOW).grantsAccess).toBe(false);
    expect(evaluateEntitlement(facts({ exempt: true }, { organizationStatus: 'SUSPENDED' }), NOW).state).toBe('SUSPENDED');
    expect(evaluateEntitlement(facts({ status: 'ACTIVE', accessHold: 'DEACTIVATED' }), NOW).state).toBe('DEACTIVATED');
  });

  it('paid access runs to the period end, then 3 days PAST_DUE, then EXPIRED', () => {
    const end = new Date(NOW.getTime() - DAY);
    const sub = { status: 'ACTIVE' as const, currentPeriodEnd: end, entitlementDecision: 'PAID' };
    expect(evaluateEntitlement(facts({ ...sub, currentPeriodEnd: new Date(NOW.getTime() + DAY) }), NOW).state).toBe('ACTIVE');
    expect(evaluateEntitlement(facts(sub), NOW)).toMatchObject({ state: 'PAST_DUE', grantsAccess: true });
    expect(evaluateEntitlement(facts(sub), new Date(end.getTime() + 3 * DAY))).toMatchObject({ state: 'EXPIRED', grantsAccess: false });
  });

  it('Lifetime and complimentary grant access; a revoked complimentary falls back to the trial rule', () => {
    expect(evaluateEntitlement(facts({ lifetime: true, status: 'ACTIVE', currentPeriodEnd: new Date(0) }), NOW).state).toBe('LIFETIME');
    expect(evaluateEntitlement(facts({ status: 'EXPIRED', trialEndsAt: new Date(0), complimentaryUntil: new Date(NOW.getTime() + DAY) }), NOW).state).toBe('COMPLIMENTARY');
    expect(evaluateEntitlement(facts({ status: 'EXPIRED', trialEndsAt: new Date(0), complimentaryUntil: null }), NOW).grantsAccess).toBe(false);
  });

  it('a customer with no subscription row is not locked out', () => {
    expect(evaluateEntitlement(facts(null), NOW)).toMatchObject({ state: 'PENDING_REVIEW', grantsAccess: true });
  });

  it('days remaining round up, and the trial is exactly 30 days', () => {
    expect(TRIAL_DAYS).toBe(30);
    expect(daysRemaining(new Date(NOW.getTime() + 23 * 3_600_000), NOW)).toBe(1);
    expect(daysRemaining(new Date(NOW.getTime() + 30 * DAY), NOW)).toBe(30);
    expect(daysRemaining(null, NOW)).toBeNull();
  });
});

describe('periods and prices', () => {
  it('a month is a calendar month in UTC, clamped at month end; a year likewise', () => {
    expect(periodEnd(new Date('2026-01-31T12:00:00Z'), 'MONTHLY')!.toISOString()).toBe('2026-02-28T12:00:00.000Z');
    expect(periodEnd(new Date('2028-01-31T00:00:00Z'), 'MONTHLY')!.toISOString()).toBe('2028-02-29T00:00:00.000Z');
    expect(periodEnd(new Date('2026-11-07T10:00:00Z'), 'MONTHLY')!.toISOString()).toBe('2026-12-07T10:00:00.000Z');
    expect(periodEnd(new Date('2028-02-29T00:00:00Z'), 'YEARLY')!.toISOString()).toBe('2029-02-28T00:00:00.000Z');
    expect(periodEnd(NOW, 'LIFETIME')).toBeNull();
  });

  it('the approved prices: base + 18% GST = 236.00, 2,100.40 and 5,900.00 rupees', () => {
    const totals = Object.fromEntries(
      PRICE_CATALOGUE.map((p) => [p.interval, p.basePaise + taxPaise(p.basePaise, p.taxRateBp)]),
    );
    expect(totals).toEqual({ MONTHLY: 23_600, YEARLY: 210_040, LIFETIME: 590_000 });
    expect(PRICE_CATALOGUE.every((p) => p.currency === 'INR' && p.taxRateBp === 1800 && !p.taxInclusive)).toBe(true);
    expect(PRICE_CATALOGUE.find((p) => p.interval === 'LIFETIME')?.renewal).toBe('NONE');
  });
});

describe('Razorpay signatures', () => {
  const secret = 'test_key_secret';
  it('accepts exactly Razorpay checkout signatures and rejects forgeries', () => {
    const good = createHmac('sha256', secret).update('order_ABC123|pay_XYZ789').digest('hex');
    expect(checkoutSignatureValid('order_ABC123', 'pay_XYZ789', good, secret)).toBe(true);
    expect(checkoutSignatureValid('order_ABC123', 'pay_OTHER1', good, secret)).toBe(false);
    expect(checkoutSignatureValid('order_ABC123', 'pay_XYZ789', good, 'another')).toBe(false);
    expect(checkoutSignatureValid('order_ABC123', 'pay_XYZ789', good.slice(0, 63), secret)).toBe(false);
  });

  it('verifies the webhook over the raw body; any change to the body fails', () => {
    const body = Buffer.from('{"event":"payment.captured"}');
    const sig = createHmac('sha256', 'whsec').update(body).digest('hex');
    expect(webhookSignatureValid(body, sig, 'whsec')).toBe(true);
    expect(webhookSignatureValid(Buffer.from('{"event":"payment.captured" }'), sig, 'whsec')).toBe(false);
  });
});

describe('what stays open after expiry', () => {
  it.each([
    ['/api/v1/auth/login', true],
    ['/api/v1/billing/summary', true],
    ['/api/v1/billing/razorpay/webhook', true],
    ['/api/v1/subscriptions/current', true],
    ['/api/v1/users/me', true],
    ['/api/v1/notifications', true],
    ['/api/v1/contact', true],
    ['/health', true],
    ['/api/v1/leads', false],
    ['/api/v1/leads/123/contacts', false],
    ['/api/v1/follow-ups', false],
    ['/api/v1/users', false],
    ['/api/v1/users/abc', false],
    ['/api/v1/reports/daily', false],
    ['/api/v1/billingx', false],
  ])('%s -> %s', (path, open) => {
    expect(isOpenAfterExpiry(path)).toBe(open);
  });
});

describe('SubscriptionGuard', () => {
  const ctx = (path: string) =>
    ({
      getType: () => 'http',
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ originalUrl: path }) }),
    }) as never;
  const make = (role: string, grantsAccess: boolean, enabled = true) =>
    new SubscriptionGuard(
      { getAllAndOverride: () => false } as never,
      { principal: { role, organizationId: 'o1' } } as never,
      { entitlement: async () => ({ state: grantsAccess ? 'TRIALING' : 'EXPIRED', grantsAccess, accessEndsAt: null }) } as never,
      { get: () => enabled } as never,
    );

  it('refuses a tenant OWNER or ADMIN of an expired organization with 402', async () => {
    for (const role of ['OWNER', 'ADMIN', 'SALES_REP']) {
      await expect(make(role, false).canActivate(ctx('/api/v1/leads'))).rejects.toMatchObject({
        code: ERROR_CODES.SUBSCRIPTION_REQUIRED,
        status: 402,
      });
    }
  });

  it('never bills a PLATFORM_OWNER (CRAVION platform super_admin)', async () => {
    await expect(make('PLATFORM_OWNER', false).canActivate(ctx('/api/v1/leads'))).resolves.toBe(true);
  });

  it('keeps billing reachable after expiry, and enforces nothing when switched off', async () => {
    await expect(make('OWNER', false).canActivate(ctx('/api/v1/billing/checkout'))).resolves.toBe(true);
    await expect(make('OWNER', false, false).canActivate(ctx('/api/v1/leads'))).resolves.toBe(true);
    await expect(make('OWNER', true).canActivate(ctx('/api/v1/leads'))).resolves.toBe(true);
  });
});
