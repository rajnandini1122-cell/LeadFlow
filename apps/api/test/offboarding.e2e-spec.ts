import { ERROR_CODES } from '@leadflow/api-types';
import {
  createTestContext,
  PASSWORD,
  registerVerifiedOrganization,
  type TestContext,
} from './helpers/test-app';
import { fixtureMobile } from './helpers/phone-fixtures';

/**
 * Phase 7 — organization administration, employee exit and lead reassignment.
 *
 * Written before the implementation. Two failure modes drive every case here,
 * and both are silent:
 *
 *   1. An organization left with nobody able to administer it. Nothing errors;
 *      the customer simply discovers one day that no one can invite, remove or
 *      configure anything, and there is no in-product way back.
 *
 *   2. A salesperson leaves and their fifty active leads keep pointing at a
 *      membership that no longer works. No query fails — the leads just stop
 *      appearing in anyone's list, and the follow-ups stop being anyone's job.
 *      That is the exact promise the product exists to keep.
 */
describe('Organization administration and employee exit', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const unique = (prefix: string): string =>
    `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`;

  const mobile = (): string => fixtureMobile();

  const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();

  interface Member {
    email: string;
    userId: string;
    token: string;
  }

  interface Org {
    organizationId: string;
    ownerId: string;
    token: string;
  }

  /** A brand-new organization with exactly one owner. */
  const freshOrg = async (): Promise<Org> => {
    const created = await registerVerifiedOrganization(ctx.app, {
      organizationName: `Exit ${unique('org')}`,
      email: `${unique('founder')}@example.test`,
      password: PASSWORD,
      firstName: 'Olive',
      lastName: 'Owner',
    });

    return {
      organizationId: created.registration.body.data.user.organization.id as string,
      ownerId: created.registration.body.data.user.id as string,
      token: created.tokens.accessToken as string,
    };
  };

  /** Invites and immediately accepts, returning an ACTIVE member with a token. */
  const addMember = async (ownerToken: string, role = 'SALES_REP'): Promise<Member> => {
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
      .send({ firstName: 'Team', lastName: 'Member', password: PASSWORD })
      .expect(200);

    const login = await ctx
      .http()
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD, platform: 'ANDROID' })
      .expect(200);

    return {
      email,
      userId: invite.body.data.userId as string,
      token: login.body.data.tokens.accessToken as string,
    };
  };

  /** A lead assigned to `assignedToId`, with one open follow-up on it. */
  const seedWork = async (
    token: string,
    assignedToId: string,
    options: { withFollowUp?: boolean; status?: 'WON' | 'LOST' } = {},
  ): Promise<{ leadId: string; followUpId?: string }> => {
    const lead = await ctx
      .http()
      .post('/api/v1/leads')
      .set(auth(token))
      .send({
        firstName: 'Work',
        lastName: 'Item',
        mobile: mobile(),
        estimatedValue: 1000,
        nextFollowUpAt: inDays(3),
        assignedToId,
      })
      .expect(201);

    const leadId = lead.body.data.id as string;
    let followUpId: string | undefined;

    if (options.withFollowUp) {
      const followUp = await ctx
        .http()
        .post(`/api/v1/leads/${leadId}/follow-ups`)
        .set(auth(token))
        .send({ scheduledAt: inDays(2), type: 'CALL', title: 'Check in' })
        .expect(201);

      followUpId = followUp.body.data.id as string;
    }

    if (options.status) {
      await ctx
        .http()
        .patch(`/api/v1/leads/${leadId}`)
        .set(auth(token))
        .send(
          options.status === 'WON'
            ? { status: 'WON', wonValue: 1000 }
            : { status: 'LOST', lostReason: 'Went elsewhere' },
        )
        .expect(200);
    }

    return followUpId === undefined ? { leadId } : { leadId, followUpId };
  };

  const workloadOf = async (token: string, userId: string) => {
    const response = await ctx
      .http()
      .get(`/api/v1/users/${userId}/workload`)
      .set(auth(token))
      .expect(200);
    return response.body.data;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ---------------------------------------------------------------------------
  // 1. Admin protection — the organization must never become unadministrable
  // ---------------------------------------------------------------------------

  describe('admin protection', () => {
    it('refuses to remove the last administrator', async () => {
      const org = await freshOrg();
      await addMember(org.token);

      // A rep cannot administer anything, so removing the sole owner would
      // strand the organization even though a member remains.
      //
      // Two guards stand in the way and either is sufficient: self-removal is
      // redirected to "leave" so it carries an explicit confirmation, and the
      // administrator-retention rule refuses it underneath. The assertion is
      // on the OUTCOME rather than on which guard spoke first, because both
      // are correct and their order is an implementation detail.
      await ctx.http().delete(`/api/v1/users/${org.ownerId}`).set(auth(org.token)).expect(403);

      const members = await ctx.http().get('/api/v1/users').set(auth(org.token)).expect(200);
      const row = (members.body.data as { id: string; status: string; role: string }[]).find(
        (m) => m.id === org.ownerId,
      );

      expect(row?.status).toBe('ACTIVE');
      expect(row?.role).toBe('OWNER');
    });

    it('refuses an admin removing the last owner', async () => {
      const org = await freshOrg();
      const admin = await addMember(org.token, 'ADMIN');

      // An admin remains, so the organization is still administrable — but
      // only an OWNER can appoint an owner, so losing the last one is a trap
      // with no way back.
      await ctx
        .http()
        .delete(`/api/v1/users/${org.ownerId}`)
        .set(auth(admin.token))
        .expect(403);

      const members = await ctx.http().get('/api/v1/users').set(auth(admin.token)).expect(200);
      expect(
        (members.body.data as { id: string; role: string }[]).find((m) => m.id === org.ownerId)
          ?.role,
      ).toBe('OWNER');
    });

    it('refuses to let the last administrator leave', async () => {
      const org = await freshOrg();
      await addMember(org.token);

      const response = await ctx
        .http()
        .post('/api/v1/organizations/leave')
        .set(auth(org.token))
        .expect(403);

      expect(response.body.error.code).toBe(ERROR_CODES.LAST_ADMINISTRATOR);
    });

    it('refuses to deactivate the last administrator', async () => {
      const org = await freshOrg();
      const second = await addMember(org.token, 'OWNER');

      // The second owner suspends the first — leaving one owner, which is fine.
      await ctx
        .http()
        .patch(`/api/v1/users/${org.ownerId}`)
        .set(auth(second.token))
        .send({ status: 'SUSPENDED' })
        .expect(200);

      // Now the second owner is the only administrator left, and a third party
      // trying to suspend them must be refused.
      const admin = await addMember(second.token, 'ADMIN');
      const response = await ctx
        .http()
        .patch(`/api/v1/users/${second.userId}`)
        .set(auth(admin.token))
        .send({ status: 'SUSPENDED' })
        .expect(403);

      expect(response.body.error.code).toBe(ERROR_CODES.LAST_ADMINISTRATOR);
    });

    it('refuses to demote the last administrator', async () => {
      const org = await freshOrg();
      const second = await addMember(org.token, 'OWNER');

      await ctx
        .http()
        .patch(`/api/v1/users/${org.ownerId}`)
        .set(auth(second.token))
        .send({ role: 'SALES_REP' })
        .expect(200);

      // One owner left. Demoting them would leave nobody who can grant the
      // role back, which is the trap this rule exists to prevent. Self-role
      // changes are separately refused, so this asserts the outcome.
      await ctx
        .http()
        .patch(`/api/v1/users/${second.userId}`)
        .set(auth(second.token))
        .send({ role: 'SALES_REP' })
        .expect(403);

      const me = await ctx.http().get('/api/v1/auth/me').set(auth(second.token)).expect(200);
      expect(me.body.data.role).toBe('OWNER');
    });

    it('refuses an admin demoting the last owner', async () => {
      const org = await freshOrg();
      const admin = await addMember(org.token, 'ADMIN');

      const response = await ctx
        .http()
        .patch(`/api/v1/users/${org.ownerId}`)
        .set(auth(admin.token))
        .send({ role: 'SALES_REP' })
        .expect(403);

      expect(response.body.error.code).toBe(ERROR_CODES.FORBIDDEN);

      const members = await ctx.http().get('/api/v1/users').set(auth(admin.token)).expect(200);
      expect(
        (members.body.data as { id: string; role: string }[]).find((m) => m.id === org.ownerId)
          ?.role,
      ).toBe('OWNER');
    });

    it('allows removing one administrator when another remains', async () => {
      const org = await freshOrg();
      const second = await addMember(org.token, 'OWNER');

      await ctx
        .http()
        .delete(`/api/v1/users/${second.userId}`)
        .set(auth(org.token))
        .expect(204);

      const members = await ctx
        .http()
        .get('/api/v1/users')
        .set(auth(org.token))
        .expect(200);

      expect(
        (members.body.data as { id: string }[]).some((m) => m.id === second.userId),
      ).toBe(false);
    });

    it('allows demoting one administrator when another remains', async () => {
      const org = await freshOrg();
      const second = await addMember(org.token, 'OWNER');

      const response = await ctx
        .http()
        .patch(`/api/v1/users/${second.userId}`)
        .set(auth(org.token))
        .send({ role: 'SALES_REP' })
        .expect(200);

      expect(response.body.data.role).toBe('SALES_REP');
    });

    it('never lets an organization reach zero active administrators', async () => {
      const org = await freshOrg();
      const rep = await addMember(org.token);

      // Every route out of being an administrator, one at a time.
      await ctx.http().delete(`/api/v1/users/${org.ownerId}`).set(auth(org.token)).expect(403);
      await ctx.http().post('/api/v1/organizations/leave').set(auth(org.token)).expect(403);
      await ctx
        .http()
        .patch(`/api/v1/users/${org.ownerId}`)
        .set(auth(org.token))
        .send({ status: 'SUSPENDED' })
        .expect(403);
      await ctx
        .http()
        .patch(`/api/v1/users/${org.ownerId}`)
        .set(auth(org.token))
        .send({ role: 'SALES_REP' })
        .expect(403);

      const members = await ctx.http().get('/api/v1/users').set(auth(org.token)).expect(200);
      const admins = (members.body.data as { id: string; role: string; status: string }[]).filter(
        (m) => ['OWNER', 'ADMIN'].includes(m.role) && m.status === 'ACTIVE',
      );

      expect(admins).toHaveLength(1);
      expect(rep.userId).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------------
  // Admin transfer
  // ---------------------------------------------------------------------------

  describe('transferring admin responsibility', () => {
    it('promotes the successor and steps the caller down in one action', async () => {
      const org = await freshOrg();
      const successor = await addMember(org.token, 'MANAGER');

      const response = await ctx
        .http()
        .post('/api/v1/users/transfer-admin')
        .set(auth(org.token))
        .send({ toUserId: successor.userId, stepDown: true })
        .expect(200);

      expect(response.body.data.newAdminId).toBe(successor.userId);

      const members = await ctx
        .http()
        .get('/api/v1/users')
        .set(auth(successor.token))
        .expect(200);

      const rows = members.body.data as { id: string; role: string }[];
      expect(rows.find((m) => m.id === successor.userId)?.role).toBe('OWNER');
      // Stepping down is the point: one owner before, one owner after.
      expect(rows.find((m) => m.id === org.ownerId)?.role).toBe('ADMIN');
    });

    it('can promote without stepping down, leaving two administrators', async () => {
      const org = await freshOrg();
      const successor = await addMember(org.token, 'MANAGER');

      await ctx
        .http()
        .post('/api/v1/users/transfer-admin')
        .set(auth(org.token))
        .send({ toUserId: successor.userId, stepDown: false })
        .expect(200);

      const members = await ctx.http().get('/api/v1/users').set(auth(org.token)).expect(200);
      const owners = (members.body.data as { role: string }[]).filter((m) => m.role === 'OWNER');

      expect(owners).toHaveLength(2);
    });

    it('refuses to transfer to a member of another organization', async () => {
      const org = await freshOrg();

      const response = await ctx
        .http()
        .post('/api/v1/users/transfer-admin')
        .set(auth(org.token))
        .send({ toUserId: ctx.orgB.rep.id, stepDown: true })
        .expect(404);

      expect(response.body.error.code).toBe(ERROR_CODES.USER_NOT_FOUND);
    });

    it('refuses to transfer to a suspended member', async () => {
      const org = await freshOrg();
      const successor = await addMember(org.token, 'MANAGER');

      await ctx
        .http()
        .patch(`/api/v1/users/${successor.userId}`)
        .set(auth(org.token))
        .send({ status: 'SUSPENDED' })
        .expect(200);

      // Handing the organization to someone who cannot sign in is the same as
      // handing it to nobody.
      await ctx
        .http()
        .post('/api/v1/users/transfer-admin')
        .set(auth(org.token))
        .send({ toUserId: successor.userId, stepDown: true })
        .expect(400);
    });

    it('refuses a non-owner attempting the transfer', async () => {
      const org = await freshOrg();
      const admin = await addMember(org.token, 'ADMIN');
      const target = await addMember(org.token, 'MANAGER');

      await ctx
        .http()
        .post('/api/v1/users/transfer-admin')
        .set(auth(admin.token))
        .send({ toUserId: target.userId, stepDown: false })
        .expect(403);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Workload disclosure
  // ---------------------------------------------------------------------------

  describe('workload', () => {
    it('reports what a member is currently carrying', async () => {
      const org = await freshOrg();
      const rep = await addMember(org.token);

      await seedWork(org.token, rep.userId, { withFollowUp: true });
      await seedWork(org.token, rep.userId, { withFollowUp: true });
      await seedWork(org.token, rep.userId, { status: 'WON' });
      await seedWork(org.token, rep.userId, { status: 'LOST' });

      const workload = await workloadOf(org.token, rep.userId);

      expect(workload.activeLeads).toBe(2);
      expect(workload.openFollowUps).toBe(2);
      expect(workload.wonLeads).toBe(1);
      expect(workload.lostLeads).toBe(1);
      expect(workload.requiresReassignment).toBe(true);
    });

    it('reports nothing to hand over for a member with no work', async () => {
      const org = await freshOrg();
      const rep = await addMember(org.token);

      const workload = await workloadOf(org.token, rep.userId);

      expect(workload.activeLeads).toBe(0);
      expect(workload.openFollowUps).toBe(0);
      expect(workload.requiresReassignment).toBe(false);
    });

    it('refuses to disclose the workload of another organization’s member', async () => {
      const org = await freshOrg();

      await ctx
        .http()
        .get(`/api/v1/users/${ctx.orgB.rep.id}/workload`)
        .set(auth(org.token))
        .expect(404);
    });

    it('refuses a sales rep the workload endpoint', async () => {
      const org = await freshOrg();
      const rep = await addMember(org.token);

      await ctx
        .http()
        .get(`/api/v1/users/${rep.userId}/workload`)
        .set(auth(rep.token))
        .expect(403);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Employee exit — active work must never be orphaned
  // ---------------------------------------------------------------------------

  describe('employee exit', () => {
    it('refuses to remove a member who still owns active leads', async () => {
      const org = await freshOrg();
      const rep = await addMember(org.token);
      await seedWork(org.token, rep.userId, { withFollowUp: true });

      const response = await ctx
        .http()
        .delete(`/api/v1/users/${rep.userId}`)
        .set(auth(org.token))
        .expect(409);

      expect(response.body.error.code).toBe(ERROR_CODES.REASSIGNMENT_REQUIRED);
      // The message has to carry the counts, or the admin cannot tell how big
      // a decision they are being asked to make.
      expect(response.body.error.details.activeLeads).toEqual(['1']);
      expect(response.body.error.details.openFollowUps).toEqual(['1']);
    });

    it('refuses to deactivate a member who still owns active leads', async () => {
      const org = await freshOrg();
      const rep = await addMember(org.token);
      await seedWork(org.token, rep.userId, { withFollowUp: true });

      const response = await ctx
        .http()
        .patch(`/api/v1/users/${rep.userId}`)
        .set(auth(org.token))
        .send({ status: 'SUSPENDED' })
        .expect(409);

      expect(response.body.error.code).toBe(ERROR_CODES.REASSIGNMENT_REQUIRED);
    });

    it('refuses to let a member with active leads leave on their own', async () => {
      const org = await freshOrg();
      const rep = await addMember(org.token);
      await seedWork(org.token, rep.userId, { withFollowUp: true });

      const response = await ctx
        .http()
        .post('/api/v1/organizations/leave')
        .set(auth(rep.token))
        .expect(409);

      expect(response.body.error.code).toBe(ERROR_CODES.REASSIGNMENT_REQUIRED);
    });

    it('still removes a member who owns nothing', async () => {
      const org = await freshOrg();
      const rep = await addMember(org.token);

      await ctx
        .http()
        .delete(`/api/v1/users/${rep.userId}`)
        .set(auth(org.token))
        .expect(204);
    });

    it('transfers active work and then removes, in one operation', async () => {
      const org = await freshOrg();
      const leaver = await addMember(org.token);
      const successor = await addMember(org.token);

      const first = await seedWork(org.token, leaver.userId, { withFollowUp: true });
      const second = await seedWork(org.token, leaver.userId, { withFollowUp: true });

      const response = await ctx
        .http()
        .post(`/api/v1/users/${leaver.userId}/offboard`)
        .set(auth(org.token))
        .send({ action: 'REMOVE', reassignToId: successor.userId })
        .expect(200);

      expect(response.body.data.leadsReassigned).toBe(2);
      expect(response.body.data.followUpsReassigned).toBe(2);
      expect(response.body.data.action).toBe('REMOVE');

      // The leads now belong to the successor and are visible to them.
      for (const { leadId } of [first, second]) {
        const lead = await ctx
          .http()
          .get(`/api/v1/leads/${leadId}`)
          .set(auth(successor.token))
          .expect(200);

        expect(lead.body.data.assignedTo.id).toBe(successor.userId);
      }

      // And the leaver is gone.
      const members = await ctx.http().get('/api/v1/users').set(auth(org.token)).expect(200);
      expect((members.body.data as { id: string }[]).some((m) => m.id === leaver.userId)).toBe(
        false,
      );
    });

    it('transfers active work and deactivates, keeping the member listed', async () => {
      const org = await freshOrg();
      const leaver = await addMember(org.token);
      const successor = await addMember(org.token);
      await seedWork(org.token, leaver.userId, { withFollowUp: true });

      await ctx
        .http()
        .post(`/api/v1/users/${leaver.userId}/offboard`)
        .set(auth(org.token))
        .send({ action: 'DEACTIVATE', reassignToId: successor.userId })
        .expect(200);

      const members = await ctx.http().get('/api/v1/users').set(auth(org.token)).expect(200);
      const row = (members.body.data as { id: string; status: string }[]).find(
        (m) => m.id === leaver.userId,
      );

      // Deactivated, not deleted — their name still resolves on old activity.
      expect(row?.status).toBe('SUSPENDED');
    });

    it('revokes the leaver’s access immediately', async () => {
      const org = await freshOrg();
      const leaver = await addMember(org.token);
      const successor = await addMember(org.token);
      await seedWork(org.token, leaver.userId, { withFollowUp: true });

      await ctx
        .http()
        .post(`/api/v1/users/${leaver.userId}/offboard`)
        .set(auth(org.token))
        .send({ action: 'REMOVE', reassignToId: successor.userId })
        .expect(200);

      await ctx.http().get('/api/v1/leads').set(auth(leaver.token)).expect(401);
    });

    it('lets a member with active work hand over and leave voluntarily', async () => {
      const org = await freshOrg();
      const leaver = await addMember(org.token);
      const successor = await addMember(org.token);
      const work = await seedWork(org.token, leaver.userId, { withFollowUp: true });

      await ctx
        .http()
        .post('/api/v1/organizations/leave')
        .set(auth(leaver.token))
        .send({ reassignToId: successor.userId })
        .expect(204);

      const lead = await ctx
        .http()
        .get(`/api/v1/leads/${work.leadId}`)
        .set(auth(successor.token))
        .expect(200);

      expect(lead.body.data.assignedTo.id).toBe(successor.userId);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Reassignment target validation — the cross-tenant boundary
  // ---------------------------------------------------------------------------

  describe('reassignment target', () => {
    it('BLOCKS a target from another organization', async () => {
      const org = await freshOrg();
      const leaver = await addMember(org.token);
      const work = await seedWork(org.token, leaver.userId, { withFollowUp: true });

      const response = await ctx
        .http()
        .post(`/api/v1/users/${leaver.userId}/offboard`)
        .set(auth(org.token))
        .send({ action: 'REMOVE', reassignToId: ctx.orgB.rep.id })
        .expect(400);

      expect(response.body.error.details.reassignToId).toBeDefined();

      // Nothing may have moved. A partially applied reassignment that then
      // failed would be worse than an outright refusal.
      const lead = await ctx
        .http()
        .get(`/api/v1/leads/${work.leadId}`)
        .set(auth(org.token))
        .expect(200);

      expect(lead.body.data.assignedTo.id).toBe(leaver.userId);
    });

    it('BLOCKS a target that is suspended', async () => {
      const org = await freshOrg();
      const leaver = await addMember(org.token);
      const successor = await addMember(org.token);
      await seedWork(org.token, leaver.userId, { withFollowUp: true });

      await ctx
        .http()
        .patch(`/api/v1/users/${successor.userId}`)
        .set(auth(org.token))
        .send({ status: 'SUSPENDED' })
        .expect(200);

      await ctx
        .http()
        .post(`/api/v1/users/${leaver.userId}/offboard`)
        .set(auth(org.token))
        .send({ action: 'REMOVE', reassignToId: successor.userId })
        .expect(400);
    });

    it('BLOCKS handing the work back to the person leaving', async () => {
      const org = await freshOrg();
      const leaver = await addMember(org.token);
      await seedWork(org.token, leaver.userId, { withFollowUp: true });

      await ctx
        .http()
        .post(`/api/v1/users/${leaver.userId}/offboard`)
        .set(auth(org.token))
        .send({ action: 'REMOVE', reassignToId: leaver.userId })
        .expect(400);
    });

    it('BLOCKS an unknown user id', async () => {
      const org = await freshOrg();
      const leaver = await addMember(org.token);
      await seedWork(org.token, leaver.userId, { withFollowUp: true });

      await ctx
        .http()
        .post(`/api/v1/users/${leaver.userId}/offboard`)
        .set(auth(org.token))
        .send({ action: 'REMOVE', reassignToId: '0199a000-0000-7000-8000-000000000000' })
        .expect(400);
    });

    it('refuses to offboard a member of another organization', async () => {
      const org = await freshOrg();

      await ctx
        .http()
        .post(`/api/v1/users/${ctx.orgB.rep.id}/offboard`)
        .set(auth(org.token))
        .send({ action: 'REMOVE' })
        .expect(404);
    });

    it('refuses a sales rep the offboarding endpoint', async () => {
      const org = await freshOrg();
      const rep = await addMember(org.token);
      const other = await addMember(org.token);

      await ctx
        .http()
        .post(`/api/v1/users/${other.userId}/offboard`)
        .set(auth(rep.token))
        .send({ action: 'REMOVE' })
        .expect(403);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. What reassignment must preserve
  // ---------------------------------------------------------------------------

  describe('data integrity through reassignment', () => {
    it('keeps historical activity attributed to the ORIGINAL user', async () => {
      const org = await freshOrg();
      const leaver = await addMember(org.token);
      const successor = await addMember(org.token);
      const work = await seedWork(org.token, leaver.userId, { withFollowUp: true });

      // The leaver logs a call, in their own name.
      await ctx
        .http()
        .post(`/api/v1/leads/${work.leadId}/activities`)
        .set(auth(leaver.token))
        .send({ activityType: 'CALL_COMPLETED', description: 'Spoke to the buyer' })
        .expect(201);

      await ctx
        .http()
        .post(`/api/v1/users/${leaver.userId}/offboard`)
        .set(auth(org.token))
        .send({ action: 'REMOVE', reassignToId: successor.userId })
        .expect(200);

      const activities = await ctx
        .http()
        .get(`/api/v1/leads/${work.leadId}/activities`)
        .set(auth(successor.token))
        .expect(200);

      const call = (
        activities.body.data.items as {
          type: string;
          description: string;
          performedBy: { id: string } | null;
        }[]
      ).find((item) => item.type === 'CALL_COMPLETED');

      // Rewriting history to the successor would be a lie about who did the
      // work, and would destroy the only record of the leaver's contribution.
      expect(call?.performedBy?.id).toBe(leaver.userId);
    });

    it('records the handover on each lead’s own timeline', async () => {
      const org = await freshOrg();
      const leaver = await addMember(org.token);
      const successor = await addMember(org.token);
      const work = await seedWork(org.token, leaver.userId, { withFollowUp: true });

      await ctx
        .http()
        .post(`/api/v1/users/${leaver.userId}/offboard`)
        .set(auth(org.token))
        .send({ action: 'REMOVE', reassignToId: successor.userId })
        .expect(200);

      const activities = await ctx
        .http()
        .get(`/api/v1/leads/${work.leadId}/activities`)
        .set(auth(successor.token))
        .expect(200);

      const items = activities.body.data.items as { type: string }[];
      expect(items.some((item) => item.type === 'LEAD_REASSIGNED')).toBe(true);
    });

    it('does not duplicate leads', async () => {
      const org = await freshOrg();
      const leaver = await addMember(org.token);
      const successor = await addMember(org.token);

      await seedWork(org.token, leaver.userId, { withFollowUp: true });
      await seedWork(org.token, leaver.userId, { withFollowUp: true });

      const before = await ctx
        .http()
        .get('/api/v1/leads?limit=100')
        .set(auth(org.token))
        .expect(200);

      await ctx
        .http()
        .post(`/api/v1/users/${leaver.userId}/offboard`)
        .set(auth(org.token))
        .send({ action: 'REMOVE', reassignToId: successor.userId })
        .expect(200);

      const after = await ctx
        .http()
        .get('/api/v1/leads?limit=100')
        .set(auth(org.token))
        .expect(200);

      expect(after.body.data.total).toBe(before.body.data.total);
    });

    it('does not duplicate contacts', async () => {
      const org = await freshOrg();
      const leaver = await addMember(org.token);
      const successor = await addMember(org.token);

      await seedWork(org.token, leaver.userId, { withFollowUp: true });

      const before = await ctx
        .http()
        .get('/api/v1/contacts?limit=100')
        .set(auth(org.token))
        .expect(200);

      await ctx
        .http()
        .post(`/api/v1/users/${leaver.userId}/offboard`)
        .set(auth(org.token))
        .send({ action: 'REMOVE', reassignToId: successor.userId })
        .expect(200);

      const after = await ctx
        .http()
        .get('/api/v1/contacts?limit=100')
        .set(auth(org.token))
        .expect(200);

      // A contact belongs to the organization, not to a salesperson. Nothing
      // about a handover should touch it.
      expect(after.body.data.total).toBe(before.body.data.total);
    });

    it('does not duplicate follow-up history', async () => {
      const org = await freshOrg();
      const leaver = await addMember(org.token);
      const successor = await addMember(org.token);
      const work = await seedWork(org.token, leaver.userId, { withFollowUp: true });

      const before = await ctx
        .http()
        .get(`/api/v1/leads/${work.leadId}/follow-ups`)
        .set(auth(org.token))
        .expect(200);

      await ctx
        .http()
        .post(`/api/v1/users/${leaver.userId}/offboard`)
        .set(auth(org.token))
        .send({ action: 'REMOVE', reassignToId: successor.userId })
        .expect(200);

      const after = await ctx
        .http()
        .get(`/api/v1/leads/${work.leadId}/follow-ups`)
        .set(auth(org.token))
        .expect(200);

      expect(after.body.data).toHaveLength((before.body.data as unknown[]).length);
    });

    it('leaves WON and LOST leads with their original owner by default', async () => {
      const org = await freshOrg();
      const leaver = await addMember(org.token);
      const successor = await addMember(org.token);

      const won = await seedWork(org.token, leaver.userId, { status: 'WON' });
      const lost = await seedWork(org.token, leaver.userId, { status: 'LOST' });
      await seedWork(org.token, leaver.userId, { withFollowUp: true });

      const response = await ctx
        .http()
        .post(`/api/v1/users/${leaver.userId}/offboard`)
        .set(auth(org.token))
        .send({ action: 'REMOVE', reassignToId: successor.userId })
        .expect(200);

      expect(response.body.data.leadsReassigned).toBe(1);
      expect(response.body.data.historicalLeadsReassigned).toBe(0);

      // Who closed a deal is a fact about the past. Rewriting it would corrupt
      // every commission and performance report already run.
      for (const { leadId } of [won, lost]) {
        const lead = await ctx
          .http()
          .get(`/api/v1/leads/${leadId}`)
          .set(auth(org.token))
          .expect(200);

        expect(lead.body.data.assignedTo.id).toBe(leaver.userId);
      }
    });

    it('can move historical leads too, when explicitly asked', async () => {
      const org = await freshOrg();
      const leaver = await addMember(org.token);
      const successor = await addMember(org.token);

      const won = await seedWork(org.token, leaver.userId, { status: 'WON' });

      const response = await ctx
        .http()
        .post(`/api/v1/users/${leaver.userId}/offboard`)
        .set(auth(org.token))
        .send({
          action: 'REMOVE',
          reassignToId: successor.userId,
          includeHistorical: true,
        })
        .expect(200);

      expect(response.body.data.historicalLeadsReassigned).toBe(1);

      const lead = await ctx
        .http()
        .get(`/api/v1/leads/${won.leadId}`)
        .set(auth(org.token))
        .expect(200);

      expect(lead.body.data.assignedTo.id).toBe(successor.userId);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Follow-up continuity
  // ---------------------------------------------------------------------------

  describe('follow-up continuity', () => {
    it('moves every open follow-up to the successor, whatever its state', async () => {
      const org = await freshOrg();
      const leaver = await addMember(org.token);
      const successor = await addMember(org.token);

      // Upcoming, overdue and rescheduled all count as work still owed.
      const upcoming = await seedWork(org.token, leaver.userId, { withFollowUp: true });
      const overdue = await seedWork(org.token, leaver.userId, { withFollowUp: true });

      await ctx
        .http()
        .post(`/api/v1/follow-ups/${overdue.followUpId as string}/reschedule`)
        .set(auth(org.token))
        .send({ scheduledAt: inDays(5), reason: 'Customer asked' })
        .expect(200);

      const result = await ctx
        .http()
        .post(`/api/v1/users/${leaver.userId}/offboard`)
        .set(auth(org.token))
        .send({ action: 'REMOVE', reassignToId: successor.userId })
        .expect(200);

      // The reschedule created a replacement, so there are still exactly two
      // OPEN follow-ups — the original is CANCELLED and must not be moved.
      expect(result.body.data.followUpsReassigned).toBe(2);

      const successorFollowUps = await ctx
        .http()
        .get('/api/v1/follow-ups?bucket=upcoming')
        .set(auth(successor.token))
        .expect(200);

      const leadIds = (successorFollowUps.body.data as { leadId: string }[]).map((f) => f.leadId);
      expect(leadIds).toContain(upcoming.leadId);
      expect(leadIds).toContain(overdue.leadId);
    });

    it('leaves the successor able to complete an inherited follow-up', async () => {
      const org = await freshOrg();
      const leaver = await addMember(org.token);
      const successor = await addMember(org.token);
      const work = await seedWork(org.token, leaver.userId, { withFollowUp: true });

      await ctx
        .http()
        .post(`/api/v1/users/${leaver.userId}/offboard`)
        .set(auth(org.token))
        .send({ action: 'REMOVE', reassignToId: successor.userId })
        .expect(200);

      // The whole point of the handover: the work is operational, not just
      // visible.
      await ctx
        .http()
        .post(`/api/v1/follow-ups/${work.followUpId as string}/complete`)
        .set(auth(successor.token))
        .send({ outcome: 'Spoke to them', nextFollowUpAt: inDays(4) })
        .expect(200);
    });

    it('does not move follow-ups that were already completed', async () => {
      const org = await freshOrg();
      const leaver = await addMember(org.token);
      const successor = await addMember(org.token);
      const work = await seedWork(org.token, leaver.userId, { withFollowUp: true });

      await ctx
        .http()
        .post(`/api/v1/follow-ups/${work.followUpId as string}/complete`)
        .set(auth(leaver.token))
        .send({ outcome: 'Done', nextFollowUpAt: inDays(4) })
        .expect(200);

      const result = await ctx
        .http()
        .post(`/api/v1/users/${leaver.userId}/offboard`)
        .set(auth(org.token))
        .send({ action: 'REMOVE', reassignToId: successor.userId })
        .expect(200);

      // Completing created a new open follow-up; the finished one stays with
      // the person who actually did it.
      expect(result.body.data.followUpsReassigned).toBe(1);

      const completed = await ctx
        .http()
        .get('/api/v1/follow-ups?bucket=completed')
        .set(auth(org.token))
        .expect(200);

      const done = (completed.body.data as { id: string; assignedTo: { id: string } }[]).find(
        (f) => f.id === work.followUpId,
      );
      expect(done?.assignedTo.id).toBe(leaver.userId);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Permissions survive, and the audit trail records what happened
  // ---------------------------------------------------------------------------

  describe('after reassignment', () => {
    it('leaves the successor’s existing permissions unchanged', async () => {
      const org = await freshOrg();
      const leaver = await addMember(org.token);
      const successor = await addMember(org.token, 'SALES_REP');
      await seedWork(org.token, leaver.userId, { withFollowUp: true });

      await ctx
        .http()
        .post(`/api/v1/users/${leaver.userId}/offboard`)
        .set(auth(org.token))
        .send({ action: 'REMOVE', reassignToId: successor.userId })
        .expect(200);

      const me = await ctx.http().get('/api/v1/auth/me').set(auth(successor.token)).expect(200);
      expect(me.body.data.role).toBe('SALES_REP');

      // Inheriting work must not inherit authority: a rep who takes over a
      // colleague's leads is still a rep.
      await ctx
        .http()
        .post('/api/v1/users/invite')
        .set(auth(successor.token))
        .send({ email: `${unique('x')}@example.test`, fullName: 'Nope', role: 'SALES_REP' })
        .expect(403);
    });

    it('writes an audit entry naming both users and the volume moved', async () => {
      const org = await freshOrg();
      const leaver = await addMember(org.token);
      const successor = await addMember(org.token);
      await seedWork(org.token, leaver.userId, { withFollowUp: true });

      await ctx
        .http()
        .post(`/api/v1/users/${leaver.userId}/offboard`)
        .set(auth(org.token))
        .send({ action: 'REMOVE', reassignToId: successor.userId })
        .expect(200);

      const audit = await ctx
        .http()
        .get('/api/v1/organizations/audit?limit=50')
        .set(auth(org.token))
        .expect(200);

      const entry = (
        audit.body.data.items as {
          action: string;
          entityId: string;
          after: Record<string, unknown> | null;
        }[]
      ).find((row) => row.action === 'user.offboarded');

      expect(entry).toBeDefined();
      expect(entry?.entityId).toBe(leaver.userId);
      expect(entry?.after?.['reassignToId']).toBe(successor.userId);
      expect(entry?.after?.['leadsReassigned']).toBe(1);
      expect(entry?.after?.['followUpsReassigned']).toBe(1);
    });

    it('records an admin transfer', async () => {
      const org = await freshOrg();
      const successor = await addMember(org.token, 'MANAGER');

      await ctx
        .http()
        .post('/api/v1/users/transfer-admin')
        .set(auth(org.token))
        .send({ toUserId: successor.userId, stepDown: true })
        .expect(200);

      const audit = await ctx
        .http()
        .get('/api/v1/organizations/audit?limit=50')
        .set(auth(successor.token))
        .expect(200);

      expect(
        (audit.body.data.items as { action: string }[]).some(
          (row) => row.action === 'user.admin_transferred',
        ),
      ).toBe(true);
    });

    it('never shows another organization’s audit entries', async () => {
      const org = await freshOrg();
      const leaver = await addMember(org.token);
      const successor = await addMember(org.token);
      await seedWork(org.token, leaver.userId, { withFollowUp: true });

      await ctx
        .http()
        .post(`/api/v1/users/${leaver.userId}/offboard`)
        .set(auth(org.token))
        .send({ action: 'REMOVE', reassignToId: successor.userId })
        .expect(200);

      const foreign = await ctx
        .http()
        .get('/api/v1/organizations/audit?limit=100')
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(200);

      const ids = (foreign.body.data.items as { entityId: string | null }[]).map(
        (row) => row.entityId,
      );
      expect(ids).not.toContain(leaver.userId);
    });

    it('refuses a sales rep the audit trail', async () => {
      const org = await freshOrg();
      const rep = await addMember(org.token);

      await ctx
        .http()
        .get('/api/v1/organizations/audit')
        .set(auth(rep.token))
        .expect(403);
    });
  });
});
