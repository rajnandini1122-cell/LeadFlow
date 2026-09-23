import { createHmac } from 'node:crypto';
import { createTestContext, type TestContext } from './helpers/test-app';
import { adminSigningBase } from '../src/modules/integrations/admin-control/admin-control-signature';

const BASE = '/api/v1/integrations/admin-control';

/**
 * The control plane when this deployment has not switched it on.
 *
 * Deliberately its OWN spec file, with no `admin-control-env` import. The
 * configuration is read once, at module import, so a suite that enabled the
 * integration could not disable it again afterwards — and a test that tried
 * would quietly be asserting against the enabled behaviour.
 *
 * Two things are being checked, and the second is the one that matters:
 *
 *   a deployment that has not configured a control plane does not have one;
 *
 *   and the control plane's headers are not a second way into the ordinary
 *   API. A signature is not a session, and a session is not a signature.
 */
describe('Central Admin control plane (disabled)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  /** Perfectly formed, and signed with a secret this deployment does not hold. */
  const signedRequest = (method: 'get' | 'post', path: string, body?: unknown) => {
    const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const requestId = `cmd-${Date.now()}`;
    const actorRef = 'firebase:uid:admin-1';

    const signature = `sha256=${createHmac('sha256', 'some-secret-that-is-long-enough-32')
      .update(adminSigningBase({ method, path, timestamp, requestId, actorRef, rawBody: raw }))
      .digest('hex')}`;

    const request = ctx
      .http()
      [method](path)
      .set('x-cravion-admin-timestamp', timestamp)
      .set('x-cravion-admin-request-id', requestId)
      .set('x-cravion-admin-actor', actorRef)
      .set('x-cravion-admin-signature', signature);

    return raw === undefined
      ? request
      : request.set('Content-Type', 'application/json').send(raw.toString('utf8'));
  };

  it.each([
    ['summary', 'get', `${BASE}/summary`],
    ['teams', 'get', `${BASE}/teams`],
    ['territories', 'get', `${BASE}/territories`],
    ['enquiries', 'get', `${BASE}/intakes`],
  ])('answers 404 for %s', async (_label, method, path) => {
    const response = await signedRequest(method as 'get', path);

    /*
     * INVISIBLE, not forbidden.
     *
     * 404 is the honest answer for a route this deployment does not offer, and
     * it tells somebody scanning for control endpoints nothing about whether
     * one exists here and is merely switched off. 401 would confirm there is a
     * secret to guess; 403 would confirm there is a plane to reach.
     */
    expect(response.status).toBe(404);
  });

  it('answers 404 for a mutation too', async () => {
    const response = await signedRequest('post', `${BASE}/teams`, { name: 'Should not exist' });

    expect(response.status).toBe(404);
  });

  it('creates nothing while disabled', async () => {
    await signedRequest('post', `${BASE}/teams`, { name: 'Should not exist' });

    // The route is absent, so nothing downstream of it ran.
    const teams = await ctx
      .http()
      .get('/api/v1/teams')
      .set({ Authorization: `Bearer ${ctx.orgA.owner.accessToken}` })
      .expect(200);

    expect((teams.body.data as { name: string }[]).map((team) => team.name)).not.toContain(
      'Should not exist',
    );
  });

  describe('the control headers are not a way into the ordinary API', () => {
    it('does not authenticate a native route', async () => {
      /*
       * The other half of the boundary. A control-plane signature proves the
       * holder of ONE shared secret is calling ONE allowlisted surface; it is
       * not a credential for the human-facing API, which still wants a session
       * and a permission.
       *
       * Checked with the headers a real control request carries, so that a
       * future change routing them through a shared guard fails here.
       */
      const timestamp = String(Math.floor(Date.now() / 1000));

      const response = await ctx
        .http()
        .get('/api/v1/teams')
        .set('x-cravion-admin-timestamp', timestamp)
        .set('x-cravion-admin-request-id', `cmd-${Date.now()}`)
        .set('x-cravion-admin-actor', 'firebase:uid:admin-1')
        .set('x-cravion-admin-signature', `sha256=${'0'.repeat(64)}`);

      expect(response.status).toBe(401);
    });

    it('does not raise a signed-in user’s permissions', async () => {
      // A sales rep may not manage teams. Adding control-plane headers to
      // their request must not change that — they are not a grant.
      const response = await ctx
        .http()
        .post('/api/v1/teams')
        .set({ Authorization: `Bearer ${ctx.orgA.rep.accessToken}` })
        .set('x-cravion-admin-actor', 'firebase:uid:admin-1')
        .set('x-cravion-admin-signature', `sha256=${'0'.repeat(64)}`)
        .send({ name: `Escalation ${Date.now()}` });

      expect(response.status).toBe(403);
    });
  });
});
