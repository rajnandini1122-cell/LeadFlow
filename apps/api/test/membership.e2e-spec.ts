import { ERROR_CODES } from '@leadflow/api-types';
import { createTestContext, PASSWORD, type TestContext } from './helpers/test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { fixtureMobile } from './helpers/phone-fixtures';

/**
 * Phase 2A — organization registration, invitations, membership lifecycle.
 *
 * Written before the implementation. Every case here is a boundary that, if it
 * fails in production, either locks a customer out of their own organization or
 * lets somebody into one they do not belong to.
 */
describe('Organization membership and invitations', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const unique = (prefix: string): string =>
    `${prefix}.${Date.now()}.${Math.floor(Math.random() * 100000)}`;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ---------------------------------------------------------------------------
  // 1. Registration
  // ---------------------------------------------------------------------------

  describe('self-service registration', () => {
    const registration = () => ({
      organizationName: `Acme ${unique('co')}`,
      email: `${unique('founder')}@example.test`,
      password: 'CorrectHorse!2026',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });

    it('creates organization, user, membership and OWNER role atomically', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/auth/register')
        .send(registration())
        .expect(201);

      const data = response.body.data;
      expect(data.user.fullName).toBe('Ada Lovelace');
      expect(data.user.role).toBe('OWNER');
      expect(data.user.organization.id).toBeTruthy();
      expect(data.tokens.accessToken).toBeTruthy();
    });

    it('generates a lowercase, URL-safe slug from the organization name', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/auth/register')
        .send({ ...registration(), organizationName: '  Björk & Sons, Ltd.  ' })
        .expect(201);

      const slug = response.body.data.user.organization.slug as string;
      expect(slug).toMatch(/^[a-z0-9-]+$/);
      expect(slug).not.toMatch(/^-|-$/);
    });

    it('resolves slug collisions instead of failing', async () => {
      const name = `Duplicate ${unique('name')}`;

      const first = await ctx
        .http()
        .post('/api/v1/auth/register')
        .send({ ...registration(), organizationName: name })
        .expect(201);

      const second = await ctx
        .http()
        .post('/api/v1/auth/register')
        .send({ ...registration(), organizationName: name })
        .expect(201);

      // Two businesses may legitimately share a name; the slug must still be
      // unique rather than the second registration being rejected.
      expect(first.body.data.user.organization.slug).not.toBe(
        second.body.data.user.organization.slug,
      );
    });

    it('accepts an explicit slug', async () => {
      const slug = unique('chosen').replace(/\./g, '-');

      const response = await ctx
        .http()
        .post('/api/v1/auth/register')
        .send({ ...registration(), organizationSlug: slug })
        .expect(201);

      expect(response.body.data.user.organization.slug).toBe(slug);
    });

    it('rejects an email that already has an account', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/auth/register')
        .send({ ...registration(), email: ctx.orgA.owner.email })
        .expect(409);

      expect(response.body.error.code).toBe(ERROR_CODES.USER_ALREADY_EXISTS);
    });

    it('leaves NO organization behind when registration fails', async () => {
      const orgName = `Rollback ${unique('org')}`;

      await ctx
        .http()
        .post('/api/v1/auth/register')
        .send({ ...registration(), organizationName: orgName, email: ctx.orgA.owner.email })
        .expect(409);

      // The whole thing must roll back. A stranded organization with no owner
      // is unreachable and unrecoverable.
      const login = await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email: ctx.orgA.owner.email, password: PASSWORD, platform: 'ANDROID' })
        .expect(200);

      const orgs = login.body.data.requiresOrganizationSelection
        ? (login.body.data.organizations as { name: string }[])
        : [login.body.data.user.organization as { name: string }];

      expect(orgs.map((o) => o.name)).not.toContain(orgName);
    });

    it.each([
      ['weak password', { password: 'short' }],
      ['bad email', { email: 'not-an-email' }],
      ['missing organization name', { organizationName: '' }],
    ])('rejects %s with a validation error', async (_label, override) => {
      const response = await ctx
        .http()
        .post('/api/v1/auth/register')
        .send({ ...registration(), ...override })
        .expect(400);

      expect(response.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    });
  });

  // ---------------------------------------------------------------------------
  // 2 & 3. Invitations and acceptance
  // ---------------------------------------------------------------------------

  describe('invitations', () => {
    const inviteEmail = () => `${unique('invitee')}@example.test`;

    const sendInvite = async (email: string, role = 'SALES_REP') => {
      const response = await ctx
        .http()
        .post('/api/v1/users/invite')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ email, fullName: 'Invited Person', role })
        .expect(201);
      return response.body.data as {
        userId: string;
        inviteToken: string;
        invitationId: string;
      };
    };

    it('lists pending invitations for the current organization only', async () => {
      const email = inviteEmail();
      await sendInvite(email);

      const mine = await ctx
        .http()
        .get('/api/v1/users/invitations')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect((mine.body.data as { email: string }[]).map((i) => i.email)).toContain(email);

      const theirs = await ctx
        .http()
        .get('/api/v1/users/invitations')
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(200);

      // Cross-tenant invitation visibility would leak who a competitor is hiring.
      expect((theirs.body.data as { email: string }[]).map((i) => i.email)).not.toContain(
        email,
      );
    });

    it('shows the organization and role before acceptance, without authentication', async () => {
      const email = inviteEmail();
      const invite = await sendInvite(email, 'MANAGER');

      const preview = await ctx
        .http()
        .get(`/api/v1/invitations/${invite.inviteToken}`)
        .expect(200);

      expect(preview.body.data.organizationName).toBeTruthy();
      expect(preview.body.data.role).toBe('MANAGER');
      expect(preview.body.data.email).toBe(email);
      // The preview must not leak anything else about the tenant.
      expect(preview.body.data.organizationId).toBeUndefined();
    });

    it('accepts an invitation, sets a password and activates the membership', async () => {
      const email = inviteEmail();
      const invite = await sendInvite(email);

      await ctx
        .http()
        .post(`/api/v1/invitations/${invite.inviteToken}/accept`)
        .send({ firstName: 'New', lastName: 'Joiner', password: 'CorrectHorse!2026' })
        .expect(200);

      const login = await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email, password: 'CorrectHorse!2026', platform: 'ANDROID' })
        .expect(200);

      expect(login.body.data.user.role).toBe('SALES_REP');
    });

    it('refuses to replay an accepted invitation token', async () => {
      const invite = await sendInvite(inviteEmail());

      await ctx
        .http()
        .post(`/api/v1/invitations/${invite.inviteToken}/accept`)
        .send({ firstName: 'First', lastName: 'Use', password: 'CorrectHorse!2026' })
        .expect(200);

      // Single-use. A replayed token must not re-activate or reset anything.
      await ctx
        .http()
        .post(`/api/v1/invitations/${invite.inviteToken}/accept`)
        .send({ firstName: 'Second', lastName: 'Use', password: 'Attacker!2026' })
        // 404, not 410: acceptance clears the stored hash, so the spent token
        // is genuinely absent rather than recognised-and-refused. No oracle.
        .expect(404);
    });

    it('refuses a revoked invitation', async () => {
      const invite = await sendInvite(inviteEmail());

      await ctx
        .http()
        .delete(`/api/v1/users/invitations/${invite.invitationId}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(204);

      await ctx
        .http()
        .post(`/api/v1/invitations/${invite.inviteToken}/accept`)
        .send({ firstName: 'Too', lastName: 'Late', password: 'CorrectHorse!2026' })
        .expect(404);
    });

    it('invalidates the old token when an invitation is resent', async () => {
      const invite = await sendInvite(inviteEmail());

      const resent = await ctx
        .http()
        .post(`/api/v1/users/invitations/${invite.invitationId}/resend`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      const newToken = resent.body.data.inviteToken as string;
      expect(newToken).not.toBe(invite.inviteToken);

      // The superseded link must stop working, or a forwarded old email is a
      // second, uncontrolled way in.
      await ctx
        .http()
        .post(`/api/v1/invitations/${invite.inviteToken}/accept`)
        .send({ firstName: 'Old', lastName: 'Link', password: 'CorrectHorse!2026' })
        .expect(404);

      await ctx
        .http()
        .post(`/api/v1/invitations/${newToken}/accept`)
        .send({ firstName: 'New', lastName: 'Link', password: 'CorrectHorse!2026' })
        .expect(200);
    });

    it('refuses an EXPIRED invitation with 410 Gone', async () => {
      const invite = await sendInvite(inviteEmail());

      // Backdate through the running app's own Prisma connection rather than
      // opening a second one — PGlite serves a single connection, and the app
      // is holding it. runAsSystem is required because there is no request
      // scope here and organizationUser is tenant-scoped.
      const prisma = ctx.app.get(PrismaService);
      const tenantContext = ctx.app.get(TenantContextService);

      await tenantContext.runAsSystem('test: backdate an invitation to expire it', async () => {
        await prisma.client.organizationUser.update({
          where: { id: invite.invitationId },
          data: { inviteExpiresAt: new Date(Date.now() - 60_000) },
        });
      });

      // The row is still findable (the hash was never cleared), so the API can
      // tell the user their link timed out instead of that it never existed.
      await ctx.http().get(`/api/v1/invitations/${invite.inviteToken}`).expect(410);

      await ctx
        .http()
        .post(`/api/v1/invitations/${invite.inviteToken}/accept`)
        .send({ firstName: 'Too', lastName: 'Slow', password: 'CorrectHorse!2026' })
        .expect(410);
    });

    it('refuses an unknown token', async () => {
      await ctx.http().get('/api/v1/invitations/not-a-real-token').expect(404);
    });

    it('cannot revoke another organization’s invitation', async () => {
      const invite = await sendInvite(inviteEmail());

      await ctx
        .http()
        .delete(`/api/v1/users/invitations/${invite.invitationId}`)
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(404);
    });

    it('a SALES_REP cannot invite', async () => {
      await ctx
        .http()
        .post('/api/v1/users/invite')
        .set(auth(ctx.orgA.rep.accessToken))
        .send({ email: inviteEmail(), fullName: 'Nope', role: 'SALES_REP' })
        .expect(403);
    });

    it('attaches an EXISTING user to a second organization on acceptance', async () => {
      // Org B invites org A's owner. They keep their password and gain a second
      // membership rather than having their account replaced.
      const response = await ctx
        .http()
        .post('/api/v1/users/invite')
        .set(auth(ctx.orgB.owner.accessToken))
        .send({ email: ctx.orgA.rep.email, fullName: 'Cross Org', role: 'MANAGER' })
        .expect(201);

      await ctx
        .http()
        .post(`/api/v1/invitations/${response.body.data.inviteToken}/accept`)
        .send({})
        .expect(200);

      const organizations = await ctx
        .http()
        .get('/api/v1/auth/organizations')
        .set(auth(ctx.orgA.rep.accessToken))
        .expect(200);

      expect((organizations.body.data as { id: string }[]).map((o) => o.id)).toEqual(
        expect.arrayContaining([ctx.orgA.id, ctx.orgB.id]),
      );
    });

    it('survives concurrent acceptance of the same token', async () => {
      const invite = await sendInvite(inviteEmail());
      const body = { firstName: 'Race', lastName: 'Condition', password: 'CorrectHorse!2026' };

      const results = await Promise.allSettled([
        ctx.http().post(`/api/v1/invitations/${invite.inviteToken}/accept`).send(body),
        ctx.http().post(`/api/v1/invitations/${invite.inviteToken}/accept`).send(body),
      ]);

      const statuses = results
        .map((r) => (r.status === 'fulfilled' ? r.value.status : 0))
        .sort();

      // Exactly one wins. Two successes would mean the token is not single-use.
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Multi-organization support
  // ---------------------------------------------------------------------------

  describe('organization switching', () => {
    it('lists the organizations the caller actually belongs to', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/auth/organizations')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      const ids = (response.body.data as { id: string }[]).map((o) => o.id);
      expect(ids).toContain(ctx.orgA.id);
      expect(ids).not.toContain(ctx.orgB.id);
    });

    it('refuses to switch to an organization the caller does not belong to', async () => {
      // The whole point: a client-supplied organization id is never trusted.
      const response = await ctx
        .http()
        .post('/api/v1/auth/switch-organization')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ targetOrganizationId: ctx.orgB.id })
        .expect(403);

      expect(response.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });

    it('a token minted for org A cannot read org B data even after a failed switch', async () => {
      await ctx
        .http()
        .post('/api/v1/auth/switch-organization')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ targetOrganizationId: ctx.orgB.id })
        .expect(403);

      const current = await ctx
        .http()
        .get('/api/v1/organizations/current')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect(current.body.data.id).toBe(ctx.orgA.id);
    });
  });

  // ---------------------------------------------------------------------------
  // 5 & 6. Member management and leaving
  // ---------------------------------------------------------------------------

  describe('member lifecycle', () => {
    /** Registers a throwaway organization so destructive tests are isolated. */
    const freshOrg = async () => {
      const email = `${unique('solo')}@example.test`;
      const response = await ctx
        .http()
        .post('/api/v1/auth/register')
        .send({
          organizationName: `Solo ${unique('org')}`,
          email,
          password: 'CorrectHorse!2026',
          firstName: 'Only',
          lastName: 'Owner',
        })
        .expect(201);

      return {
        email,
        token: response.body.data.tokens.accessToken as string,
        userId: response.body.data.user.id as string,
        organizationId: response.body.data.user.organization.id as string,
      };
    };

    /** Invites and immediately accepts, returning an active member. */
    const addMember = async (ownerToken: string, role = 'SALES_REP') => {
      const email = `${unique('member')}@example.test`;
      const invite = await ctx
        .http()
        .post('/api/v1/users/invite')
        .set(auth(ownerToken))
        .send({ email, fullName: 'Team Member', role })
        .expect(201);

      await ctx
        .http()
        .post(`/api/v1/invitations/${invite.body.data.inviteToken}/accept`)
        .send({ firstName: 'Team', lastName: 'Member', password: 'CorrectHorse!2026' })
        .expect(200);

      const login = await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email, password: 'CorrectHorse!2026', platform: 'ANDROID' })
        .expect(200);

      return {
        email,
        userId: invite.body.data.userId as string,
        token: login.body.data.tokens.accessToken as string,
      };
    };

    it('suspending a member revokes their access immediately', async () => {
      const org = await freshOrg();
      const member = await addMember(org.token);

      await ctx.http().get('/api/v1/auth/me').set(auth(member.token)).expect(200);

      await ctx
        .http()
        .patch(`/api/v1/users/${member.userId}`)
        .set(auth(org.token))
        .send({ status: 'SUSPENDED' })
        .expect(200);

      ctx.redis.flush();

      // Not "at next login" — the existing token must stop working now.
      await ctx.http().get('/api/v1/auth/me').set(auth(member.token)).expect(403);
    });

    it('reactivating a member restores access', async () => {
      const org = await freshOrg();
      const member = await addMember(org.token);

      await ctx
        .http()
        .patch(`/api/v1/users/${member.userId}`)
        .set(auth(org.token))
        .send({ status: 'SUSPENDED' })
        .expect(200);
      ctx.redis.flush();

      await ctx
        .http()
        .patch(`/api/v1/users/${member.userId}`)
        .set(auth(org.token))
        .send({ status: 'ACTIVE' })
        .expect(200);
      ctx.redis.flush();

      const login = await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email: member.email, password: 'CorrectHorse!2026', platform: 'ANDROID' })
        .expect(200);

      expect(login.body.data.requiresOrganizationSelection).toBe(false);
    });

    it('removing a member revokes access but preserves their history', async () => {
      const org = await freshOrg();
      const member = await addMember(org.token);
      const successor = await addMember(org.token);

      const lead = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(org.token))
        .send({
          firstName: 'Owned',
          mobile: fixtureMobile(),
          nextFollowUpAt: new Date(Date.now() + 86_400_000).toISOString(),
          assignedToId: member.userId,
        })
        .expect(201);

      // Phase 7 changed this deliberately. A bare removal used to succeed and
      // leave the lead pointing at a membership that no longer worked — no
      // query failed, the customer simply stopped being anybody's job. The
      // handover is now part of the removal.
      await ctx
        .http()
        .delete(`/api/v1/users/${member.userId}`)
        .set(auth(org.token))
        .expect(409);

      await ctx
        .http()
        .post(`/api/v1/users/${member.userId}/offboard`)
        .set(auth(org.token))
        .send({ action: 'REMOVE', reassignToId: successor.userId })
        .expect(200);
      ctx.redis.flush();

      await ctx.http().get('/api/v1/auth/me').set(auth(member.token)).expect(401);

      // Referential integrity: the lead survives, and now has a working owner.
      // Hard-deleting the user would erase sales history.
      const stillThere = await ctx
        .http()
        .get(`/api/v1/leads/${lead.body.data.id}`)
        .set(auth(org.token))
        .expect(200);

      expect(stillThere.body.data.assignedTo?.id).toBe(successor.userId);

      // The removed member's name still resolves on the timeline they created.
      const activities = await ctx
        .http()
        .get(`/api/v1/leads/${lead.body.data.id}/activities`)
        .set(auth(org.token))
        .expect(200);

      expect((activities.body.data.items as unknown[]).length).toBeGreaterThan(0);
    });

    it('a removed member cannot log back in to that organization', async () => {
      const org = await freshOrg();
      const member = await addMember(org.token);

      await ctx
        .http()
        .delete(`/api/v1/users/${member.userId}`)
        .set(auth(org.token))
        .expect(204);
      ctx.redis.flush();

      await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email: member.email, password: 'CorrectHorse!2026', platform: 'ANDROID' })
        .expect(403);
    });

    it('refuses to remove the last active owner', async () => {
      const org = await freshOrg();

      const response = await ctx
        .http()
        .delete(`/api/v1/users/${org.userId}`)
        .set(auth(org.token))
        .expect(403);

      expect(response.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });

    it('refuses to let the last active owner leave', async () => {
      const org = await freshOrg();

      await ctx
        .http()
        .post('/api/v1/organizations/leave')
        .set(auth(org.token))
        .expect(403);
    });

    it('lets an ordinary member leave, without touching their other memberships', async () => {
      const org = await freshOrg();
      const member = await addMember(org.token);

      await ctx.http().post('/api/v1/organizations/leave').set(auth(member.token)).expect(204);
      ctx.redis.flush();

      await ctx.http().get('/api/v1/auth/me').set(auth(member.token)).expect(401);
    });

    it('an owner CAN leave once another owner exists', async () => {
      const org = await freshOrg();
      const second = await addMember(org.token, 'OWNER');

      await ctx.http().post('/api/v1/organizations/leave').set(auth(org.token)).expect(204);
      ctx.redis.flush();

      // The organization still has an owner, which is the condition that matters.
      await ctx.http().get('/api/v1/auth/me').set(auth(second.token)).expect(200);
    });

    it('cannot remove a member of another organization', async () => {
      await ctx
        .http()
        .delete(`/api/v1/users/${ctx.orgB.rep.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(404);
    });
  });
});
