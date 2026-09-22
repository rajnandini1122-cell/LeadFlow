import { createTestContext, PASSWORD, type TestContext } from './helpers/test-app';
import { fixtureMobile } from './helpers/phone-fixtures';

/**
 * Sales teams and agents.
 *
 * The structure future assignment rules will read, and nothing that routes
 * work. Three things have to hold, and every case here is one of them:
 *
 *   a team belongs to exactly one organization, and the database says so;
 *   one person is in a team once, however many requests arrive at once;
 *   organization membership is authoritative — a team never overrides it.
 *
 * Plus the promise this phase makes by NOT acting: no lead is reassigned, no
 * follow-up is touched, and no website intake becomes a lead.
 */
describe('Sales teams', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const unique = (prefix: string): string =>
    `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`;
  const tomorrow = (): string => new Date(Date.now() + 86_400_000).toISOString();

  /** Creates a team as the owner and returns it. */
  const createTeam = async (body: Record<string, unknown> = {}) => {
    const response = await ctx
      .http()
      .post('/api/v1/teams')
      .set(auth(ctx.orgA.owner.accessToken))
      .send({ name: unique('Team'), ...body });

    return response;
  };

  /** Invites and accepts a colleague, returning their user id and token. */
  const addColleague = async (role: 'SALES_REP' | 'MANAGER' = 'SALES_REP') => {
    const email = `${unique('member')}@example.test`;

    const invite = await ctx
      .http()
      .post('/api/v1/users/invite')
      .set(auth(ctx.orgA.owner.accessToken))
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

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ---------------------------------------------------------------------------
  // Teams
  // ---------------------------------------------------------------------------

  describe('creating a team', () => {
    it('creates an active team', async () => {
      const response = await createTeam({ name: 'Pune Sales', description: 'Western region' });

      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({
        name: 'Pune Sales',
        description: 'Western region',
        status: 'ACTIVE',
        manager: null,
        activeMemberCount: 0,
      });
    });

    it('stores the name as typed, trimmed', async () => {
      const response = await createTeam({ name: '  Nagpur Sales  ' });

      expect(response.status).toBe(201);
      expect(response.body.data.name).toBe('Nagpur Sales');
    });

    it('refuses a second ACTIVE team with the same name, whatever the casing', async () => {
      const name = unique('Duplicate');
      await createTeam({ name }).then((r) => expect(r.status).toBe(201));

      // "Pune Sales" and "pune  sales" are one team to an administrator.
      const second = await createTeam({ name: `  ${name.toUpperCase()} ` });

      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('CONFLICT');
    });

    it('lets an archived name be used again', async () => {
      const name = unique('Reusable');
      const first = await createTeam({ name });

      await ctx
        .http()
        .patch(`/api/v1/teams/${first.body.data.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ status: 'ARCHIVED' })
        .expect(200);

      // The unique index is partial for exactly this reason: a retired team
      // must not reserve its name forever.
      const second = await createTeam({ name });
      expect(second.status).toBe(201);
    });

    it('refuses a name that says nothing', async () => {
      expect((await createTeam({ name: ' ' })).status).toBe(400);
      expect((await createTeam({ name: 'x'.repeat(81) })).status).toBe(400);
    });
  });

  describe('updating a team', () => {
    it('renames and re-describes', async () => {
      const team = await createTeam();

      const response = await ctx
        .http()
        .patch(`/api/v1/teams/${team.body.data.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ name: 'Renamed Team', description: 'Now with a description' })
        .expect(200);

      expect(response.body.data).toMatchObject({
        name: 'Renamed Team',
        description: 'Now with a description',
      });
    });

    it('archives, and archiving is how a team is retired', async () => {
      const team = await createTeam();

      const archived = await ctx
        .http()
        .patch(`/api/v1/teams/${team.body.data.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ status: 'ARCHIVED' })
        .expect(200);

      expect(archived.body.data.status).toBe('ARCHIVED');

      // Out of the default list, still readable by id, and still in the
      // history when it is asked for.
      const active = await ctx
        .http()
        .get('/api/v1/teams')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);
      expect(active.body.data.map((t: { id: string }) => t.id)).not.toContain(team.body.data.id);

      const all = await ctx
        .http()
        .get('/api/v1/teams?includeArchived=true')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);
      expect(all.body.data.map((t: { id: string }) => t.id)).toContain(team.body.data.id);
    });

    it('refuses new members on an archived team', async () => {
      const team = await createTeam();
      const colleague = await addColleague();

      await ctx
        .http()
        .patch(`/api/v1/teams/${team.body.data.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ status: 'ARCHIVED' })
        .expect(200);

      // An archived team is history. A membership added to it could never be
      // used and nobody would be watching it.
      const response = await ctx
        .http()
        .post(`/api/v1/teams/${team.body.data.id}/members`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ userId: colleague.userId });

      expect(response.status).toBe(400);
    });
  });

  describe('the manager', () => {
    it('is recorded, and joins the team they manage', async () => {
      const manager = await addColleague('MANAGER');
      const team = await createTeam({ managerUserId: manager.userId });

      expect(team.status).toBe(201);
      expect(team.body.data.manager).toMatchObject({ userId: manager.userId, role: 'MANAGER' });
      // Otherwise the team names somebody who is not in it, and "who is in
      // this team" has two answers depending on which column you read.
      expect(team.body.data.members.map((m: { userId: string }) => m.userId)).toContain(
        manager.userId,
      );
    });

    it('refuses a suspended member as manager', async () => {
      const colleague = await addColleague();

      await ctx
        .http()
        .patch(`/api/v1/users/${colleague.userId}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ status: 'SUSPENDED' })
        .expect(200);

      const response = await createTeam({ managerUserId: colleague.userId });

      // A team whose manager cannot sign in is a team nobody is responsible for.
      expect(response.status).toBe(400);
    });

    it('is cleared atomically when the manager is removed from the team', async () => {
      const manager = await addColleague('MANAGER');
      const team = await createTeam({ managerUserId: manager.userId });

      const memberRow = team.body.data.members.find(
        (m: { userId: string }) => m.userId === manager.userId,
      );

      const after = await ctx
        .http()
        .post(`/api/v1/teams/${team.body.data.id}/members/${memberRow.id}/remove`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      /*
       * The contradiction this prevents: managerMembershipId pointing at
       * somebody explicitly removed from the team. One transaction, so a
       * failure cannot leave it behind permanently.
       */
      expect(after.body.data.manager).toBeNull();
      expect(after.body.data.members).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Members
  // ---------------------------------------------------------------------------

  describe('team members', () => {
    it('adds an existing organization member', async () => {
      const team = await createTeam();
      const colleague = await addColleague();

      const response = await ctx
        .http()
        .post(`/api/v1/teams/${team.body.data.id}/members`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ userId: colleague.userId })
        .expect(201);

      expect(response.body.data.members).toHaveLength(1);
      expect(response.body.data.members[0]).toMatchObject({
        userId: colleague.userId,
        role: 'SALES_REP',
        status: 'ACTIVE',
        // The default: somebody added to a team is available for the work it
        // will later be given.
        assignmentEnabled: true,
        eligibleForAssignment: true,
      });
    });

    it('adding twice leaves one membership', async () => {
      const team = await createTeam();
      const colleague = await addColleague();

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await ctx
          .http()
          .post(`/api/v1/teams/${team.body.data.id}/members`)
          .set(auth(ctx.orgA.owner.accessToken))
          .send({ userId: colleague.userId })
          .expect(201);
      }

      const detail = await ctx
        .http()
        .get(`/api/v1/teams/${team.body.data.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect(detail.body.data.members).toHaveLength(1);
    });

    it('survives two concurrent adds of the same person', async () => {
      const team = await createTeam();
      const colleague = await addColleague();

      /*
       * The case a prior read cannot handle: both requests look for an
       * existing membership, both find none, and both insert. Only the partial
       * unique index decides — and it is a real race against real PostgreSQL
       * in CI, where a second row would mean one person counted twice in every
       * future assignment calculation.
       */
      const [first, second] = await Promise.all([
        ctx
          .http()
          .post(`/api/v1/teams/${team.body.data.id}/members`)
          .set(auth(ctx.orgA.owner.accessToken))
          .send({ userId: colleague.userId }),
        ctx
          .http()
          .post(`/api/v1/teams/${team.body.data.id}/members`)
          .set(auth(ctx.orgA.owner.accessToken))
          .send({ userId: colleague.userId }),
      ]);

      expect([first.status, second.status]).toEqual([201, 201]);

      const detail = await ctx
        .http()
        .get(`/api/v1/teams/${team.body.data.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect(detail.body.data.members).toHaveLength(1);
    });

    it('removal keeps the history and re-adding works', async () => {
      const team = await createTeam();
      const colleague = await addColleague();

      const added = await ctx
        .http()
        .post(`/api/v1/teams/${team.body.data.id}/members`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ userId: colleague.userId })
        .expect(201);

      const memberId = added.body.data.members[0].id;

      const removed = await ctx
        .http()
        .post(`/api/v1/teams/${team.body.data.id}/members/${memberId}/remove`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);
      expect(removed.body.data.members).toHaveLength(0);

      // A second spell in the team is a NEW row, so "who was in this team when
      // that deal closed" stays answerable for both.
      const readded = await ctx
        .http()
        .post(`/api/v1/teams/${team.body.data.id}/members`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ userId: colleague.userId })
        .expect(201);

      expect(readded.body.data.members).toHaveLength(1);
      expect(readded.body.data.members[0].id).not.toBe(memberId);
    });

    it('pauses and resumes assignment without touching anything else', async () => {
      const team = await createTeam();
      const colleague = await addColleague();

      const added = await ctx
        .http()
        .post(`/api/v1/teams/${team.body.data.id}/members`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ userId: colleague.userId })
        .expect(201);
      const memberId = added.body.data.members[0].id;

      const paused = await ctx
        .http()
        .patch(`/api/v1/teams/${team.body.data.id}/members/${memberId}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ assignmentEnabled: false })
        .expect(200);

      expect(paused.body.data.members[0]).toMatchObject({
        assignmentEnabled: false,
        eligibleForAssignment: false,
        // Still in the team, still an active member of the organization.
        status: 'ACTIVE',
      });

      /*
       * The promise this toggle makes: a pause is operational, not
       * disciplinary. Leave and training must not cost somebody their login.
       */
      const stillWorking = await ctx
        .http()
        .get('/api/v1/leads')
        .set(auth(colleague.token));
      expect(stillWorking.status).toBe(200);

      const resumed = await ctx
        .http()
        .patch(`/api/v1/teams/${team.body.data.id}/members/${memberId}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ assignmentEnabled: true })
        .expect(200);
      expect(resumed.body.data.members[0].eligibleForAssignment).toBe(true);
    });

    it('stops treating a suspended colleague as a candidate, without rewriting history', async () => {
      const team = await createTeam();
      const colleague = await addColleague();

      await ctx
        .http()
        .post(`/api/v1/teams/${team.body.data.id}/members`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ userId: colleague.userId })
        .expect(201);

      await ctx
        .http()
        .patch(`/api/v1/users/${colleague.userId}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ status: 'SUSPENDED' })
        .expect(200);

      const detail = await ctx
        .http()
        .get(`/api/v1/teams/${team.body.data.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      /*
       * Organization membership is authoritative and evaluated live. Their
       * team row is untouched — the record of who was in the team does not get
       * edited because somebody was suspended on a Friday — but they are not
       * a candidate while it stands, and the active count says so.
       */
      expect(detail.body.data.members).toHaveLength(1);
      expect(detail.body.data.members[0]).toMatchObject({
        status: 'SUSPENDED',
        assignmentEnabled: true,
        eligibleForAssignment: false,
      });
      expect(detail.body.data.activeMemberCount).toBe(0);
    });

    it('does not treat a MANAGER as an automatic-assignment candidate', async () => {
      const team = await createTeam();
      const manager = await addColleague('MANAGER');

      const added = await ctx
        .http()
        .post(`/api/v1/teams/${team.body.data.id}/members`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ userId: manager.userId })
        .expect(201);

      // They are in the team, which is a real thing to be. Automatic routing
      // to them is a policy the assignment phase will decide, not a side
      // effect of holding a role.
      expect(added.body.data.members[0]).toMatchObject({
        role: 'MANAGER',
        eligibleForAssignment: false,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // The agent directory
  // ---------------------------------------------------------------------------

  describe('the agent directory', () => {
    it('lists members with their teams and nothing private', async () => {
      const team = await createTeam();
      const colleague = await addColleague();

      await ctx
        .http()
        .post(`/api/v1/teams/${team.body.data.id}/members`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ userId: colleague.userId })
        .expect(201);

      const response = await ctx
        .http()
        .get('/api/v1/teams/agents')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      const entry = response.body.data.find(
        (agent: { userId: string }) => agent.userId === colleague.userId,
      );

      expect(entry).toMatchObject({ role: 'SALES_REP', status: 'ACTIVE', assignableRole: true });
      expect(entry.teams).toEqual([
        { teamId: team.body.data.id, teamName: team.body.data.name, assignmentEnabled: true },
      ]);

      const serialised = JSON.stringify(response.body);
      for (const secret of ['passwordHash', 'password_hash', 'refreshToken', 'inviteTokenHash']) {
        expect(serialised).not.toContain(secret);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant isolation
  // ---------------------------------------------------------------------------

  describe('tenant isolation', () => {
    let foreignTeamId: string;
    let foreignMemberUserId: string;

    beforeAll(async () => {
      const team = await ctx
        .http()
        .post('/api/v1/teams')
        .set(auth(ctx.orgB.owner.accessToken))
        .send({ name: 'Org B Team' })
        .expect(201);

      foreignTeamId = team.body.data.id;
      foreignMemberUserId = ctx.orgB.rep.id;
    });

    it('never lists another organization’s teams', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/teams?includeArchived=true')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect(response.body.data.map((t: { id: string }) => t.id)).not.toContain(foreignTeamId);
    });

    it('answers 404 for another organization’s team, by id', async () => {
      // 404 rather than 403: confirming that an id exists elsewhere is an
      // enumeration oracle, and "not found" leaks nothing.
      const response = await ctx
        .http()
        .get(`/api/v1/teams/${foreignTeamId}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(404);
    });

    it('refuses to update another organization’s team', async () => {
      const response = await ctx
        .http()
        .patch(`/api/v1/teams/${foreignTeamId}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ name: 'Taken over' });

      expect(response.status).toBe(404);
    });

    it('refuses to add another organization’s member to a local team', async () => {
      const team = await createTeam();

      const response = await ctx
        .http()
        .post(`/api/v1/teams/${team.body.data.id}/members`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ userId: foreignMemberUserId });

      // 400 and a message about membership: it says the id is not usable
      // here, never that it belongs to somebody else.
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).not.toContain(foreignTeamId);
    });

    it('refuses another organization’s member as manager', async () => {
      const response = await createTeam({ managerUserId: foreignMemberUserId });

      expect(response.status).toBe(400);
    });

    it('refuses to remove a member of another organization’s team', async () => {
      const detail = await ctx
        .http()
        .get(`/api/v1/teams/${foreignTeamId}`)
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(200);

      const response = await ctx
        .http()
        .post(`/api/v1/teams/${foreignTeamId}/members/${detail.body.data.id}/remove`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(response.status).toBe(404);
    });

    it('keeps the other organization’s team intact', async () => {
      const response = await ctx
        .http()
        .get(`/api/v1/teams/${foreignTeamId}`)
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(200);

      expect(response.body.data.name).toBe('Org B Team');
    });
  });

  // ---------------------------------------------------------------------------
  // Authorization
  // ---------------------------------------------------------------------------

  describe('authorization', () => {
    it('lets an administrator manage teams', async () => {
      expect((await createTeam()).status).toBe(201);
    });

    it('lets a MANAGER read teams but not restructure them', async () => {
      const manager = await addColleague('MANAGER');
      const team = await createTeam();

      await ctx.http().get('/api/v1/teams').set(auth(manager.token)).expect(200);

      // Being responsible for a team is a business role. Restructuring the
      // organization is administration, and the two are separate on purpose.
      const attempt = await ctx
        .http()
        .patch(`/api/v1/teams/${team.body.data.id}`)
        .set(auth(manager.token))
        .send({ name: 'Manager rename' });

      expect(attempt.status).toBe(403);
    });

    it('refuses a SALES_REP everything, on the server', async () => {
      const team = await createTeam();
      const rep = ctx.orgA.rep;

      /*
       * The point of asserting all four: hiding a button is a convenience for
       * the person looking at the screen. The guard is what actually decides,
       * and a rep with a copy of the URL gets the same answer.
       */
      expect((await ctx.http().get('/api/v1/teams').set(auth(rep.accessToken))).status).toBe(403);
      expect(
        (await ctx.http().get('/api/v1/teams/agents').set(auth(rep.accessToken))).status,
      ).toBe(403);
      expect(
        (
          await ctx
            .http()
            .post('/api/v1/teams')
            .set(auth(rep.accessToken))
            .send({ name: 'Rep team' })
        ).status,
      ).toBe(403);
      expect(
        (
          await ctx
            .http()
            .post(`/api/v1/teams/${team.body.data.id}/members`)
            .set(auth(rep.accessToken))
            .send({ userId: rep.id })
        ).status,
      ).toBe(403);
    });

    it('refuses an unauthenticated caller', async () => {
      expect((await ctx.http().get('/api/v1/teams')).status).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // What teams deliberately do NOT touch
  // ---------------------------------------------------------------------------

  describe('the rest of the CRM', () => {
    it('never reassigns a lead', async () => {
      const colleague = await addColleague();

      const lead = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          firstName: 'Existing',
          lastName: 'Work',
          mobile: fixtureMobile(),
          nextFollowUpAt: tomorrow(),
          assignedToId: ctx.orgA.rep.id,
        })
        .expect(201);

      // A whole team lifecycle around them.
      const team = await createTeam();
      await ctx
        .http()
        .post(`/api/v1/teams/${team.body.data.id}/members`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ userId: colleague.userId })
        .expect(201);
      await ctx
        .http()
        .patch(`/api/v1/teams/${team.body.data.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ status: 'ARCHIVED' })
        .expect(200);

      const after = await ctx
        .http()
        .get(`/api/v1/leads/${lead.body.data.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      /*
       * J3 builds structure and routes nothing. Creating, staffing or
       * archiving a team must not move a customer from the person handling
       * them — that is the assignment phase's decision to make, deliberately.
       */
      expect(after.body.data.assignedTo?.id ?? after.body.data.assignedToId).toBe(ctx.orgA.rep.id);
      expect(after.body.data.nextFollowUpAt).toBe(lead.body.data.nextFollowUpAt);
      expect(after.body.data.status).toBe(lead.body.data.status);
    });

    it('leaves the invitation flow exactly as it was', async () => {
      // Teams add existing members. Bringing somebody new into the
      // organization is still the invitation flow, unchanged.
      const colleague = await addColleague();

      const members = await ctx
        .http()
        .get('/api/v1/users')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect(members.body.data.map((m: { id: string }) => m.id)).toContain(colleague.userId);
    });
  });
});
