import { createTestContext, type TestContext } from './helpers/test-app';
import { DevicesRepository } from '../src/modules/notifications/push/devices.repository';
import { PushDispatchService } from '../src/modules/notifications/push/push-dispatch.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { jobPrincipal } from '../src/queues/job-context';

/**
 * Push device registration and delivery.
 *
 * A push token is a CREDENTIAL: anyone holding it can send a notification that
 * appears to come from LeadFlow, straight to a customer-facing salesperson's
 * lock screen. So the tests here are about three things.
 *
 *   THE TOKEN NEVER COMES BACK OUT. Not in a list response, not in an error,
 *   not anywhere. A field that is never selected cannot be accidentally
 *   serialised into a response later.
 *
 *   OWNERSHIP IS THE AUTHENTICATED IDENTITY. Tenant scoping alone would let a
 *   colleague in the same organization silence someone else's phone; every
 *   query is additionally scoped to the caller's own user id.
 *
 *   ONE DEAD DEVICE DOES NOT STOP THE OTHERS. Fan-out is the normal case, and
 *   an exception in the middle of a loop is how a salesperson's working phone
 *   goes quiet because their old one was uninstalled.
 */
describe('Push devices', () => {
  let ctx: TestContext;
  let devices: DevicesRepository;
  let dispatch: PushDispatchService;
  let tenantContext: TenantContextService;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  let counter = 0;
  const unique = () => {
    counter += 1;
    return `${Date.now()}${counter}`;
  };

  const tokenFor = (label: string) => `fcm-token-${label}-${unique()}-padded-to-length`;

  beforeAll(async () => {
    ctx = await createTestContext();
    devices = ctx.app.get(DevicesRepository);
    dispatch = ctx.app.get(PushDispatchService);
    tenantContext = ctx.app.get(TenantContextService);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  async function register(accessToken: string, token: string, label?: string) {
    return ctx
      .http()
      .post('/api/v1/users/me/devices')
      .set(auth(accessToken))
      .send({ token, platform: 'ANDROID', ...(label ? { label } : {}) });
  }

  // ===========================================================================
  // Token secrecy
  // ===========================================================================

  describe('token secrecy', () => {
    it('NEVER returns the push token when registering', async () => {
      const token = tokenFor('secrecy');
      const response = await register(ctx.orgA.owner.accessToken, token, 'Pixel');

      expect(response.status).toBe(201);
      // The whole response body, not just a field check.
      expect(JSON.stringify(response.body)).not.toContain(token);
    });

    it('NEVER returns push tokens in the device list', async () => {
      const token = tokenFor('list');
      await register(ctx.orgA.owner.accessToken, token, 'Tablet');

      const response = await ctx
        .http()
        .get('/api/v1/users/me/devices')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(200);
      expect(response.body.data.items.length).toBeGreaterThan(0);
      expect(JSON.stringify(response.body)).not.toContain(token);
    });

    it('returns enough to identify a device without the credential', async () => {
      await register(ctx.orgA.owner.accessToken, tokenFor('identify'), 'Work phone');

      const response = await ctx
        .http()
        .get('/api/v1/users/me/devices')
        .set(auth(ctx.orgA.owner.accessToken));

      const device = response.body.data.items.find(
        (item: { label: string | null }) => item.label === 'Work phone',
      );

      expect(device).toBeDefined();
      expect(device.platform).toBe('ANDROID');
      expect(device.active).toBe(true);
      expect(device).not.toHaveProperty('token');
    });
  });

  // ===========================================================================
  // Ownership and isolation
  // ===========================================================================

  describe('ownership', () => {
    it('registers against the CALLER, ignoring any client-supplied identity', async () => {
      /*
       * The DTO has no userId and no organizationId. This asserts the server
       * ignores them even when a client sends them anyway.
       */
      const token = tokenFor('injection');

      const response = await ctx
        .http()
        .post('/api/v1/users/me/devices')
        .set(auth(ctx.orgA.rep.accessToken))
        .send({
          token,
          platform: 'ANDROID',
          userId: ctx.orgA.owner.id,
          organizationId: ctx.orgB.id,
        });

      // forbidNonWhitelisted rejects the injected fields outright.
      expect(response.status).toBe(400);
    });

    it('a colleague cannot see another user devices', async () => {
      await register(ctx.orgA.owner.accessToken, tokenFor('owner-only'), 'Owner phone');

      const repView = await ctx
        .http()
        .get('/api/v1/users/me/devices')
        .set(auth(ctx.orgA.rep.accessToken));

      const labels = repView.body.data.items.map((item: { label: string }) => item.label);
      expect(labels).not.toContain('Owner phone');
    });

    it('a colleague cannot deactivate another user device', async () => {
      await register(ctx.orgA.owner.accessToken, tokenFor('protected'), 'Protected');

      const owned = await ctx
        .http()
        .get('/api/v1/users/me/devices')
        .set(auth(ctx.orgA.owner.accessToken));

      const target = owned.body.data.items.find(
        (item: { label: string | null }) => item.label === 'Protected',
      );
      expect(target).toBeDefined();

      // The rep guesses the id. Same 404 as one that does not exist.
      const response = await ctx
        .http()
        .delete(`/api/v1/users/me/devices/${target.id}`)
        .set(auth(ctx.orgA.rep.accessToken));

      expect(response.status).toBe(404);
    });

    it('another TENANT cannot see or touch a device', async () => {
      await register(ctx.orgA.owner.accessToken, tokenFor('tenant-a'), 'Org A phone');

      const owned = await ctx
        .http()
        .get('/api/v1/users/me/devices')
        .set(auth(ctx.orgA.owner.accessToken));

      const target = owned.body.data.items.find(
        (item: { label: string | null }) => item.label === 'Org A phone',
      );

      const response = await ctx
        .http()
        .delete(`/api/v1/users/me/devices/${target.id}`)
        .set(auth(ctx.orgB.owner.accessToken));

      expect(response.status).toBe(404);

      const orgBView = await ctx
        .http()
        .get('/api/v1/users/me/devices')
        .set(auth(ctx.orgB.owner.accessToken));

      const labels = orgBView.body.data.items.map((item: { label: string }) => item.label);
      expect(labels).not.toContain('Org A phone');
    });

    it('the same physical token may be registered in two tenants', async () => {
      /*
       * A shared handset is real. The unique index is per organization
       * precisely so one tenant's registration cannot silently deny another's.
       */
      const shared = tokenFor('shared-handset');

      const inA = await register(ctx.orgA.owner.accessToken, shared, 'Shared A');
      const inB = await register(ctx.orgB.owner.accessToken, shared, 'Shared B');

      expect(inA.status).toBe(201);
      expect(inB.status).toBe(201);
    });
  });

  // ===========================================================================
  // Token rotation and lifecycle
  // ===========================================================================

  describe('rotation and lifecycle', () => {
    it('re-registering the SAME token updates rather than duplicating', async () => {
      /*
       * The client re-registers on every launch. Without the upsert this would
       * be a new row per launch, each one a fan-out target the worker retries
       * and the provider rejects.
       */
      const token = tokenFor('rotation');

      await register(ctx.orgA.owner.accessToken, token, 'First label');
      await register(ctx.orgA.owner.accessToken, token, 'Second label');
      await register(ctx.orgA.owner.accessToken, token, 'Third label');

      const response = await ctx
        .http()
        .get('/api/v1/users/me/devices')
        .set(auth(ctx.orgA.owner.accessToken));

      const matching = response.body.data.items.filter((item: { label: string | null }) =>
        ['First label', 'Second label', 'Third label'].includes(item.label ?? ''),
      );

      expect(matching).toHaveLength(1);
      expect(matching[0].label).toBe('Third label');
    });

    it('supports a user with several devices', async () => {
      // A phone, a tablet, an old handset. All three should receive.
      const before = await ctx
        .http()
        .get('/api/v1/users/me/devices')
        .set(auth(ctx.orgA.rep.accessToken));

      await register(ctx.orgA.rep.accessToken, tokenFor('phone'), 'Phone');
      await register(ctx.orgA.rep.accessToken, tokenFor('tablet'), 'Tablet');

      const after = await ctx
        .http()
        .get('/api/v1/users/me/devices')
        .set(auth(ctx.orgA.rep.accessToken));

      expect(after.body.data.items.length).toBe(before.body.data.items.length + 2);
    });

    it('unregistering one device leaves the others alone', async () => {
      /*
       * The §11 decision. Signing out on a phone must not silence the same
       * person's tablet — so deactivation is by TOKEN, never by user.
       */
      const phone = tokenFor('signout-phone');
      const tablet = tokenFor('signout-tablet');

      await register(ctx.orgA.owner.accessToken, phone, 'Sign-out phone');
      await register(ctx.orgA.owner.accessToken, tablet, 'Sign-out tablet');

      const response = await ctx
        .http()
        .post('/api/v1/users/me/devices/unregister')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ token: phone });

      expect(response.status).toBe(201);
      expect(response.body.data.deactivated).toBe(1);

      const list = await ctx
        .http()
        .get('/api/v1/users/me/devices')
        .set(auth(ctx.orgA.owner.accessToken));

      const phoneRow = list.body.data.items.find(
        (item: { label: string | null }) => item.label === 'Sign-out phone',
      );
      const tabletRow = list.body.data.items.find(
        (item: { label: string | null }) => item.label === 'Sign-out tablet',
      );

      expect(phoneRow.active).toBe(false);
      // The one that matters.
      expect(tabletRow.active).toBe(true);
    });

    it('cannot unregister another user token', async () => {
      const token = tokenFor('not-yours');
      await register(ctx.orgA.owner.accessToken, token, 'Owner device');

      const response = await ctx
        .http()
        .post('/api/v1/users/me/devices/unregister')
        .set(auth(ctx.orgA.rep.accessToken))
        .send({ token });

      // Reports zero without confirming the token exists elsewhere — a
      // response that distinguished the two would let one user probe for
      // another's tokens.
      expect(response.status).toBe(201);
      expect(response.body.data.deactivated).toBe(0);
    });

    it('re-registering REACTIVATES a device that was signed out', async () => {
      const token = tokenFor('reactivate');

      await register(ctx.orgA.owner.accessToken, token, 'Returning');
      await ctx
        .http()
        .post('/api/v1/users/me/devices/unregister')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ token });

      await register(ctx.orgA.owner.accessToken, token, 'Returning');

      const list = await ctx
        .http()
        .get('/api/v1/users/me/devices')
        .set(auth(ctx.orgA.owner.accessToken));

      const row = list.body.data.items.find(
        (item: { label: string | null }) => item.label === 'Returning',
      );

      expect(row.active).toBe(true);
    });
  });

  // ===========================================================================
  // Delivery
  // ===========================================================================

  describe('delivery', () => {
    it('fans out to every active device without throwing', async () => {
      /*
       * FCM is not configured in tests, so every send reports a PERMANENT
       * failure. What is asserted here is that the dispatch path RESOLVES —
       * an exception mid-loop is how one dead device silences the rest.
       */
      await register(ctx.orgA.owner.accessToken, tokenFor('fanout-1'), 'Fan 1');
      await register(ctx.orgA.owner.accessToken, tokenFor('fanout-2'), 'Fan 2');

      const result = await tenantContext.runWithTenant(jobPrincipal(ctx.orgA.id), async () =>
        dispatch.dispatch({
          userId: ctx.orgA.owner.id,
          notificationId: 'n-1',
          type: 'FOLLOW_UP_DUE',
          title: 'Test',
          body: 'Test body',
          entityType: 'FollowUp',
          entityId: 'f-1',
        }),
      );

      expect(result.devices).toBeGreaterThanOrEqual(2);
      // Unconfigured, so nothing was delivered — and that is REPORTED rather
      // than silently counted as success.
      expect(result.delivered).toBe(0);
    });

    it('does nothing, quietly, for a user with no devices', async () => {
      const result = await tenantContext.runWithTenant(jobPrincipal(ctx.orgB.id), async () =>
        dispatch.dispatch({
          userId: ctx.orgB.rep.id,
          notificationId: 'n-2',
          type: 'FOLLOW_UP_DUE',
          title: 'Test',
          body: 'Test body',
          entityType: 'FollowUp',
          entityId: 'f-2',
        }),
      );

      expect(result.devices).toBe(0);
      expect(result.delivered).toBe(0);
    });

    it('deactivates a device whose token the provider rejects', async () => {
      /*
       * Exercised directly on the repository, because the unconfigured provider
       * reports PERMANENT rather than INVALID_TOKEN. What matters is that the
       * deactivation path works, is keyed on the token the provider reports,
       * and leaves the user and their history alone.
       */
      const token = tokenFor('rejected');
      await register(ctx.orgA.owner.accessToken, token, 'Doomed');

      const deactivated = await tenantContext.runWithTenant(
        jobPrincipal(ctx.orgA.id),
        async () => devices.deactivateByToken(token, 'provider: UNREGISTERED'),
      );

      expect(deactivated).toBe(1);

      const list = await ctx
        .http()
        .get('/api/v1/users/me/devices')
        .set(auth(ctx.orgA.owner.accessToken));

      const row = list.body.data.items.find(
        (item: { label: string | null }) => item.label === 'Doomed',
      );

      // Deactivated, not deleted. The registration history survives, and the
      // reason is visible to whoever wonders why the phone stopped buzzing.
      expect(row).toBeDefined();
      expect(row.active).toBe(false);
      expect(row.deactivatedReason).toContain('UNREGISTERED');
    });

    it('a dead device does not remove the user or their notifications', async () => {
      const token = tokenFor('survivor');
      await register(ctx.orgA.owner.accessToken, token, 'Survivor');

      await tenantContext.runWithTenant(jobPrincipal(ctx.orgA.id), async () =>
        devices.deactivateByToken(token, 'provider: UNREGISTERED'),
      );

      // The user is still there and can still read their bell.
      const bell = await ctx
        .http()
        .get('/api/v1/notifications')
        .set(auth(ctx.orgA.owner.accessToken));

      expect(bell.status).toBe(200);
    });
  });

  // ===========================================================================
  // Abuse
  // ===========================================================================

  describe('abuse resistance', () => {
    it('rejects an implausibly short token', async () => {
      const response = await register(ctx.orgA.owner.accessToken, 'short');
      expect(response.status).toBe(400);
    });

    it('rejects an over-long token', async () => {
      const response = await register(ctx.orgA.owner.accessToken, 'x'.repeat(600));
      expect(response.status).toBe(400);
    });

    it('requires authentication', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/users/me/devices')
        .send({ token: tokenFor('anon') });

      expect(response.status).toBe(401);
    });

    it('THROTTLES bulk registration', async () => {
      /*
       * The protection §31 asks for, asserted directly rather than inferred.
       *
       * Sixty an hour accommodates any real client — including a phone in a
       * restart loop — while stopping someone filling the table with junk
       * rows, each of which is a fan-out target the worker would retry.
       *
       * This runs last on purpose: it deliberately exhausts the bucket, and
       * the assertions above need a working endpoint.
       */
      let throttled = false;

      for (let attempt = 0; attempt < 70; attempt += 1) {
        const response = await register(ctx.orgA.owner.accessToken, tokenFor(`bulk-${attempt}`));
        if (response.status === 429) {
          throttled = true;
          break;
        }
      }

      expect(throttled).toBe(true);
    });

  });
});
