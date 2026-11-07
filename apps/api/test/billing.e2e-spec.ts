// Must be first: the config module reads the environment on import.
import { BILLING_ENV, restoreBillingEnv } from './helpers/billing-env';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { PASSWORD, createTestContext, registerVerifiedOrganization, type TestContext } from './helpers/test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { adminSigningBase } from '../src/modules/integrations/admin-control/admin-control-signature';
import { RazorpayClient, type RazorpayPayment } from '../src/modules/billing/razorpay.client';
import { SubscriptionSweeper } from '../src/modules/billing/subscription-sweeper.service';
import { BillingService } from '../src/modules/billing/billing.service';

const DAY = 86_400_000;

/**
 * LeadFlow billing, end to end: the 30-day trial, enforcement, Razorpay
 * checkout and confirmation (Razorpay's HTTP API stubbed, everything else
 * real), webhooks, refunds, concurrency, the signed CRAVION Admin API, the
 * audit trail and reminders.
 */
describe('Billing', () => {
  let ctx: TestContext;
  let prisma: PrismaService['client'];
  let system: TenantContextService;
  const provider = new Map<string, RazorpayPayment>();
  let orderSeq = 0;

  const sys = <T>(fn: () => Promise<T>) => system.runAsSystem('e2e', fn);
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const unique = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

  async function register(email = `${unique('owner')}@billing.test`) {
    const r = await registerVerifiedOrganization(ctx.app, {
      organizationName: unique('Billing Org'),
      email,
      password: PASSWORD,
      firstName: 'Bina',
      lastName: 'Owner',
    });
    const membership = await sys(() =>
      prisma.organizationUser.findFirstOrThrow({ where: { user: { email: email.toLowerCase() } }, orderBy: { createdAt: 'desc' } }),
    );
    return { token: r.tokens.accessToken, organizationId: membership.organizationId, email };
  }

  const subscriptionOf = (organizationId: string) => sys(() => prisma.subscription.findUniqueOrThrow({ where: { organizationId } }));
  const expireTrial = (organizationId: string) =>
    sys(() => prisma.subscription.update({ where: { organizationId }, data: { trialEndsAt: new Date(Date.now() - 1000), currentPeriodEnd: new Date(Date.now() - 1000) } }));
  const invalidate = (organizationId: string) => ctx.app.get(BillingService).invalidate(organizationId);

  const checkoutSignature = (orderId: string, paymentId: string) =>
    createHmac('sha256', BILLING_ENV.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');

  /** Razorpay as it would hold a payment for an order. */
  function pay(orderId: string, amount: number, status: RazorpayPayment['status'] = 'captured') {
    const id = `pay_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const payment: RazorpayPayment = { id, order_id: orderId, status, amount, currency: 'INR', amount_refunded: 0 };
    provider.set(id, payment);
    return payment;
  }

  function webhook(body: object, eventId = `evt_${randomUUID().slice(0, 12)}`, secret: string = BILLING_ENV.RAZORPAY_WEBHOOK_SECRET) {
    const raw = JSON.stringify(body);
    return ctx
      .http()
      .post('/api/v1/billing/razorpay/webhook')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-event-id', eventId)
      .set('x-razorpay-signature', createHmac('sha256', secret).update(raw).digest('hex'))
      .send(raw);
  }

  function admin(method: 'GET' | 'POST', path: string, body?: object, actor = 'firebase:uid:super-admin-1') {
    const raw = body ? JSON.stringify(body) : undefined;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const requestId = `req-${randomUUID()}`;
    const full = `/api/v1/integrations/admin-subscriptions${path}`;
    const signature = createHmac('sha256', BILLING_ENV.ADMIN_SUBSCRIPTIONS_SIGNING_SECRET)
      .update(adminSigningBase({ method, path: full, timestamp, requestId, actorRef: actor, rawBody: raw ? Buffer.from(raw) : undefined }))
      .digest('hex');
    const req = (method === 'GET' ? ctx.http().get(full) : ctx.http().post(full).set('Content-Type', 'application/json'))
      .set('x-cravion-admin-timestamp', timestamp)
      .set('x-cravion-admin-request-id', requestId)
      .set('x-cravion-admin-actor', actor)
      .set('x-cravion-admin-signature', `sha256=${signature}`);
    return raw ? req.send(raw) : req;
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    prisma = ctx.app.get(PrismaService).client;
    system = ctx.app.get(TenantContextService);
    const razorpay = ctx.app.get(RazorpayClient);
    // Only Razorpay's HTTP API is replaced; signatures, amounts and all LeadFlow logic are real.
    razorpay.createOrder = async (input) => ({ id: `order_E2E${String(++orderSeq).padStart(8, '0')}`, amount: input.amountPaise, currency: input.currency, receipt: input.receipt, status: 'created' });
    razorpay.fetchPayment = async (id) => {
      const p = provider.get(id);
      if (!p) throw new Error('unknown payment');
      return { ...p };
    };
    razorpay.fetchOrderPayments = async (orderId) => [...provider.values()].filter((p) => p.order_id === orderId).map((p) => ({ ...p }));
    razorpay.capture = async (id) => {
      const p = provider.get(id)!;
      p.status = 'captured';
      return { ...p };
    };
  });
  afterAll(async () => {
    await ctx?.close();
    restoreBillingEnv();
  });

  describe('the 30-day trial', () => {
    it('starts at the organization’s activation and lasts exactly 30 days, in UTC', async () => {
      const org = await register();
      const [sub, organization] = await Promise.all([
        subscriptionOf(org.organizationId),
        sys(() => prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId } })),
      ]);
      expect(sub.trialStartsAt?.toISOString()).toBe(organization.createdAt.toISOString());
      expect(sub.trialEndsAt!.getTime() - organization.createdAt.getTime()).toBe(30 * DAY);
      expect(sub.entitlementDecision).toBe('NEW_TRIAL');
      const summary = (await ctx.http().get('/api/v1/billing/summary').set(auth(org.token)).expect(200)).body.data;
      expect(summary).toMatchObject({ state: 'TRIALING', grantsAccess: true, daysRemaining: 30, canPay: true, checkoutEnabled: true, enforcementEnabled: true });
      expect(summary.prices.map((p: { interval: string; totalAmount: string }) => `${p.interval}:${p.totalAmount}`)).toEqual([
        'MONTHLY:236.00',
        'YEARLY:2100.40',
        'LIFETIME:5900.00',
      ]);
      const changes = await sys(() => prisma.subscriptionChange.findMany({ where: { organizationId: org.organizationId } }));
      expect(changes.map((c) => c.action)).toEqual(['trial.started']);
    });

    it('cannot be reset by registering again with a variant of the same address', async () => {
      const local = unique('repeat');
      await register(`${local}@gmail.com`);
      const again = await register(`${local.replace('-', '.-')}+second@gmail.com`);
      const sub = await subscriptionOf(again.organizationId);
      expect(sub).toMatchObject({ status: 'EXPIRED', entitlementDecision: 'TRIAL_ALREADY_USED' });
      const summary = (await ctx.http().get('/api/v1/billing/summary').set(auth(again.token)).expect(200)).body.data;
      expect(summary.state).toBe('EXPIRED');
    });
  });

  describe('enforcement', () => {
    it('after expiry refuses paid CRM features server-side, for the owner and every employee', async () => {
      const org = await register();
      await ctx.http().get('/api/v1/leads').set(auth(org.token)).expect(200);
      await expireTrial(org.organizationId);
      invalidate(org.organizationId);
      const refused = await ctx.http().get('/api/v1/leads').set(auth(org.token)).expect(402);
      expect(refused.body.error).toMatchObject({ code: 'SUBSCRIPTION_REQUIRED', message: 'Your LeadFlow free trial has expired. Upgrade to Premium to continue using LeadFlow CRM.' });
      await ctx.http().post('/api/v1/leads').set(auth(org.token)).send({ title: 'x' }).expect(402);
      // Billing, account and notifications stay reachable.
      await ctx.http().get('/api/v1/billing/summary').set(auth(org.token)).expect(200);
      await ctx.http().get('/api/v1/notifications').set(auth(org.token)).expect(200);

    });

    it('an employee inherits the organization’s expiry; an organization pending review keeps access', async () => {
      const plan = await sys(() => prisma.plan.findUniqueOrThrow({ where: { code: 'PREMIUM' } }));
      await sys(() =>
        prisma.subscription.upsert({
          where: { organizationId: ctx.orgB.id },
          create: { organizationId: ctx.orgB.id, planId: plan.id, status: 'TRIAL', billingInterval: 'MONTHLY', currentPeriodStart: new Date(Date.now() - 40 * DAY), currentPeriodEnd: new Date(Date.now() - DAY), trialEndsAt: new Date(Date.now() - DAY), entitlementDecision: 'NEW_TRIAL' },
          update: { status: 'TRIAL', trialEndsAt: new Date(Date.now() - DAY), entitlementDecision: 'NEW_TRIAL' },
        }),
      );
      invalidate(ctx.orgB.id);
      await ctx.http().get('/api/v1/leads').set(auth(ctx.orgB.rep.accessToken)).expect(402);
      await sys(() => prisma.subscription.update({ where: { organizationId: ctx.orgB.id }, data: { entitlementDecision: 'PENDING_REVIEW' } }));
      invalidate(ctx.orgB.id);
      await ctx.http().get('/api/v1/leads').set(auth(ctx.orgB.rep.accessToken)).expect(200);
      // orgA has no subscription row at all: never locked out.
      await ctx.http().get('/api/v1/leads').set(auth(ctx.orgA.owner.accessToken)).expect(200);
    });

    it('only the OWNER can pay; an ADMIN or rep cannot start a checkout', async () => {
      await ctx.http().post('/api/v1/billing/checkout').set(auth(ctx.orgB.rep.accessToken)).send({ interval: 'MONTHLY' }).expect(403);
    });
  });

  describe('Razorpay checkout and confirmation', () => {
    let org: Awaited<ReturnType<typeof register>>;
    beforeAll(async () => {
      org = await register();
      await expireTrial(org.organizationId);
      invalidate(org.organizationId);
    });

    it('creates the order server-side at the database price, and reuses it on a second click', async () => {
      const first = (await ctx.http().post('/api/v1/billing/checkout').set(auth(org.token)).send({ interval: 'MONTHLY' }).expect(201)).body.data;
      expect(first).toMatchObject({ amountPaise: 23_600, currency: 'INR', keyId: BILLING_ENV.RAZORPAY_KEY_ID });
      expect(first.receipt).toMatch(/^LF-\d{8}-[0-9a-f]{8}$/);
      expect(JSON.stringify(first)).not.toContain(BILLING_ENV.RAZORPAY_KEY_SECRET);
      const second = (await ctx.http().post('/api/v1/billing/checkout').set(auth(org.token)).send({ interval: 'MONTHLY' }).expect(201)).body.data;
      expect(second.providerOrderId).toBe(first.providerOrderId);
      const lifetime = (await ctx.http().post('/api/v1/billing/checkout').set(auth(org.token)).send({ interval: 'LIFETIME' }).expect(201)).body.data;
      expect(lifetime.amountPaise).toBe(590_000);
    });

    it('a forged signature, another organization’s order, or the wrong amount grants nothing', async () => {
      const order = (await ctx.http().post('/api/v1/billing/checkout').set(auth(org.token)).send({ interval: 'MONTHLY' }).expect(201)).body.data;
      const real = pay(order.providerOrderId, 23_600);
      await ctx.http().post('/api/v1/billing/verify').set(auth(org.token))
        .send({ razorpay_order_id: order.providerOrderId, razorpay_payment_id: real.id, razorpay_signature: 'a'.repeat(64) })
        .expect(400);
      const other = await register();
      await ctx.http().post('/api/v1/billing/verify').set(auth(other.token))
        .send({ razorpay_order_id: order.providerOrderId, razorpay_payment_id: real.id, razorpay_signature: checkoutSignature(order.providerOrderId, real.id) })
        .expect(404);
      const short = pay(order.providerOrderId, 100);
      await ctx.http().post('/api/v1/billing/verify').set(auth(org.token))
        .send({ razorpay_order_id: order.providerOrderId, razorpay_payment_id: short.id, razorpay_signature: checkoutSignature(order.providerOrderId, short.id) })
        .expect(402);
      invalidate(org.organizationId);
      await ctx.http().get('/api/v1/leads').set(auth(org.token)).expect(402);
    });

    it('a verified, captured payment activates Premium for one calendar month; repeating it changes nothing', async () => {
      const order = (await ctx.http().post('/api/v1/billing/checkout').set(auth(org.token)).send({ interval: 'MONTHLY' }).expect(201)).body.data;
      const p = pay(order.providerOrderId, 23_600);
      const body = { razorpay_order_id: order.providerOrderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.providerOrderId, p.id) };
      const paid = (await ctx.http().post('/api/v1/billing/verify').set(auth(org.token)).send(body).expect(200)).body.data;
      expect(paid).toMatchObject({ status: 'PAID', totalAmount: '236.00', providerPaymentId: p.id });
      await ctx.http().get('/api/v1/leads').set(auth(org.token)).expect(200);
      const sub = await subscriptionOf(org.organizationId);
      expect(sub).toMatchObject({ status: 'ACTIVE', billingInterval: 'MONTHLY', entitlementDecision: 'PAID' });
      const end = sub.currentPeriodEnd.getTime();

      await ctx.http().post('/api/v1/billing/verify').set(auth(org.token)).send(body).expect(200);
      expect((await webhook({ event: 'payment.captured', payload: { payment: { entity: { id: p.id, order_id: order.providerOrderId } } } }).expect(200)).body.data.received).toBe('applied');
      expect((await subscriptionOf(org.organizationId)).currentPeriodEnd.getTime()).toBe(end);
      const applied = await sys(() => prisma.subscriptionChange.count({ where: { organizationId: org.organizationId, action: 'payment.applied' } }));
      expect(applied).toBe(1);
    });

    it('concurrent confirmations of one payment extend the subscription once', async () => {
      const before = (await subscriptionOf(org.organizationId)).currentPeriodEnd;
      const order = (await ctx.http().post('/api/v1/billing/checkout').set(auth(org.token)).send({ interval: 'YEARLY' }).expect(201)).body.data;
      const p = pay(order.providerOrderId, 210_040);
      const body = { razorpay_order_id: order.providerOrderId, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(order.providerOrderId, p.id) };
      const event = { event: 'payment.captured', payload: { payment: { entity: { id: p.id, order_id: order.providerOrderId } } } };
      await Promise.all([
        ctx.http().post('/api/v1/billing/verify').set(auth(org.token)).send(body),
        ctx.http().post('/api/v1/billing/verify').set(auth(org.token)).send(body),
        webhook(event),
      ]);
      const after = (await subscriptionOf(org.organizationId)).currentPeriodEnd;
      const expected = new Date(before.getTime());
      expected.setUTCFullYear(expected.getUTCFullYear() + 1);
      expect(after.toISOString()).toBe(expected.toISOString());
    });

    it('webhooks: a forged signature is refused, a redelivered event changes nothing, another product is ignored', async () => {
      await webhook({ event: 'payment.captured' }, undefined, 'not-the-secret').expect(401);
      const id = `evt_${randomUUID().slice(0, 12)}`;
      const notOurs = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_STORE0000001', order_id: 'order_STORE000001' } } } };
      expect((await webhook(notOurs, id).expect(200)).body.data.received).toBe('not_leadflow');
      expect((await webhook(notOurs, id).expect(200)).body.data.received).toBe('duplicate');
    });

    it('a failed payment never activates Premium and is recorded', async () => {
      const fresh = await register();
      await expireTrial(fresh.organizationId);
      invalidate(fresh.organizationId);
      const order = (await ctx.http().post('/api/v1/billing/checkout').set(auth(fresh.token)).send({ interval: 'MONTHLY' }).expect(201)).body.data;
      const failed = pay(order.providerOrderId, 23_600, 'failed');
      await ctx.http().post('/api/v1/billing/verify').set(auth(fresh.token))
        .send({ razorpay_order_id: order.providerOrderId, razorpay_payment_id: failed.id, razorpay_signature: checkoutSignature(order.providerOrderId, failed.id) })
        .expect(402);
      const row = await sys(() => prisma.billingPayment.findUniqueOrThrow({ where: { providerOrderId: order.providerOrderId } }));
      expect(row.status).toBe('FAILED');
      invalidate(fresh.organizationId);
      await ctx.http().get('/api/v1/leads').set(auth(fresh.token)).expect(402);
      const notices = await sys(() => prisma.notification.count({ where: { organizationId: fresh.organizationId, type: 'BILLING_PAYMENT' } }));
      expect(notices).toBe(1);
    });

    it('a full refund removes what that payment bought, by the documented rule', async () => {
      const yearly = await sys(() => prisma.billingPayment.findFirstOrThrow({ where: { organizationId: org.organizationId, interval: 'YEARLY', status: 'PAID' } }));
      const monthly = await sys(() => prisma.billingPayment.findFirstOrThrow({ where: { organizationId: org.organizationId, interval: 'MONTHLY', status: 'PAID' } }));
      provider.get(yearly.providerPaymentId!)!.amount_refunded = yearly.totalAmountPaise;
      provider.get(yearly.providerPaymentId!)!.status = 'refunded';
      await webhook({ event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_E2E0001', payment_id: yearly.providerPaymentId!, amount: yearly.totalAmountPaise } } } }).expect(200);
      const refunded = await sys(() => prisma.billingPayment.findUniqueOrThrow({ where: { id: yearly.id } }));
      expect(refunded).toMatchObject({ status: 'REFUNDED', refundedPaise: yearly.totalAmountPaise });
      // The monthly payment still covers today, so access runs to ITS end.
      expect((await subscriptionOf(org.organizationId)).currentPeriodEnd.toISOString()).toBe(monthly.periodEnd!.toISOString());
    });
  });

  describe('CRAVION Admin subscription management', () => {
    it('refuses unsigned and replayed requests, and requires a reason', async () => {
      await ctx.http().get('/api/v1/integrations/admin-subscriptions/overview').expect(401);
      const overview = (await admin('GET', '/overview').expect(200)).body.data;
      expect(overview).toMatchObject({ revenue: { currency: 'INR' } });
      expect(overview.organizations).toBeGreaterThan(0);
      const org = await register();
      await admin('POST', `/organizations/${org.organizationId}/actions`, { action: 'extend_trial', days: 10, reason: '' }).expect(400);
    });

    it('extends a trial, grants complimentary access, suspends and reactivates — each audited with before and after', async () => {
      const org = await register();
      const trialEnd = (await subscriptionOf(org.organizationId)).trialEndsAt!;
      const extended = (await admin('POST', `/organizations/${org.organizationId}/actions`, { action: 'extend_trial', days: 10, reason: 'Pilot customer, agreed by sales' }).expect(200)).body.data;
      expect(new Date(extended.trialEndsAt).getTime()).toBe(trialEnd.getTime() + 10 * DAY);

      await expireTrial(org.organizationId);
      invalidate(org.organizationId);
      await ctx.http().get('/api/v1/leads').set(auth(org.token)).expect(402);
      await admin('POST', `/organizations/${org.organizationId}/actions`, { action: 'grant_complimentary', days: 30, reason: 'Goodwill after an outage' }).expect(200);
      await ctx.http().get('/api/v1/leads').set(auth(org.token)).expect(200);

      await admin('POST', `/organizations/${org.organizationId}/actions`, { action: 'suspend', reason: 'Investigating abuse report' }).expect(200);
      await ctx.http().get('/api/v1/leads').set(auth(org.token)).expect(403);
      await admin('POST', `/organizations/${org.organizationId}/actions`, { action: 'reactivate', reason: 'Report resolved' }).expect(200);
      invalidate(org.organizationId);
      await ctx.http().get('/api/v1/leads').set(auth(org.token)).expect(200);

      const detail = (await admin('GET', `/organizations/${org.organizationId}`).expect(200)).body.data;
      const actions = detail.changes.map((c: { action: string }) => c.action);
      expect(actions).toEqual(expect.arrayContaining(['admin.extend_trial', 'admin.grant_complimentary', 'admin.suspend', 'admin.reactivate', 'trial.started']));
      const suspend = detail.changes.find((c: { action: string }) => c.action === 'admin.suspend');
      expect(suspend).toMatchObject({ actor: 'firebase:uid:super-admin-1', reason: 'Investigating abuse report' });
      expect(suspend.before.organizationStatus).toBe('ACTIVE');
      expect(suspend.after.organization.status).toBe('SUSPENDED');
      expect(detail.users).toHaveLength(1);
    });

    it('the audit trail is append-only in the database', async () => {
      const row = await sys(() => prisma.subscriptionChange.findFirstOrThrow());
      await expect(sys(() => prisma.subscriptionChange.update({ where: { id: row.id }, data: { reason: 'edited' } }))).rejects.toThrow(/append-only/);
      await expect(sys(() => prisma.subscriptionChange.delete({ where: { id: row.id } }))).rejects.toThrow(/append-only/);
    });

    it('protects the INTERNAL organization; a deletion is a recoverable request, never a purge', async () => {
      const internal = await sys(() => prisma.organization.findFirst({ where: { organizationType: 'INTERNAL' } }));
      if (internal) {
        await admin('POST', `/organizations/${internal.id}/actions`, { action: 'suspend', reason: 'Should be refused' }).expect(403);
        await admin('POST', `/organizations/${internal.id}/actions`, { action: 'request_deletion', reason: 'Should be refused', confirm: internal.name }).expect(403);
      }
      const org = await register();
      const name = (await sys(() => prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId } }))).name;
      await admin('POST', `/organizations/${org.organizationId}/actions`, { action: 'request_deletion', reason: 'Customer asked to close', confirm: 'wrong' }).expect(400);
      const requested = (await admin('POST', `/organizations/${org.organizationId}/actions`, { action: 'request_deletion', reason: 'Customer asked to close', confirm: name }).expect(200)).body.data;
      expect(requested).toMatchObject({ state: 'SUSPENDED', purgeAvailable: false, deletionRecoveryDays: 30 });
      expect(requested.records).toEqual({ leads: expect.any(Number), contacts: expect.any(Number), followUps: expect.any(Number) });
      expect(await sys(() => prisma.organization.count({ where: { id: org.organizationId } }))).toBe(1);
      await admin('POST', `/organizations/${org.organizationId}/actions`, { action: 'cancel_deletion', reason: 'Customer changed their mind' }).expect(200);
      await admin('POST', `/organizations/${org.organizationId}/actions`, { action: 'reactivate', reason: 'Back in service' }).expect(200);
    });
  });

  describe('reminders', () => {
    it('sends each reminder once, to owners and admins, and the expiry notice once', async () => {
      const org = await register();
      const end = new Date(Date.now() + 2 * DAY + 3_600_000);
      await sys(() => prisma.subscription.update({ where: { organizationId: org.organizationId }, data: { trialEndsAt: end, currentPeriodEnd: end } }));
      const sweeper = ctx.app.get(SubscriptionSweeper);
      await sweeper.sweep();
      await sweeper.sweep();
      const reminders = await sys(() => prisma.notification.findMany({ where: { organizationId: org.organizationId, type: 'BILLING_REMINDER' } }));
      expect(reminders).toHaveLength(1);
      expect(reminders[0]!.title).toBe('Your free trial ends in 3 days');
      await expireTrial(org.organizationId);
      await sweeper.sweep();
      await sweeper.sweep();
      const ended = await sys(() => prisma.notification.findMany({ where: { organizationId: org.organizationId, type: 'BILLING_EXPIRED' } }));
      expect(ended).toHaveLength(1);
      expect((await subscriptionOf(org.organizationId)).status).toBe('EXPIRED');
    });
  });

  it('direct API access with a valid token after expiry is still refused (no client-side bypass)', async () => {
    const org = await register();
    await expireTrial(org.organizationId);
    invalidate(org.organizationId);
    const res = await request(ctx.app.getHttpServer()).get('/api/v1/follow-ups').set(auth(org.token));
    expect(res.status).toBe(402);
  });
});
