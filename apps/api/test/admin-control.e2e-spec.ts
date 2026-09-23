// MUST be first: it configures the control plane into process.env, which
// @nestjs/config reads when the next import pulls in the config module.
import { ADMIN_ORGANIZATION_ID, ADMIN_SECRET } from './helpers/admin-control-env';
import { createHmac } from 'node:crypto';
import { createTestContext, type TestContext } from './helpers/test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { adminSigningBase } from '../src/modules/integrations/admin-control/admin-control-signature';

const BASE = '/api/v1/integrations/admin-control';

/**
 * The Central Admin control plane.
 *
 * A trusted server-to-server boundary into a tenant's configuration, which
 * makes four properties load-bearing, and every case here is one of them:
 *
 *   NOTHING UNSIGNED IS BELIEVED, and the signature covers the method and the
 *   path as well as the body — otherwise a captured command is replayable at a
 *   different endpoint;
 *
 *   THE TENANT IS OURS TO DECIDE. Configuration, never the request;
 *
 *   A COMMAND RUNS ONCE. The request id is an idempotency key backed by a
 *   unique index, and the ledger row commits with the mutation or not at all;
 *
 *   THE DOMAIN RULES STILL APPLY. "Admin" is not a reason to bypass an
 *   invariant, and the same method refuses the same thing here as on the web.
 */
