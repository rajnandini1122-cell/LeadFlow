import { ERROR_CODES } from '@leadflow/api-types';
import { createTestContext, PASSWORD, type TestContext } from './helpers/test-app';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { SubscriptionsService } from '../src/modules/subscriptions/subscriptions.service';

/**
 * Phase 8 — the subscription domain foundation.
 *
 * Two properties matter more than the rest:
 *
 *   1. The plan catalogue is PUBLIC and must leak nothing about any tenant. It
 *      is the one authenticated-app endpoint deliberately reachable without a
 *      token, so it is also the one most worth checking returns only catalogue
 *      data.
 *
 *   2. A subscription is money. An organization must never see or alter
 *      another's, and — critically — must not be able to declare ITSELF paid.
 *      Only a payment provider can know that, so `status` is not a field a
 *      client may send.
 */
describe('Subscriptions', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const unique = (prefix: string): string =>
    `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`;

  const freshOrg = async (): Promise<{ token: string; organizationId: string }> => {
    const response = await ctx
      .http()
      .post('/api/v1/auth/register')
      .send({
        organizationName: `Billing ${unique('org')}`,
        email: `${unique('founder')}@example.test`,
        password: PASSWORD,
        firstName: 'Bill',
        lastName: 'Payer',
      })
      .expect(201);

    return {
      token: response.body.data.tokens.accessToken as string,
      organizationId: response.body.data.user.organization.id as string,
    };
  };

  /** Runs a service call inside an explicit tenant scope, as a worker would. */
  const asOrganization = async <T>(
    organizationId: string,
    userId: string,
    fn: (service: SubscriptionsService) => Promise<T>,
  ): Promise<T> => {
    const tenantContext = ctx.app.get(TenantContextService);
    const service = ctx.app.get(SubscriptionsService);

    return tenantContext.runWithTenant(
      {
        organizationId,
        userId,
        membershipId: 'e2e',
        role: 'OWNER',
        permissions: [],
        sessionId: 'e2e',
      },
      () => fn(service),
    );
  };

  beforeAll(async () => {
    ctx = await createTestContext();

    // The shared fixture organizations are created by direct insert rather than
    // through registration, so they have no subscription. Give them one.
    const tenantContext = ctx.app.get(TenantContextService);
    const service = ctx.app.get(SubscriptionsService);

    await tenantContext.runAsSystem('e2e subscription fixture', async () => {
      await service.startTrial(ctx.orgA.id);
      await service.startTrial(ctx.orgB.id);
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ---------------------------------------------------------------------------
  // The public catalogue
  // ---------------------------------------------------------------------------

  describe('GET /plans', () => {
    it('is readable with no authentication at all', async () => {
      const response = await ctx.http().get('/api/v1/plans').expect(200);

      // The pricing page must render for a visitor who has never signed in.
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);
    });

    it('returns catalogue data and nothing tenant-specific', async () => {
      const response = await ctx.http().get('/api/v1/plans').expect(200);

      const serialised = JSON.stringify(response.body.data);
      // A leak here would be a public endpoint disclosing customer data.
      expect(serialised).not.toContain(ctx.orgA.id);
      expect(serialised).not.toContain(ctx.orgB.id);
      expect(serialised).not.toMatch(/organizationId|subscription|currentPeriod/i);

      for (const plan of response.body.data as Record<string, unknown>[]) {
        expect(Object.keys(plan).sort()).toEqual(
          [
            'code',
            'currency',
            'description',
            'featured',
            'features',
            'id',
            'maxActiveLeads',
            'maxUsers',
            'monthlyPrice',
            'name',
            'tagline',
            'yearlyPrice',
          ].sort(),
        );
      }
    });

    it('quotes prices as decimal strings, not floats', async () => {
      const response = await ctx.http().get('/api/v1/plans').expect(200);

      for (const plan of response.body.data as { monthlyPrice: unknown }[]) {
        // Money must not round-trip through a float; the NUMERIC column type
        // exists precisely to prevent that.
        expect(typeof plan.monthlyPrice).toBe('string');
      }
    });

    it('marks exactly one plan as featured', async () => {
      const response = await ctx.http().get('/api/v1/plans').expect(200);
      const featured = (response.body.data as { featured: boolean }[]).filter((p) => p.featured);

      expect(featured).toHaveLength(1);
    });

    it('exposes no route for creating or editing a plan', async () => {
      // The catalogue is seeded from source. No HTTP surface writes it, so
      // there is nothing for an attacker — or a confused admin — to reach.
      await ctx
        .http()
        .post('/api/v1/plans')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ code: 'FREEBIE', name: 'Freebie', monthlyPrice: '0' })
        .expect(404);

      const plans = await ctx.http().get('/api/v1/plans').expect(200);
      const first = (plans.body.data as { id: string }[])[0];

      await ctx
        .http()
        .patch(`/api/v1/plans/${first?.id as string}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ monthlyPrice: '0' })
        .expect(404);

      await ctx
        .http()
        .delete(`/api/v1/plans/${first?.id as string}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------------
  // A tenant's own subscription
  // ---------------------------------------------------------------------------

  describe('GET /subscriptions/current', () => {
    it('gives a newly registered organization a trial', async () => {
      const org = await freshOrg();

      const response = await ctx
        .http()
        .get('/api/v1/subscriptions/current')
        .set(auth(org.token))
        .expect(200);

      expect(response.body.data.status).toBe('TRIAL');
      expect(response.body.data.plan.code).toBe('STARTER');
      expect(response.body.data.trialEndsAt).not.toBeNull();
      expect(response.body.data.grantsAccess).toBe(true);
    });

    it('reports honestly that limits are not enforced', async () => {
      const org = await freshOrg();

      const response = await ctx
        .http()
        .get('/api/v1/subscriptions/current')
        .set(auth(org.token))
        .expect(200);

      // Publishing "up to 3 users" while allowing 200 is a promise broken at
      // the worst moment. The flag travels with the data so no client can
      // imply a cap the server does not apply.
      expect(response.body.data.limitsEnforced).toBe(false);
      expect(response.body.data.plan.maxUsers).toBe(3);
    });

    it('refuses an unauthenticated caller', async () => {
      await ctx.http().get('/api/v1/subscriptions/current').expect(401);
    });

    it('refuses a sales rep', async () => {
      await ctx
        .http()
        .get('/api/v1/subscriptions/current')
        .set(auth(ctx.orgA.rep.accessToken))
        .expect(403);
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-tenant isolation
  // ---------------------------------------------------------------------------

  describe('tenant isolation', () => {
    it('shows each organization only its own subscription', async () => {
      const a = await ctx
        .http()
        .get('/api/v1/subscriptions/current')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      const b = await ctx
        .http()
        .get('/api/v1/subscriptions/current')
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(200);

      expect(a.body.data.id).not.toBe(b.body.data.id);
    });

    it('has no id parameter to tamper with', async () => {
      const other = await ctx
        .http()
        .get('/api/v1/subscriptions/current')
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(200);

      // The organization comes from the token, so there is deliberately no
      // GET /subscriptions/:id for a caller to point at somebody else.
      await ctx
        .http()
        .get(`/api/v1/subscriptions/${other.body.data.id as string}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(404);
    });

    it('a plan change in one organization does not touch another', async () => {
      const before = await ctx
        .http()
        .get('/api/v1/subscriptions/current')
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(200);

      await ctx
        .http()
        .patch('/api/v1/subscriptions/current')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ planCode: 'BUSINESS' })
        .expect(200);

      const after = await ctx
        .http()
        .get('/api/v1/subscriptions/current')
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(200);

      // updateMany with an empty where is tenant-scoped by the extension. If
      // the scoping were ever removed this test fails loudly rather than
      // silently upgrading every customer on the platform.
      expect(after.body.data.plan.code).toBe(before.body.data.plan.code);
    });
  });

  // ---------------------------------------------------------------------------
  // Changing plan
  // ---------------------------------------------------------------------------

  describe('PATCH /subscriptions/current', () => {
    it('changes the plan', async () => {
      const org = await freshOrg();

      const response = await ctx
        .http()
        .patch('/api/v1/subscriptions/current')
        .set(auth(org.token))
        .send({ planCode: 'PROFESSIONAL' })
        .expect(200);

      expect(response.body.data.plan.code).toBe('PROFESSIONAL');
    });

    it('changes the billing interval', async () => {
      const org = await freshOrg();

      const response = await ctx
        .http()
        .patch('/api/v1/subscriptions/current')
        .set(auth(org.token))
        .send({ billingInterval: 'YEARLY' })
        .expect(200);

      expect(response.body.data.billingInterval).toBe('YEARLY');
    });

    it('REFUSES a client trying to set its own status', async () => {
      const org = await freshOrg();

      // The single most important test in this file. A client asserting
      // "I am ACTIVE" is asserting that it has paid.
      await ctx
        .http()
        .patch('/api/v1/subscriptions/current')
        .set(auth(org.token))
        .send({ status: 'ACTIVE' })
        .expect(400);

      const after = await ctx
        .http()
        .get('/api/v1/subscriptions/current')
        .set(auth(org.token))
        .expect(200);

      expect(after.body.data.status).toBe('TRIAL');
    });

    it.each([
      ['a period end', { currentPeriodEnd: '2099-01-01T00:00:00.000Z' }],
      ['a trial extension', { trialEndsAt: '2099-01-01T00:00:00.000Z' }],
      ['a provider id', { providerSubscriptionId: 'sub_free_forever' }],
      ['an unknown plan', { planCode: 'ENTERPRISE_UNLIMITED' }],
      ['a nonsense interval', { billingInterval: 'DAILY' }],
    ])('rejects %s', async (_label, body) => {
      const org = await freshOrg();
      await ctx
        .http()
        .patch('/api/v1/subscriptions/current')
        .set(auth(org.token))
        .send(body)
        .expect(400);
    });

    it('refuses a sales rep', async () => {
      await ctx
        .http()
        .patch('/api/v1/subscriptions/current')
        .set(auth(ctx.orgA.rep.accessToken))
        .send({ planCode: 'BUSINESS' })
        .expect(403);
    });

    it('records the change in the audit trail', async () => {
      const org = await freshOrg();

      await ctx
        .http()
        .patch('/api/v1/subscriptions/current')
        .set(auth(org.token))
        .send({ planCode: 'BUSINESS' })
        .expect(200);

      const audit = await ctx
        .http()
        .get('/api/v1/organizations/audit?limit=20')
        .set(auth(org.token))
        .expect(200);

      expect(
        (audit.body.data.items as { action: string }[]).some(
          (row) => row.action === 'subscription.plan_changed',
        ),
      ).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Status transitions — reachable only from inside the application
  // ---------------------------------------------------------------------------

  describe('status transitions', () => {
    it('converts a trial to active', async () => {
      const org = await freshOrg();
      const owner = await ownerIdOf(org.token);

      const result = await asOrganization(org.organizationId, owner, (service) =>
        service.transitionStatus('ACTIVE', 'payment received'),
      );

      expect(result.status).toBe('ACTIVE');
    });

    it('rejects an illegal transition', async () => {
      const org = await freshOrg();
      const owner = await ownerIdOf(org.token);

      // TRIAL cannot jump to PAST_DUE: nothing has been charged yet.
      await expect(
        asOrganization(org.organizationId, owner, (service) =>
          service.transitionStatus('PAST_DUE', 'bogus'),
        ),
      ).rejects.toMatchObject({
        response: { code: ERROR_CODES.INVALID_SUBSCRIPTION_TRANSITION },
      });
    });

    it('never allows a return to TRIAL', async () => {
      const org = await freshOrg();
      const owner = await ownerIdOf(org.token);

      await asOrganization(org.organizationId, owner, (service) =>
        service.transitionStatus('ACTIVE', 'payment received'),
      );

      // Otherwise an organization could cycle free periods indefinitely.
      await expect(
        asOrganization(org.organizationId, owner, (service) =>
          service.transitionStatus('TRIAL', 'sneaky'),
        ),
      ).rejects.toMatchObject({
        response: { code: ERROR_CODES.INVALID_SUBSCRIPTION_TRANSITION },
      });
    });

    it('keeps a past-due organization working', async () => {
      const org = await freshOrg();
      const owner = await ownerIdOf(org.token);

      await asOrganization(org.organizationId, owner, (service) =>
        service.transitionStatus('ACTIVE', 'payment received'),
      );
      const pastDue = await asOrganization(org.organizationId, owner, (service) =>
        service.transitionStatus('PAST_DUE', 'card declined'),
      );

      // Locking someone out on the first failed charge loses accounts a retry
      // would have recovered.
      expect(pastDue.grantsAccess).toBe(true);

      // And the CRM keeps working — access is not gated on billing today.
      await ctx.http().get('/api/v1/leads').set(auth(org.token)).expect(200);
    });

    it('clears the cancellation date when reactivated', async () => {
      const org = await freshOrg();
      const owner = await ownerIdOf(org.token);

      const cancelled = await asOrganization(org.organizationId, owner, (service) =>
        service.transitionStatus('CANCELLED', 'customer asked'),
      );
      expect(cancelled.cancelledAt).not.toBeNull();
      expect(cancelled.grantsAccess).toBe(false);

      const reactivated = await asOrganization(org.organizationId, owner, (service) =>
        service.transitionStatus('ACTIVE', 'customer returned'),
      );

      // Otherwise the row claims to be both active and cancelled.
      expect(reactivated.cancelledAt).toBeNull();
      expect(reactivated.grantsAccess).toBe(true);
    });

    it('is not reachable over HTTP', async () => {
      const org = await freshOrg();

      // There is deliberately no route for it. A payment provider webhook is
      // the only thing that should ever call transitionStatus.
      for (const path of [
        '/api/v1/subscriptions/current/status',
        '/api/v1/subscriptions/current/activate',
        '/api/v1/subscriptions/current/cancel',
      ]) {
        await ctx.http().post(path).set(auth(org.token)).send({ status: 'ACTIVE' }).expect(404);
      }
    });
  });

  /** The owner's user id, read back through the API. */
  async function ownerIdOf(token: string): Promise<string> {
    const me = await ctx.http().get('/api/v1/auth/me').set(auth(token)).expect(200);
    return me.body.data.id as string;
  }
});
