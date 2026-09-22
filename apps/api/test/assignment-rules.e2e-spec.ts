import { createTestContext, PASSWORD, type TestContext } from './helpers/test-app';
import { fixtureMobile } from './helpers/phone-fixtures';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';

/**
 * The routing table: which team handles which work.
 *
 * Three properties carry the phase, and every case here is one of them:
 *
 *   the answer is deterministic — precedence decides, never row order;
 *   an ambiguous table is refused by the database, not by a prior read;
 *   asking the question changes nothing.
 *
 * And the promise made by NOT acting: no lead is assigned, no intake is
 * converted, no follow-up moves, and no person is chosen.
 */
describe('Assignment rules', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const unique = (prefix: string): string =>
    `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`;
  const tomorrow = (): string => new Date(Date.now() + 86_400_000).toISOString();

  const asSystem = async <T>(reason: string, run: () => Promise<T>): Promise<T> =>
    ctx.app.get(TenantContextService).runAsSystem(reason, run);
  const prisma = () => ctx.app.get(PrismaService).client;

  const owner = () => auth(ctx.orgA.owner.accessToken);

  /** A team with one eligible SALES_REP in it, ready to receive routed work. */
  const teamWithAgent = async (name = unique('Team')) => {
    const team = await ctx.http().post('/api/v1/teams').set(owner()).send({ name }).expect(201);

    const email = `${unique('agent')}@example.test`;
    const invite = await ctx
      .http()
      .post('/api/v1/users/invite')
      .set(owner())
      .send({ email, fullName: 'Routed Agent', role: 'SALES_REP' })
      .expect(201);

    await ctx
      .http()
      .post(`/api/v1/invitations/${invite.body.data.inviteToken}/accept`)
      .send({ firstName: 'Routed', lastName: 'Agent', password: PASSWORD })
      .expect(200);

    const detail = await ctx
      .http()
      .post(`/api/v1/teams/${team.body.data.id}/members`)
      .set(owner())
      .send({ userId: invite.body.data.userId })
      .expect(201);

    return {
      id: team.body.data.id as string,
      name: team.body.data.name as string,
      userId: invite.body.data.userId as string,
      memberId: detail.body.data.members[0].id as string,
    };
  };

  /** An empty team: a valid target with nobody able to take the work. */
  const emptyTeam = async () => {
    const team = await ctx
      .http()
      .post('/api/v1/teams')
      .set(owner())
      .send({ name: unique('Empty') })
      .expect(201);

    return team.body.data.id as string;
  };

  const createRule = async (body: Record<string, unknown>) =>
    ctx.http().post('/api/v1/assignment-rules').set(owner()).send(body);

  const preview = async (body: Record<string, unknown>, token = ctx.orgA.owner.accessToken) =>
    ctx.http().post('/api/v1/assignment-rules/preview').set(auth(token)).send(body);

  /** Archives every active rule, so each case starts from a known table. */
  const clearRules = async (): Promise<void> => {
    const rules = await ctx.http().get('/api/v1/assignment-rules').set(owner()).expect(200);

    for (const rule of rules.body.data as { id: string; status: string }[]) {
      if (rule.status === 'ACTIVE') {
        await ctx
          .http()
          .patch(`/api/v1/assignment-rules/${rule.id}`)
          .set(owner())
          .send({ status: 'ARCHIVED' })
          .expect(200);
      }
    }
  };

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await clearRules();
  });

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  describe('writing rules', () => {
    it('creates an active rule', async () => {
      const team = await teamWithAgent();

      const response = await createRule({
        name: '  Website enquiries  ',
        description: 'Everything from the site',
        source: 'Website',
        targetTeamId: team.id,
      });

      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({
        // Trimmed, like every other name in this product.
        name: 'Website enquiries',
        status: 'ACTIVE',
        source: 'Website',
        isFallback: false,
        targetTeam: { id: team.id },
      });
      // Placed after the existing rules rather than making the administrator
      // invent a number.
      expect(response.body.data.priority).toBeGreaterThan(0);
    });

    it('refuses a rule with no criteria that is not the fallback', async () => {
      const team = await teamWithAgent();

      // It would silently become a second catch-all outranking the real one.
      const response = await createRule({ name: unique('Empty rule'), targetTeamId: team.id });

      expect(response.status).toBe(400);
    });

    it('refuses a fallback that carries criteria', async () => {
      const team = await teamWithAgent();

      const response = await createRule({
        name: unique('Odd fallback'),
        source: 'Website',
        isFallback: true,
        targetTeamId: team.id,
      });

      expect(response.status).toBe(400);
    });

    it('refuses a second active rule matching exactly the same input', async () => {
      const first = await teamWithAgent();
      const second = await teamWithAgent();

      await createRule({ name: unique('A'), source: 'Website', targetTeamId: first.id }).then((r) =>
        expect(r.status).toBe(201),
      );

      /*
       * Two active rules with identical criteria and different teams would
       * route identical enquiries differently depending on precedence nobody
       * set deliberately. Refused by a partial unique index on the normalised
       * criteria — note the different spelling still collides.
       */
      const duplicate = await createRule({
        name: unique('B'),
        source: '  website ',
        targetTeamId: second.id,
      });

      expect(duplicate.status).toBe(409);
    });

    it('refuses a second active rule at the same precedence', async () => {
      const team = await teamWithAgent();

      await createRule({
        name: unique('First'),
        source: 'Referral',
        priority: 50,
        targetTeamId: team.id,
      }).then((r) => expect(r.status).toBe(201));

      const clash = await createRule({
        name: unique('Second'),
        source: 'Trade show',
        priority: 50,
        targetTeamId: team.id,
      });

      // Which of two rules at the same precedence wins would otherwise depend
      // on row order — a silent misroute rather than a visible refusal.
      expect(clash.status).toBe(409);
    });

    it('allows only one active fallback', async () => {
      const team = await teamWithAgent();

      await createRule({ name: unique('Fallback'), isFallback: true, targetTeamId: team.id }).then(
        (r) => expect(r.status).toBe(201),
      );

      const second = await createRule({
        name: unique('Second fallback'),
        isFallback: true,
        targetTeamId: team.id,
      });

      expect(second.status).toBe(409);
    });

    it('frees the criteria and the fallback slot once a rule is archived', async () => {
      const team = await teamWithAgent();

      const first = await createRule({
        name: unique('Original'),
        source: 'Website',
        targetTeamId: team.id,
      });

      await ctx
        .http()
        .patch(`/api/v1/assignment-rules/${first.body.data.id}`)
        .set(owner())
        .send({ status: 'ARCHIVED' })
        .expect(200);

      // History must not reserve a configuration forever.
      const replacement = await createRule({
        name: unique('Replacement'),
        source: 'Website',
        targetTeamId: team.id,
      });

      expect(replacement.status).toBe(201);
    });

    it('refuses an edit that would take another active rule’s precedence', async () => {
      const team = await teamWithAgent();

      await createRule({
        name: unique('Holder'),
        source: 'Referral',
        priority: 70,
        targetTeamId: team.id,
      }).then((r) => expect(r.status).toBe(201));

      const other = await createRule({
        name: unique('Mover'),
        source: 'Trade show',
        priority: 80,
        targetTeamId: team.id,
      });

      // Reordering means choosing a free number, not swapping two — and the
      // refusal says which, rather than failing somewhere in the database.
      const clash = await ctx
        .http()
        .patch(`/api/v1/assignment-rules/${other.body.data.id}`)
        .set(owner())
        .send({ priority: 70 });

      expect(clash.status).toBe(409);
    });

    it('lets a PAUSED rule keep a precedence an active rule uses', async () => {
      const team = await teamWithAgent();

      const paused = await createRule({
        name: unique('Parked'),
        source: 'Email',
        priority: 90,
        targetTeamId: team.id,
      });
      await ctx
        .http()
        .patch(`/api/v1/assignment-rules/${paused.body.data.id}`)
        .set(owner())
        .send({ status: 'PAUSED' })
        .expect(200);

      // The invariants are about ACTIVE rules: parked configuration must not
      // reserve numbers nobody is using.
      const active = await createRule({
        name: unique('Running'),
        source: 'Partner',
        priority: 90,
        targetTeamId: team.id,
      });
      expect(active.status).toBe(201);

      // And bringing the parked one back is refused while that holds.
      const revive = await ctx
        .http()
        .patch(`/api/v1/assignment-rules/${paused.body.data.id}`)
        .set(owner())
        .send({ status: 'ACTIVE' });
      expect(revive.status).toBe(409);
    });

    it('edits description and precedence', async () => {
      const team = await teamWithAgent();
      const rule = await createRule({
        name: unique('Editable'),
        source: 'Referral',
        targetTeamId: team.id,
      });

      const updated = await ctx
        .http()
        .patch(`/api/v1/assignment-rules/${rule.body.data.id}`)
        .set(owner())
        .send({ description: 'Now explained', priority: 999 })
        .expect(200);

      expect(updated.body.data).toMatchObject({ description: 'Now explained', priority: 999 });
    });

    it('pauses and reactivates', async () => {
      const team = await teamWithAgent();
      const rule = await createRule({
        name: unique('Pausable'),
        source: 'Referral',
        targetTeamId: team.id,
      });

      const paused = await ctx
        .http()
        .patch(`/api/v1/assignment-rules/${rule.body.data.id}`)
        .set(owner())
        .send({ status: 'PAUSED' })
        .expect(200);
      expect(paused.body.data.status).toBe('PAUSED');

      // Paused is off, not gone: it keeps its configuration and comes back.
      expect((await preview({ source: 'Referral' })).body.data.decision).toBe('NO_MATCH');

      const resumed = await ctx
        .http()
        .patch(`/api/v1/assignment-rules/${rule.body.data.id}`)
        .set(owner())
        .send({ status: 'ACTIVE' })
        .expect(200);
      expect(resumed.body.data.status).toBe('ACTIVE');
    });

    it('never reactivates an archived rule', async () => {
      const team = await teamWithAgent();
      const rule = await createRule({
        name: unique('Retired'),
        source: 'Referral',
        targetTeamId: team.id,
      });

      await ctx
        .http()
        .patch(`/api/v1/assignment-rules/${rule.body.data.id}`)
        .set(owner())
        .send({ status: 'ARCHIVED' })
        .expect(200);

      /*
       * Archive is terminal for a rule, unlike a team. A team is people who
       * may come back; a rule is a decision about where work went, and
       * reviving one silently changes the table to something somebody
       * deliberately retired.
       */
      const revived = await ctx
        .http()
        .patch(`/api/v1/assignment-rules/${rule.body.data.id}`)
        .set(owner())
        .send({ status: 'ACTIVE' });

      expect(revived.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // The target team
  // ---------------------------------------------------------------------------

  describe('the target team', () => {
    it('refuses an archived team', async () => {
      const team = await ctx
        .http()
        .post('/api/v1/teams')
        .set(owner())
        .send({ name: unique('Archived target') })
        .expect(201);

      await ctx
        .http()
        .patch(`/api/v1/teams/${team.body.data.id}`)
        .set(owner())
        .send({ status: 'ARCHIVED' })
        .expect(200);

      const response = await createRule({
        name: unique('Points nowhere'),
        source: 'Referral',
        targetTeamId: team.body.data.id,
      });

      expect(response.status).toBe(400);
    });

    it('REFUSES to archive a team that live routing points at', async () => {
      const team = await teamWithAgent();
      await createRule({ name: 'Live routing', source: 'Website', targetTeamId: team.id }).then(
        (r) => expect(r.status).toBe(201),
      );

      const archive = await ctx
        .http()
        .patch(`/api/v1/teams/${team.id}`)
        .set(owner())
        .send({ status: 'ARCHIVED' });

      /*
       * The silent failure this prevents: production keeps sending enquiries
       * to a team nobody is watching, and it is discovered by a customer who
       * was never called. Deleting or retargeting the rules automatically
       * would make a routing decision on the administrator's behalf, so the
       * refusal names what to fix instead.
       */
      expect(archive.status).toBe(400);
      expect(JSON.stringify(archive.body)).toContain('Live routing');

      // Still live, and still routing.
      expect((await preview({ source: 'Website' })).body.data.decision).toBe('MATCHED');
    });

    it('allows the archive once the rule is paused', async () => {
      const team = await teamWithAgent();
      const rule = await createRule({
        name: unique('Pausable routing'),
        source: 'Website',
        targetTeamId: team.id,
      });

      await ctx
        .http()
        .patch(`/api/v1/assignment-rules/${rule.body.data.id}`)
        .set(owner())
        .send({ status: 'PAUSED' })
        .expect(200);

      await ctx
        .http()
        .patch(`/api/v1/teams/${team.id}`)
        .set(owner())
        .send({ status: 'ARCHIVED' })
        .expect(200);

      // The paused rule keeps its historical target rather than being edited.
      const after = await ctx
        .http()
        .get(`/api/v1/assignment-rules/${rule.body.data.id}`)
        .set(owner())
        .expect(200);
      expect(after.body.data.targetTeam.id).toBe(team.id);
    });
  });

  // ---------------------------------------------------------------------------
  // Evaluation
  // ---------------------------------------------------------------------------

  describe('evaluation', () => {
    it('matches on source', async () => {
      const team = await teamWithAgent();
      await createRule({ name: unique('Web'), source: 'Website', targetTeamId: team.id });

      const response = await preview({ source: 'Website' });

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        decision: 'MATCHED',
        team: { id: team.id },
        eligibleAgentCount: 1,
      });
      expect(response.body.data.eligibleAgents[0].userId).toBe(team.userId);
    });

    it('is not fooled by spelling', async () => {
      const team = await teamWithAgent();
      await createRule({ name: unique('Web'), source: 'Website', targetTeamId: team.id });

      // A tenant types "website", an integration records "WEBSITE".
      for (const source of ['website', 'WEBSITE', '  Website ']) {
        expect((await preview({ source })).body.data.decision).toBe('MATCHED');
      }
    });

    it('answers NO_MATCH rather than choosing a team', async () => {
      const team = await teamWithAgent();
      await createRule({ name: unique('Web'), source: 'Website', targetTeamId: team.id });

      const response = await preview({ source: 'Trade show' });

      // A table with no answer is a configuration an administrator should
      // see, not one the software papers over.
      expect(response.body.data).toMatchObject({ decision: 'NO_MATCH', team: null, rule: null });
    });

    it('runs rules in precedence order, lowest first', async () => {
      const general = await teamWithAgent();
      const specific = await teamWithAgent();

      await createRule({
        name: unique('Broad'),
        source: 'Website',
        priority: 500,
        targetTeamId: general.id,
      }).then((r) => expect(r.status).toBe(201));
      await createRule({
        name: unique('Narrow'),
        source: 'Referral',
        priority: 10,
        targetTeamId: specific.id,
      }).then((r) => expect(r.status).toBe(201));

      expect((await preview({ source: 'Website' })).body.data.team.id).toBe(general.id);
      expect((await preview({ source: 'Referral' })).body.data.team.id).toBe(specific.id);
    });

    it('prefers a lower-priority rule when both match', async () => {
      const winner = await teamWithAgent();
      const loser = await teamWithAgent();
      const product = await createProduct();

      // Both match a website enquiry about this product; precedence decides,
      // and it is the number rather than the order they were written in.
      await createRule({
        name: unique('Specific'),
        source: 'Website',
        productId: product.id,
        priority: 10,
        targetTeamId: winner.id,
      }).then((r) => expect(r.status).toBe(201));
      await createRule({
        name: unique('General'),
        source: 'Website',
        priority: 20,
        targetTeamId: loser.id,
      }).then((r) => expect(r.status).toBe(201));

      const response = await preview({ source: 'Website', productId: product.id });
      expect(response.body.data.team.id).toBe(winner.id);
    });

    it('matches a canonical product, and only that product', async () => {
      const team = await teamWithAgent();
      const product = await createProduct();
      const other = await createProduct();

      await createRule({
        name: unique('By product'),
        productId: product.id,
        targetTeamId: team.id,
      }).then((r) => expect(r.status).toBe(201));

      expect((await preview({ productId: product.id })).body.data.decision).toBe('MATCHED');
      expect((await preview({ productId: other.id })).body.data.decision).toBe('NO_MATCH');
      // Free text is never routed on — a product rule needs the canonical id.
      expect((await preview({ source: 'Website' })).body.data.decision).toBe('NO_MATCH');
    });

    it('requires every stated criterion', async () => {
      const team = await teamWithAgent();
      const product = await createProduct();

      await createRule({
        name: unique('Both'),
        source: 'Website',
        productId: product.id,
        targetTeamId: team.id,
      }).then((r) => expect(r.status).toBe(201));

      expect(
        (await preview({ source: 'Website', productId: product.id })).body.data.decision,
      ).toBe('MATCHED');
      expect((await preview({ source: 'Website' })).body.data.decision).toBe('NO_MATCH');
      expect((await preview({ productId: product.id })).body.data.decision).toBe('NO_MATCH');
    });

    it('falls back only after the specific rules', async () => {
      const specific = await teamWithAgent();
      const catchAll = await teamWithAgent();

      await createRule({
        name: unique('Specific'),
        source: 'Website',
        targetTeamId: specific.id,
      }).then((r) => expect(r.status).toBe(201));
      await createRule({
        name: unique('Catch all'),
        isFallback: true,
        targetTeamId: catchAll.id,
      }).then((r) => expect(r.status).toBe(201));

      const matched = await preview({ source: 'Website' });
      expect(matched.body.data.decision).toBe('MATCHED');
      expect(matched.body.data.team.id).toBe(specific.id);

      const fell = await preview({ source: 'Trade show' });
      // Named differently from MATCHED on purpose: falling through usually
      // means the table is missing a rule somebody meant to write.
      expect(fell.body.data.decision).toBe('FALLBACK_MATCHED');
      expect(fell.body.data.team.id).toBe(catchAll.id);
      expect(fell.body.data.rule.isFallback).toBe(true);
    });

    it('ignores archived rules', async () => {
      const team = await teamWithAgent();
      const rule = await createRule({
        name: unique('Gone'),
        source: 'Website',
        targetTeamId: team.id,
      });

      await ctx
        .http()
        .patch(`/api/v1/assignment-rules/${rule.body.data.id}`)
        .set(owner())
        .send({ status: 'ARCHIVED' })
        .expect(200);

      expect((await preview({ source: 'Website' })).body.data.decision).toBe('NO_MATCH');
    });
  });

  // ---------------------------------------------------------------------------
  // Who could take it
  // ---------------------------------------------------------------------------

  describe('eligible agents', () => {
    it('says NO_ELIGIBLE_AGENTS rather than picking somebody else', async () => {
      const team = await emptyTeam();
      await createRule({ name: unique('Nobody'), source: 'Website', targetTeamId: team }).then(
        (r) => expect(r.status).toBe(201),
      );

      const response = await preview({ source: 'Website' });

      /*
       * The team is still the right answer — the rule matched. What is
       * refused is inventing a person: no manager, no admin, no owner, and no
       * quiet hop to another team. All of those would be routing policy
       * nobody configured.
       */
      expect(response.body.data).toMatchObject({
        decision: 'NO_ELIGIBLE_AGENTS',
        team: { id: team },
        eligibleAgentCount: 0,
      });
      expect(response.body.data.rule).not.toBeNull();
    });

    it('excludes a paused member', async () => {
      const team = await teamWithAgent();
      await createRule({ name: unique('Paused pool'), source: 'Website', targetTeamId: team.id });

      await ctx
        .http()
        .patch(`/api/v1/teams/${team.id}/members/${team.memberId}`)
        .set(owner())
        .send({ assignmentEnabled: false })
        .expect(200);

      // A rule never makes an ineligible person eligible. J3 decides.
      expect((await preview({ source: 'Website' })).body.data.decision).toBe('NO_ELIGIBLE_AGENTS');
    });

    it('excludes a suspended membership', async () => {
      const team = await teamWithAgent();
      await createRule({ name: unique('Suspended'), source: 'Website', targetTeamId: team.id });

      await ctx
        .http()
        .patch(`/api/v1/users/${team.userId}`)
        .set(owner())
        .send({ status: 'SUSPENDED' })
        .expect(200);

      expect((await preview({ source: 'Website' })).body.data.decision).toBe('NO_ELIGIBLE_AGENTS');
    });

    it('returns a POOL, never a choice', async () => {
      const team = await teamWithAgent();

      // Two agents in one team.
      const email = `${unique('second')}@example.test`;
      const invite = await ctx
        .http()
        .post('/api/v1/users/invite')
        .set(owner())
        .send({ email, fullName: 'Second Agent', role: 'SALES_REP' })
        .expect(201);
      await ctx
        .http()
        .post(`/api/v1/invitations/${invite.body.data.inviteToken}/accept`)
        .send({ firstName: 'Second', lastName: 'Agent', password: PASSWORD })
        .expect(200);
      await ctx
        .http()
        .post(`/api/v1/teams/${team.id}/members`)
        .set(owner())
        .send({ userId: invite.body.data.userId })
        .expect(201);

      await createRule({ name: unique('Pool'), source: 'Website', targetTeamId: team.id });

      const first = await preview({ source: 'Website' });
      const second = await preview({ source: 'Website' });

      /*
       * Both agents, both times. Choosing one here would mean advancing
       * whatever state the choice depends on during a PREVIEW — asking the
       * question would change the answer to the next one — and the real
       * selection has to happen in the same transaction as the lead write.
       */
      expect(first.body.data.eligibleAgentCount).toBe(2);
      expect(second.body.data.eligibleAgents.map((a: { userId: string }) => a.userId).sort()).toEqual(
        first.body.data.eligibleAgents.map((a: { userId: string }) => a.userId).sort(),
      );
    });

    it('returns nothing private about an agent', async () => {
      const team = await teamWithAgent();
      await createRule({ name: unique('Privacy'), source: 'Website', targetTeamId: team.id });

      const response = await preview({ source: 'Website' });
      const serialised = JSON.stringify(response.body);

      for (const secret of ['passwordHash', 'password_hash', 'refreshToken', 'inviteTokenHash']) {
        expect(serialised).not.toContain(secret);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Concurrency — decided by PostgreSQL, not by a prior read
  // ---------------------------------------------------------------------------

  describe('two administrators at once', () => {
    it('produces at most one active fallback', async () => {
      const first = await teamWithAgent();
      const second = await teamWithAgent();

      const [a, b] = await Promise.all([
        createRule({ name: unique('Fallback A'), isFallback: true, targetTeamId: first.id }),
        createRule({ name: unique('Fallback B'), isFallback: true, targetTeamId: second.id }),
      ]);

      // One wins, one is refused. Both succeeding would mean the last resort
      // depended on precedence nobody set.
      expect([a.status, b.status].sort()).toEqual([201, 409]);

      const active = await asSystem('e2e fallback count', () =>
        prisma().assignmentRule.count({
          where: { organizationId: ctx.orgA.id, status: 'ACTIVE', isFallback: true },
        }),
      );
      expect(active).toBe(1);
    });

    it('produces at most one active rule per set of criteria', async () => {
      const first = await teamWithAgent();
      const second = await teamWithAgent();
      const source = unique('Source');

      const [a, b] = await Promise.all([
        createRule({ name: unique('A'), source, targetTeamId: first.id }),
        createRule({ name: unique('B'), source, targetTeamId: second.id }),
      ]);

      expect([a.status, b.status].sort()).toEqual([201, 409]);

      // And the surviving rule is the one the evaluator uses — the routing
      // table cannot be ambiguous even for an instant.
      const decided = await preview({ source });
      expect(decided.body.data.decision).toBe('MATCHED');
    });

    it('never leaves live routing pointing at an archived team', async () => {
      const team = await teamWithAgent();

      /*
       * Archive and "add a rule targeting it" racing each other. Whatever the
       * interleaving, the end state must be coherent: either the team is
       * archived and no active rule points at it, or the rule exists and the
       * team is still active.
       */
      const [archive, rule] = await Promise.all([
        ctx.http().patch(`/api/v1/teams/${team.id}`).set(owner()).send({ status: 'ARCHIVED' }),
        createRule({ name: unique('Racing'), source: unique('Src'), targetTeamId: team.id }),
      ]);

      const teamAfter = await ctx.http().get(`/api/v1/teams/${team.id}`).set(owner()).expect(200);
      const activeRules = await asSystem('e2e routing check', () =>
        prisma().assignmentRule.count({
          where: { targetTeamId: team.id, status: 'ACTIVE' },
        }),
      );

      if (teamAfter.body.data.status === 'ARCHIVED') {
        expect(activeRules).toBe(0);
        expect(archive.status).toBe(200);
      } else {
        expect(rule.status).toBe(201);
        expect(activeRules).toBe(1);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Tenancy
  // ---------------------------------------------------------------------------

  describe('tenant isolation', () => {
    let foreignTeamId: string;
    let foreignRuleId: string;

    beforeAll(async () => {
      const team = await ctx
        .http()
        .post('/api/v1/teams')
        .set(auth(ctx.orgB.owner.accessToken))
        .send({ name: 'Org B Routing Team' })
        .expect(201);
      foreignTeamId = team.body.data.id;

      const rule = await ctx
        .http()
        .post('/api/v1/assignment-rules')
        .set(auth(ctx.orgB.owner.accessToken))
        .send({ name: 'Org B rule', source: 'Website', targetTeamId: foreignTeamId })
        .expect(201);
      foreignRuleId = rule.body.data.id;
    });

    it('never lists another organization’s rules', async () => {
      const response = await ctx.http().get('/api/v1/assignment-rules').set(owner()).expect(200);

      expect(response.body.data.map((r: { id: string }) => r.id)).not.toContain(foreignRuleId);
    });

    it('answers 404 for another organization’s rule', async () => {
      const response = await ctx
        .http()
        .get(`/api/v1/assignment-rules/${foreignRuleId}`)
        .set(owner());

      expect(response.status).toBe(404);
    });

    it('refuses to modify another organization’s rule', async () => {
      const response = await ctx
        .http()
        .patch(`/api/v1/assignment-rules/${foreignRuleId}`)
        .set(owner())
        .send({ status: 'PAUSED' });

      expect(response.status).toBe(404);
    });

    it('refuses to target another organization’s team', async () => {
      const response = await createRule({
        name: unique('Cross tenant'),
        source: 'Website',
        targetTeamId: foreignTeamId,
      });

      // "Could not be found" — never "that belongs to somebody else".
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).not.toContain('Org B');
    });

    it('refuses another organization’s product as a criterion', async () => {
      const foreignProduct = await ctx
        .http()
        .post('/api/v1/products')
        .set(auth(ctx.orgB.owner.accessToken))
        .send({ name: 'Org B Product', sku: unique('SKU-B').slice(0, 20) })
        .expect(201);

      const team = await teamWithAgent();
      const response = await createRule({
        name: unique('Foreign product'),
        productId: foreignProduct.body.data.id,
        targetTeamId: team.id,
      });

      expect(response.status).toBe(400);
    });

    it('evaluates only this tenant’s table', async () => {
      // Org B has an active "Website" rule; Org A's own table decides for A.
      await clearRules();
      const response = await preview({ source: 'Website' });

      expect(response.body.data.decision).toBe('NO_MATCH');
    });
  });

  // ---------------------------------------------------------------------------
  // Authorization
  // ---------------------------------------------------------------------------

  describe('authorization', () => {
    it('refuses a SALES_REP everything, on the server', async () => {
      const team = await teamWithAgent();
      const rep = ctx.orgA.rep;

      expect(
        (await ctx.http().get('/api/v1/assignment-rules').set(auth(rep.accessToken))).status,
      ).toBe(403);
      expect(
        (
          await ctx
            .http()
            .post('/api/v1/assignment-rules')
            .set(auth(rep.accessToken))
            .send({ name: 'Rep rule', source: 'Website', targetTeamId: team.id })
        ).status,
      ).toBe(403);
      // Including the preview: the routing table is not public inside the
      // organization either.
      expect((await preview({ source: 'Website' }, rep.accessToken)).status).toBe(403);
    });

    it('lets a MANAGER read and preview but not change', async () => {
      const email = `${unique('manager')}@example.test`;
      const invite = await ctx
        .http()
        .post('/api/v1/users/invite')
        .set(owner())
        .send({ email, fullName: 'Reading Manager', role: 'MANAGER' })
        .expect(201);
      await ctx
        .http()
        .post(`/api/v1/invitations/${invite.body.data.inviteToken}/accept`)
        .send({ firstName: 'Reading', lastName: 'Manager', password: PASSWORD })
        .expect(200);
      const login = await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email, password: PASSWORD, platform: 'ANDROID' })
        .expect(200);
      const token = login.body.data.tokens.accessToken as string;

      const team = await teamWithAgent();

      // A manager whose team stops receiving enquiries needs to find out why.
      await ctx.http().get('/api/v1/assignment-rules').set(auth(token)).expect(200);
      expect((await preview({ source: 'Website' }, token)).status).toBe(200);

      const attempt = await ctx
        .http()
        .post('/api/v1/assignment-rules')
        .set(auth(token))
        .send({ name: 'Manager rule', source: 'Website', targetTeamId: team.id });
      expect(attempt.status).toBe(403);
    });

    it('refuses an unauthenticated caller', async () => {
      expect((await ctx.http().get('/api/v1/assignment-rules')).status).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // What this phase deliberately does NOT do
  // ---------------------------------------------------------------------------

  describe('side effects', () => {
    it('changes no lead, no follow-up and no intake', async () => {
      const team = await teamWithAgent();

      const lead = await ctx
        .http()
        .post('/api/v1/leads')
        .set(owner())
        .send({
          firstName: 'Untouched',
          lastName: 'Customer',
          mobile: fixtureMobile(),
          nextFollowUpAt: tomorrow(),
          assignedToId: ctx.orgA.rep.id,
          source: 'Website',
        })
        .expect(201);

      const intakesBefore = await asSystem('e2e intake snapshot', () =>
        prisma().integrationIntake.findMany({ select: { id: true, status: true, createdLeadId: true } }),
      );
      const followUpsBefore = await asSystem('e2e followup count', () =>
        prisma().followUp.count(),
      );

      await createRule({ name: unique('Routing'), source: 'Website', targetTeamId: team.id });
      // Several previews, to be sure repetition changes nothing either.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect((await preview({ source: 'Website' })).body.data.decision).toBe('MATCHED');
      }

      const after = await ctx
        .http()
        .get(`/api/v1/leads/${lead.body.data.id}`)
        .set(owner())
        .expect(200);

      /*
       * The promise of this phase. Configuring and previewing routing must
       * not move a customer, invent a follow-up, or start converting website
       * intakes — those wait for the phase that can also decide WHO, and must
       * do it in the same transaction as the write.
       */
      expect(after.body.data.assignedTo?.id ?? after.body.data.assignedToId).toBe(ctx.orgA.rep.id);
      expect(after.body.data.nextFollowUpAt).toBe(lead.body.data.nextFollowUpAt);
      expect(after.body.data.status).toBe(lead.body.data.status);

      const intakesAfter = await asSystem('e2e intake snapshot', () =>
        prisma().integrationIntake.findMany({ select: { id: true, status: true, createdLeadId: true } }),
      );
      expect(intakesAfter).toEqual(intakesBefore);
      expect(await asSystem('e2e followup count', () => prisma().followUp.count())).toBe(
        followUpsBefore,
      );
    });

    it('leaves team membership exactly as it was', async () => {
      const team = await teamWithAgent();
      await createRule({ name: unique('No writes'), source: 'Website', targetTeamId: team.id });

      const before = await ctx.http().get(`/api/v1/teams/${team.id}`).set(owner()).expect(200);
      await preview({ source: 'Website' });
      const after = await ctx.http().get(`/api/v1/teams/${team.id}`).set(owner()).expect(200);

      expect(after.body.data.members).toEqual(before.body.data.members);
    });
  });

  /** A canonical catalogue product, which is the only product a rule may name. */
  async function createProduct() {
    const response = await ctx
      .http()
      .post('/api/v1/products')
      .set(owner())
      .send({ name: unique('Product').slice(0, 40), sku: unique('SKU').slice(0, 20) })
      .expect(201);

    return { id: response.body.data.id as string };
  }
});