describe('Central Admin control plane', () => {
  let ctx: TestContext;

  const unique = (prefix: string): string =>
    `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`;

  const asSystem = async <T>(reason: string, run: () => Promise<T>): Promise<T> =>
    ctx.app.get(TenantContextService).runAsSystem(reason, run);

  const prisma = () => ctx.app.get(PrismaService).client;

  /** Two people who already belong to the administered organization. */
  const members: string[] = [];

  /**
   * Signs and sends, exactly as the Central Admin backend will.
   *
   * The body is serialised ONCE and both signed and sent as those bytes: a
   * signature over a re-serialised object is a check that passes when it should
   * fail.
   */
  const send = async (
    method: 'get' | 'post' | 'patch',
    path: string,
    options: {
      body?: unknown;
      requestId?: string;
      actorRef?: string;
      timestamp?: number;
      secret?: string;
      signature?: string | null;
      /** Signs one path and sends to another, to prove the path is bound. */
      signPath?: string;
      signMethod?: string;
    } = {},
  ) => {
    const raw =
      options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
    const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
    const requestId = options.requestId ?? unique('cmd');
    const actorRef = options.actorRef ?? 'firebase:uid:admin-1';

    const signature =
      options.signature === undefined
        ? `sha256=${createHmac('sha256', options.secret ?? ADMIN_SECRET)
            .update(
              adminSigningBase({
                method: options.signMethod ?? method,
                path: options.signPath ?? path,
                timestamp,
                requestId,
                actorRef,
                rawBody: raw,
              }),
            )
            .digest('hex')}`
        : options.signature;

    const request = ctx
      .http()
      [method](path)
      .set('x-cravion-admin-timestamp', timestamp)
      .set('x-cravion-admin-request-id', requestId)
      .set('x-cravion-admin-actor', actorRef);

    if (signature !== null) request.set('x-cravion-admin-signature', signature);

    if (raw === undefined) return request;

    // The exact bytes that were signed, as a string: handed a Buffer,
    // superagent serialises the Buffer OBJECT, which is not the payload and
    // would never verify.
    return request.set('Content-Type', 'application/json').send(raw.toString('utf8'));
  };

  beforeAll(async () => {
    ctx = await createTestContext();

    await asSystem('e2e admin control tenant', async () => {
      await prisma().organization.create({
        data: {
          id: ADMIN_ORGANIZATION_ID,
          name: 'CRAVION Administered Tenant',
          slug: `admin-${Date.now()}`,
          status: 'ACTIVE',
          country: 'IN',
        },
      });
      await prisma().organizationSettings.create({
        data: { organizationId: ADMIN_ORGANIZATION_ID },
      });

      const role = await prisma().role.findFirst({ where: { key: 'SALES_REP' } });

      for (let index = 0; index < 2; index += 1) {
        const user = await prisma().user.create({
          data: {
            email: `${unique('admin-agent')}@example.test`,
            fullName: `Agent ${index}`,
            passwordHash: 'not-a-real-hash',
            status: 'ACTIVE',
          },
          select: { id: true },
        });

        await prisma().organizationUser.create({
          data: {
            organizationId: ADMIN_ORGANIZATION_ID,
            userId: user.id,
            roleId: role!.id,
            status: 'ACTIVE',
          },
        });

        members.push(user.id);
      }
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  describe('authentication', () => {
    it('accepts a correctly signed read', async () => {
      const response = await send('get', `${BASE}/teams`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('accepts a correctly signed mutation', async () => {
      const response = await send('post', `${BASE}/teams`, { body: { name: unique('Team') } });

      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({ status: 'ACTIVE' });
    });

    it.each([
      ['no signature', { signature: null }],
      ['a wrong signature', { signature: `sha256=${'0'.repeat(64)}` }],
      ['a malformed signature', { signature: 'not-a-signature' }],
      ['a signature from another secret', { secret: 'a-completely-different-secret-32-chars' }],
    ])('refuses a request with %s', async (_label, options) => {
      const response = await send('get', `${BASE}/teams`, options);
      expect(response.status).toBe(401);
    });

    it('refuses a stale request', async () => {
      const response = await send('get', `${BASE}/teams`, {
        timestamp: Math.floor(Date.now() / 1000) - 600,
      });
      expect(response.status).toBe(401);
    });

    it('refuses a request dated in the future', async () => {
      const response = await send('get', `${BASE}/teams`, {
        timestamp: Math.floor(Date.now() / 1000) + 600,
      });
      expect(response.status).toBe(401);
    });

    it('refuses a malformed timestamp', async () => {
      const response = await ctx
        .http()
        .get(`${BASE}/teams`)
        .set('x-cravion-admin-timestamp', 'yesterday')
        .set('x-cravion-admin-request-id', unique('cmd'))
        .set('x-cravion-admin-actor', 'admin-1')
        .set('x-cravion-admin-signature', `sha256=${'0'.repeat(64)}`);

      expect(response.status).toBe(401);
    });

    it.each([
      ['request id', 'x-cravion-admin-request-id'],
      ['actor reference', 'x-cravion-admin-actor'],
    ])('refuses a request with no %s', async (_label, header) => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const request = ctx
        .http()
        .get(`${BASE}/teams`)
        .set('x-cravion-admin-timestamp', timestamp)
        .set('x-cravion-admin-signature', `sha256=${'0'.repeat(64)}`);

      if (header !== 'x-cravion-admin-request-id') request.set('x-cravion-admin-request-id', 'cmd-1');
      if (header !== 'x-cravion-admin-actor') request.set('x-cravion-admin-actor', 'admin-1');

      expect((await request).status).toBe(401);
    });

    it('refuses when the method is not the one that was signed', async () => {
      // A captured GET must not be replayable as a PATCH.
      const response = await send('post', `${BASE}/teams`, {
        body: { name: unique('Team') },
        signMethod: 'get',
      });

      expect(response.status).toBe(401);
    });

    it('refuses when the path is not the one that was signed', async () => {
      // The reason the path is in the signing base at all: otherwise a
      // "create a team" is replayable as "create a territory".
      const response = await send('post', `${BASE}/teams`, {
        body: { name: unique('Team') },
        signPath: `${BASE}/territories`,
      });

      expect(response.status).toBe(401);
    });

    it('refuses when the body is not the one that was signed', async () => {
      const raw = Buffer.from(JSON.stringify({ name: 'Signed' }));
      const timestamp = String(Math.floor(Date.now() / 1000));
      const requestId = unique('cmd');

      const signature = `sha256=${createHmac('sha256', ADMIN_SECRET)
        .update(
          adminSigningBase({
            method: 'POST',
            path: `${BASE}/teams`,
            timestamp,
            requestId,
            actorRef: 'admin-1',
            rawBody: raw,
          }),
        )
        .digest('hex')}`;

      const response = await ctx
        .http()
        .post(`${BASE}/teams`)
        .set('Content-Type', 'application/json')
        .set('x-cravion-admin-timestamp', timestamp)
        .set('x-cravion-admin-request-id', requestId)
        .set('x-cravion-admin-actor', 'admin-1')
        .set('x-cravion-admin-signature', signature)
        .send(JSON.stringify({ name: 'Sent instead' }));

      expect(response.status).toBe(401);
    });

    it('refuses when the actor is not the one that was signed', async () => {
      const raw = Buffer.from(JSON.stringify({ name: unique('Team') }));
      const timestamp = String(Math.floor(Date.now() / 1000));
      const requestId = unique('cmd');

      const signature = `sha256=${createHmac('sha256', ADMIN_SECRET)
        .update(
          adminSigningBase({
            method: 'POST',
            path: `${BASE}/teams`,
            timestamp,
            requestId,
            actorRef: 'admin-1',
            rawBody: raw,
          }),
        )
        .digest('hex')}`;

      const response = await ctx
        .http()
        .post(`${BASE}/teams`)
        .set('Content-Type', 'application/json')
        .set('x-cravion-admin-timestamp', timestamp)
        .set('x-cravion-admin-request-id', requestId)
        // Who asked is part of what was signed: an intercepted command cannot
        // be re-attributed to somebody else.
        .set('x-cravion-admin-actor', 'admin-2')
        .set('x-cravion-admin-signature', signature)
        .send(raw.toString('utf8'));

      expect(response.status).toBe(401);
    });

    it('says nothing about WHY it failed', async () => {
      const response = await send('get', `${BASE}/teams`, {
        signature: `sha256=${'a'.repeat(64)}`,
      });

      /*
       * Scoped to the ERROR, not the whole envelope: every response carries
       * a meta.timestamp and a meta.requestId, and matching those would be
       * asserting against the response format rather than against a leak.
       */
      const error = JSON.stringify(response.body.error);
      expect(error).not.toContain(ADMIN_SECRET);
      // No expected signature, and no hint about which check failed.
      expect(error).not.toMatch(/[0-9a-f]{64}/);
      expect(error).not.toMatch(/timestamp|secret|hmac|signature/i);
      expect(response.body.error.message).toBe('This request could not be authenticated.');
    });

    it('is not reachable with a LeadFlow session instead of a signature', async () => {
      // The control plane is a separate trust domain. A human's bearer token
      // is not a substitute for holding the shared secret.
      const response = await ctx
        .http()
        .get(`${BASE}/teams`)
        .set({ Authorization: `Bearer ${ctx.orgA.owner.accessToken}` });

      expect(response.status).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant pinning
  // ---------------------------------------------------------------------------

  describe('the tenant comes from configuration', () => {
    it('ignores an organizationId in the body', async () => {
      const name = unique('Injection');
      const response = await send('post', `${BASE}/teams`, {
        body: { name, organizationId: ctx.orgA.id },
      });

      /*
       * STRIPPED, not merely ignored.
       *
       * A global interceptor removes organizationId from every request body
       * before validation reaches it, which is why this succeeds rather than
       * being refused — the field no longer exists by the time a controller
       * or a DTO could read one. That is stronger than a rejection: there is
       * no code path in which a caller-supplied tenant is available to
       * honour.
       *
       * The signature still covers the raw bytes that carried it, so the
       * attempt is authenticated and auditable; it is simply not obeyed.
       */
      expect(response.status).toBe(201);

      const team = await asSystem('e2e injection', () =>
        prisma().team.findFirst({ where: { id: response.body.data.id } }),
      );
      expect(team?.organizationId).toBe(ADMIN_ORGANIZATION_ID);
      expect(team?.organizationId).not.toBe(ctx.orgA.id);
    });

    it('writes into the configured organization, never another', async () => {
      const name = unique('Pinned');
      const response = await send('post', `${BASE}/teams`, { body: { name } });

      expect(response.status).toBe(201);

      const team = await asSystem('e2e pinned tenant', () =>
        prisma().team.findFirst({ where: { id: response.body.data.id } }),
      );
      expect(team?.organizationId).toBe(ADMIN_ORGANIZATION_ID);
    });

    it('cannot read another organization’s team', async () => {
      // A team that exists, in a tenant this control plane does not administer.
      const foreign = await ctx
        .http()
        .post('/api/v1/teams')
        .set({ Authorization: `Bearer ${ctx.orgA.owner.accessToken}` })
        .send({ name: unique('Foreign') })
        .expect(201);

      const response = await send('get', `${BASE}/teams/${foreign.body.data.id}`);

      // 404, not 403: a different answer for a foreign id would confirm it
      // exists somewhere.
      expect(response.status).toBe(404);
    });

    it('cannot add another organization’s member to a team', async () => {
      const team = await send('post', `${BASE}/teams`, { body: { name: unique('Team') } });

      const response = await send('post', `${BASE}/teams/${team.body.data.id}/members`, {
        body: { userId: ctx.orgA.rep.id },
      });

      // Somebody who is not a member of THIS organization is not a candidate,
      // and the answer says nothing about which organization they are in.
      expect(response.status).toBe(400);
    });

    it('cannot retry another organization’s enquiry', async () => {
      const foreign = await asSystem('e2e foreign intake', () =>
        prisma().integrationIntake.create({
          data: {
            organizationId: ctx.orgA.id,
            source: 'WEBSITE',
            externalEventId: unique('evt'),
            eventType: 'ENQUIRY',
            payloadHash: 'd'.repeat(64),
            status: 'BLOCKED',
          },
          select: { id: true },
        }),
      );

      const response = await send('post', `${BASE}/intakes/${foreign.id}/retry`, { body: {} });
      expect(response.status).toBe(404);

      const untouched = await asSystem('e2e foreign untouched', () =>
        prisma().integrationIntake.findFirst({ where: { id: foreign.id } }),
      );
      expect(untouched?.status).toBe('BLOCKED');
      expect(untouched?.processingAttempts).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Idempotency
  // ---------------------------------------------------------------------------

  describe('a command runs once', () => {
    it('performs one mutation for a repeated request id and body', async () => {
      const requestId = unique('cmd');
      const body = { name: unique('Once') };

      const first = await send('post', `${BASE}/teams`, { body, requestId });
      const second = await send('post', `${BASE}/teams`, { body, requestId });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      // The same team, not a second one with the same name — which the unique
      // index would have refused anyway, and which would have been a 409 the
      // caller could not act on.
      expect(second.body.data.id).toBe(first.body.data.id);

      const count = await asSystem('e2e one team', () =>
        prisma().team.count({
          where: { organizationId: ADMIN_ORGANIZATION_ID, name: body.name },
        }),
      );
      expect(count).toBe(1);
    });

    it('performs one mutation when two identical commands race', async () => {
      const requestId = unique('cmd');
      const body = { name: unique('Racing') };

      const [a, b] = await Promise.all([
        send('post', `${BASE}/teams`, { body, requestId }),
        send('post', `${BASE}/teams`, { body, requestId }),
      ]);

      // One inserts the ledger row; the other blocks on the unique index,
      // then finds it already done. PostgreSQL decides, not a prior read.
      expect([a.status, b.status]).toEqual([201, 201]);

      const count = await asSystem('e2e racing team', () =>
        prisma().team.count({
          where: { organizationId: ADMIN_ORGANIZATION_ID, name: body.name },
        }),
      );
      expect(count).toBe(1);

      const commands = await asSystem('e2e one command', () =>
        prisma().adminControlCommand.count({
          where: { organizationId: ADMIN_ORGANIZATION_ID, requestId },
        }),
      );
      expect(commands).toBe(1);
    });

    it.each([
      ['a different body', { body: { name: 'Different' } }],
      ['a different actor', { actorRef: 'firebase:uid:somebody-else' }],
    ])('refuses the same request id with %s', async (_label, overrides) => {
      const requestId = unique('cmd');
      await send('post', `${BASE}/teams`, { body: { name: unique('First') }, requestId });

      const response = await send('post', `${BASE}/teams`, {
        body: { name: unique('Second') },
        requestId,
        ...overrides,
      });

      expect(response.status).toBe(409);
      // Says the id is taken and nothing about what it was used for — naming
      // the first command would make this a way to read history by guessing.
      expect(JSON.stringify(response.body.error)).not.toContain('First');
    });

    it('refuses the same request id at a different path', async () => {
      const requestId = unique('cmd');
      await send('post', `${BASE}/teams`, { body: { name: unique('Team') }, requestId });

      const response = await send('post', `${BASE}/territories`, {
        body: { name: unique('Territory') },
        requestId,
      });

      expect(response.status).toBe(409);
    });

    it('frees the request id when the command fails', async () => {
      const requestId = unique('cmd');

      // A team name that is already taken: the domain refuses it, the
      // transaction rolls back, and the ledger row goes with it.
      const existing = unique('Taken');
      await send('post', `${BASE}/teams`, { body: { name: existing } });

      const failed = await send('post', `${BASE}/teams`, {
        body: { name: existing },
        requestId,
      });
      expect(failed.status).toBe(409);

      const ledger = await asSystem('e2e no ledger row', () =>
        prisma().adminControlCommand.count({
          where: { organizationId: ADMIN_ORGANIZATION_ID, requestId },
        }),
      );
      // Nothing happened, so nothing is recorded — and the id is usable again.
      expect(ledger).toBe(0);

      const retried = await send('post', `${BASE}/teams`, {
        body: { name: unique('Now free') },
        requestId,
      });
      expect(retried.status).toBe(201);
    });

    it('records the command with the external actor, never a LeadFlow user', async () => {
      const requestId = unique('cmd');
      const actorRef = 'firebase:uid:audited-admin';

      const response = await send('post', `${BASE}/teams`, {
        body: { name: unique('Audited') },
        requestId,
        actorRef,
      });
      expect(response.status).toBe(201);

      const command = await asSystem('e2e command row', () =>
        prisma().adminControlCommand.findFirst({
          where: { organizationId: ADMIN_ORGANIZATION_ID, requestId },
        }),
      );
      expect(command).toMatchObject({
        actorRef,
        method: 'POST',
        action: 'team.create',
        entityType: 'Team',
        entityId: response.body.data.id,
      });

      const audit = await asSystem('e2e audit row', () =>
        prisma().auditLog.findFirst({
          where: { entityType: 'Team', entityId: response.body.data.id, action: 'team.created' },
        }),
      );
      // The external reference is recorded, and actor_user_id stays null —
      // that column has a foreign key to real users.
      expect(audit?.externalActorRef).toBe(actorRef);
      expect(audit?.actorUserId).toBeNull();
    });

    it('does not record a ledger row for a read', async () => {
      const requestId = unique('cmd');
      await send('get', `${BASE}/summary`, { requestId });

      const ledger = await asSystem('e2e read ledger', () =>
        prisma().adminControlCommand.count({
          where: { organizationId: ADMIN_ORGANIZATION_ID, requestId },
        }),
      );
      // A read changes nothing; recording every one would bury the commands
      // that matter.
      expect(ledger).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // The domain rules still apply
  // ---------------------------------------------------------------------------

  describe('domain operations', () => {
    const createTeam = async (name = unique('Team')) => {
      const response = await send('post', `${BASE}/teams`, { body: { name } });
      expect(response.status).toBe(201);
      return response.body.data.id as string;
    };

    it('creates, reads and updates a team', async () => {
      const id = await createTeam();

      const updated = await send('patch', `${BASE}/teams/${id}`, {
        body: { description: 'Handled by the control plane' },
      });
      expect(updated.status).toBe(200);
      expect(updated.body.data.description).toBe('Handled by the control plane');

      const read = await send('get', `${BASE}/teams/${id}`);
      expect(read.body.data.id).toBe(id);
    });

    it('adds, toggles and removes a team member', async () => {
      const id = await createTeam();

      const added = await send('post', `${BASE}/teams/${id}/members`, {
        body: { userId: members[0] },
      });
      expect(added.status).toBe(201);

      const memberId = added.body.data.members[0].id as string;
      expect(added.body.data.members[0].eligibleForAssignment).toBe(true);

      const toggled = await send('patch', `${BASE}/teams/${id}/members/${memberId}`, {
        body: { assignmentEnabled: false },
      });
      expect(toggled.status).toBe(200);
      expect(toggled.body.data.members[0].eligibleForAssignment).toBe(false);

      const removed = await send('post', `${BASE}/teams/${id}/members/${memberId}/remove`, {
        body: {},
      });
      expect(removed.status).toBe(200);
      expect(removed.body.data.members).toHaveLength(0);
    });

    it('lists the organization’s members as assignment candidates', async () => {
      const response = await send('get', `${BASE}/agents`);

      expect(response.status).toBe(200);
      const ids = (response.body.data as { userId: string }[]).map((row) => row.userId);
      expect(ids).toEqual(expect.arrayContaining(members));
    });

    it('creates a rule and previews it without side effects', async () => {
      const teamId = await createTeam();
      await send('post', `${BASE}/teams/${teamId}/members`, { body: { userId: members[0] } });

      const rule = await send('post', `${BASE}/assignment-rules`, {
        body: { name: unique('Website'), source: 'WEBSITE', targetTeamId: teamId },
      });
      expect(rule.status).toBe(201);

      const before = await asSystem('e2e before preview', () =>
        prisma().lead.count({ where: { organizationId: ADMIN_ORGANIZATION_ID } }),
      );

      const preview = await send('post', `${BASE}/assignment-rules/preview`, {
        body: { source: 'WEBSITE' },
      });
      expect(preview.status).toBe(200);
      expect(preview.body.data.decision).toBe('MATCHED');

      const after = await asSystem('e2e after preview', () =>
        prisma().lead.count({ where: { organizationId: ADMIN_ORGANIZATION_ID } }),
      );
      expect(after).toBe(before);

      // And no ledger row: a preview is a question, whatever its HTTP verb.
      const ledger = await asSystem('e2e preview ledger', () =>
        prisma().adminControlCommand.count({
          where: { organizationId: ADMIN_ORGANIZATION_ID, action: { contains: 'preview' } },
        }),
      );
      expect(ledger).toBe(0);
    });

    it('refuses to archive a team that live routing points at', async () => {
      const teamId = await createTeam();
      await send('post', `${BASE}/teams/${teamId}/members`, { body: { userId: members[0] } });

      const ruleName = unique('Still routing');
      await send('post', `${BASE}/assignment-rules`, {
        body: { name: ruleName, isFallback: true, targetTeamId: teamId },
      });

      const response = await send('patch', `${BASE}/teams/${teamId}`, {
        body: { status: 'ARCHIVED' },
      });

      // The SAME refusal a person gets on the web, from the same method.
      // "Admin" is not a reason to bypass an invariant.
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body.error)).toContain(ruleName);
    });

    it('creates a territory, covers a place and resolves it', async () => {
      const territory = await send('post', `${BASE}/territories`, {
        body: { name: unique('India') },
      });
      expect(territory.status).toBe(201);

      const covered = await send('post', `${BASE}/territories/${territory.body.data.id}/coverage`, {
        body: { type: 'COUNTRY', country: 'IN' },
      });
      expect(covered.status).toBe(201);

      const resolved = await send('post', `${BASE}/territories/resolve`, {
        body: { country: 'IN' },
      });
      expect(resolved.status).toBe(200);
      expect(resolved.body.data).toMatchObject({
        decision: 'MATCHED',
        territory: { id: territory.body.data.id },
      });

      const coverageId = covered.body.data.coverage[0].id as string;
      const removed = await send(
        'post',
        `${BASE}/territories/${territory.body.data.id}/coverage/${coverageId}/remove`,
        { body: {} },
      );
      expect(removed.status).toBe(200);
      expect(removed.body.data.coverageCount).toBe(0);
    });

    it('lists and reads website enquiries', async () => {
      const intake = await asSystem('e2e admin intake', () =>
        prisma().integrationIntake.create({
          data: {
            organizationId: ADMIN_ORGANIZATION_ID,
            source: 'WEBSITE',
            externalEventId: unique('evt'),
            eventType: 'ENQUIRY',
            payloadHash: 'e'.repeat(64),
            status: 'BLOCKED',
            name: 'Dana Whitfield',
            message: 'Can we see a demo?',
          },
          select: { id: true },
        }),
      );

      const list = await send('get', `${BASE}/intakes`);
      expect(list.status).toBe(200);
      expect((list.body.data.items as { id: string }[]).map((row) => row.id)).toContain(intake.id);

      const detail = await send('get', `${BASE}/intakes/${intake.id}`);
      expect(detail.body.data.message).toBe('Can we see a demo?');
      // Nothing from the signed boundary that received it.
      expect(detail.body.data).not.toHaveProperty('payloadHash');
      expect(detail.body.data).not.toHaveProperty('externalEventId');
    });

    it('retries a blocked enquiry, and will not force a duplicate', async () => {
      const blocked = await asSystem('e2e blocked intake', () =>
        prisma().integrationIntake.create({
          data: {
            organizationId: ADMIN_ORGANIZATION_ID,
            source: 'WEBSITE',
            externalEventId: unique('evt'),
            eventType: 'ENQUIRY',
            payloadHash: 'f'.repeat(64),
            status: 'BLOCKED',
            name: 'Ravi Menon',
          },
          select: { id: true },
        }),
      );

      const retried = await send('post', `${BASE}/intakes/${blocked.id}/retry`, { body: {} });
      expect(retried.status).toBe(200);
      // No routing configured for it in this tenant beyond what other cases
      // created, so the honest outcome is a durable, explained state.
      expect(['CONVERTED', 'BLOCKED', 'SKIPPED']).toContain(retried.body.data.result);

      const duplicate = await asSystem('e2e duplicate intake', () =>
        prisma().integrationIntake.create({
          data: {
            organizationId: ADMIN_ORGANIZATION_ID,
            source: 'WEBSITE',
            externalEventId: unique('evt'),
            eventType: 'ENQUIRY',
            payloadHash: 'a'.repeat(64),
            status: 'DUPLICATE',
            name: 'Priya Nair',
          },
          select: { id: true },
        }),
      );

      const refused = await send('post', `${BASE}/intakes/${duplicate.id}/retry`, { body: {} });
      // A duplicate is a decision waiting for a person. The control plane does
      // not overrule it because the caller is an administrator.
      expect(refused.status).toBe(400);
    });

    it('reports a summary of counts, and no credentials', async () => {
      const response = await send('get', `${BASE}/summary`);

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        activeTeams: expect.any(Number),
        eligibleAgents: expect.any(Number),
        activeAssignmentRules: expect.any(Number),
        activeTerritories: expect.any(Number),
        intakeAutoProcessingEnabled: expect.any(Boolean),
      });
      expect(response.body.data.intakes).toMatchObject({
        received: expect.any(Number),
        blocked: expect.any(Number),
        duplicate: expect.any(Number),
        failed: expect.any(Number),
      });

      const serialised = JSON.stringify(response.body);
      expect(serialised).not.toContain(ADMIN_SECRET);
      expect(serialised).not.toMatch(/postgres|redis:|SMTP|password/i);
    });

    it('counts only the administered organization', async () => {
      // Org A has teams of its own from other suites in this file's process;
      // the summary must not see them.
      const summary = await send('get', `${BASE}/summary`);

      const ours = await asSystem('e2e our teams', () =>
        prisma().team.count({
          where: { organizationId: ADMIN_ORGANIZATION_ID, status: 'ACTIVE' },
        }),
      );
      expect(summary.body.data.activeTeams).toBe(ours);
    });
  });

  // ---------------------------------------------------------------------------
  // What is deliberately absent
  // ---------------------------------------------------------------------------

  describe('the surface is an allowlist', () => {
    it.each([
      ['a generic proxy', 'post', `${BASE}/proxy`],
      ['arbitrary lead mutation', 'post', `${BASE}/leads`],
      ['user creation', 'post', `${BASE}/users`],
      ['configuration', 'patch', `${BASE}/settings`],
    ])('offers no %s', async (_label, method, path) => {
      const response = await send(method as 'post' | 'patch', path, { body: {} });

      // 404: the route does not exist. Nothing here dispatches on a name.
      expect(response.status).toBe(404);
    });

    it('offers no way to edit the rotation cursor', async () => {
      const response = await send('patch', `${BASE}/teams/cursor`, { body: { sequence: 0 } });

      /*
       * 400, from the uuid pipe on `teams/:id` — there is no cursor route to
       * reach, so "cursor" is read as a team id and refused before any
       * handler runs. Either answer would do; what matters is that no
       * request reaches code able to write a sequence.
       *
       * Rotation position is an internal mechanism. An administrator needs to
       * see which team and which agent an enquiry went to, which the intake
       * detail already shows — not a textbox saying "next = 57".
       */
      expect([400, 404]).toContain(response.status);

      const cursors = await asSystem('e2e cursor untouched', () =>
        prisma().teamAssignmentCursor.findMany({
          where: { organizationId: ADMIN_ORGANIZATION_ID },
          select: { sequence: true },
        }),
      );
      for (const cursor of cursors) {
        expect(cursor.sequence >= 0n).toBe(true);
      }
    });
  });
});
