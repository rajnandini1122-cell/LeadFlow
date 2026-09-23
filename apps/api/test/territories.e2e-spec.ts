import { createTestContext, type TestContext } from './helpers/test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';

/**
 * Territories: geography turned into a name.
 *
 * Four properties carry the phase, and every case here is one of them:
 *
 *   resolution is DETERMINISTIC — most specific configured selector wins, and
 *   the order is fixed rather than decided by what the database returns first;
 *
 *   a place has ONE live owner, and that is a unique index rather than a
 *   prior read, so two administrators cannot both claim Pune;
 *
 *   nothing is GUESSED — a missing state is not inferred from a city, and an
 *   unmapped pincode does not fall back to somewhere plausible;
 *
 *   asking where an address belongs CHANGES NOTHING.
 *
 * And the promise made by not acting: no territory names a team, no territory
 * holds a person, no lead is created or moved, and no intake is processed.
 */
describe('Territories', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const unique = (prefix: string): string =>
    `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`;

  const asSystem = async <T>(reason: string, run: () => Promise<T>): Promise<T> =>
    ctx.app.get(TenantContextService).runAsSystem(reason, run);
  const prisma = () => ctx.app.get(PrismaService).client;

  const owner = () => auth(ctx.orgA.owner.accessToken);

  const createTerritory = async (name = unique('Territory'), token = ctx.orgA.owner.accessToken) =>
    ctx.http().post('/api/v1/territories').set(auth(token)).send({ name });

  /** A territory that exists, returning just its id. */
  const territoryId = async (name = unique('Territory')): Promise<string> => {
    const created = await createTerritory(name);
    expect(created.status).toBe(201);
    return created.body.data.id as string;
  };

  const addCoverage = async (
    id: string,
    body: Record<string, unknown>,
    token = ctx.orgA.owner.accessToken,
  ) => ctx.http().post(`/api/v1/territories/${id}/coverage`).set(auth(token)).send(body);

  const resolve = async (body: Record<string, unknown>, token = ctx.orgA.owner.accessToken) =>
    ctx.http().post('/api/v1/territories/resolve').set(auth(token)).send(body);

  /**
   * Retires every live territory, so each case starts from an empty map.
   *
   * Archiving releases the places a territory covered, which is exactly what
   * makes this possible — otherwise the first case to claim IN would hold it
   * for the rest of the file.
   */
  const clearTerritories = async (): Promise<void> => {
    const list = await ctx.http().get('/api/v1/territories').set(owner()).expect(200);

    for (const territory of list.body.data as { id: string; status: string }[]) {
      if (territory.status === 'ACTIVE') {
        await ctx
          .http()
          .patch(`/api/v1/territories/${territory.id}`)
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
    await clearTerritories();
  });

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  describe('writing territories', () => {
    it('creates one, trimmed, with no coverage yet', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/territories')
        .set(owner())
        .send({ name: '  Pune / PCMC  ', description: 'West Maharashtra' });

      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({
        name: 'Pune / PCMC',
        description: 'West Maharashtra',
        status: 'ACTIVE',
        coverageCount: 0,
      });
      expect(response.body.data.coverage).toEqual([]);
    });

    it('has no team and no members, by design', async () => {
      const response = await createTerritory();

      // The structural promise of the phase. A team here would be a second
      // routing authority; a member list would be a second copy of a person.
      expect(response.body.data).not.toHaveProperty('targetTeamId');
      expect(response.body.data).not.toHaveProperty('targetTeam');
      expect(response.body.data).not.toHaveProperty('members');
      expect(response.body.data).not.toHaveProperty('agents');
    });

    it('refuses a second ACTIVE territory with the same name', async () => {
      const name = unique('Duplicate');
      await createTerritory(name);

      const second = await createTerritory(name);
      expect(second.status).toBe(409);
    });

    it('treats case and spacing as the same name', async () => {
      await createTerritory('Pune  West');

      const second = await createTerritory('pune west');
      expect(second.status).toBe(409);
    });

    it('lets an archived name be used again', async () => {
      const name = unique('Recycled');
      const first = await territoryId(name);

      await ctx
        .http()
        .patch(`/api/v1/territories/${first}`)
        .set(owner())
        .send({ status: 'ARCHIVED' })
        .expect(200);

      const second = await createTerritory(name);
      expect(second.status).toBe(201);
    });

    it('offers no delete', async () => {
      const id = await territoryId();

      // A territory that once decided where enquiries went is the explanation
      // for why a customer reached the team they did.
      const response = await ctx.http().delete(`/api/v1/territories/${id}`).set(owner());
      expect(response.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // Coverage shapes
  // ---------------------------------------------------------------------------

  describe('coverage shapes', () => {
    it('accepts a country with nothing else', async () => {
      const id = await territoryId();
      const response = await addCoverage(id, { type: 'COUNTRY', country: 'IN' });

      expect(response.status).toBe(201);
      expect(response.body.data.coverage[0]).toMatchObject({
        type: 'COUNTRY',
        countryCode: 'IN',
        state: null,
        city: null,
        postalCode: null,
        label: 'IN',
      });
    });

    it('accepts a country for a place with no province layer', async () => {
      // The model is not built around India's hierarchy: Singapore and the UAE
      // have no state worth naming, and requiring one would refuse them.
      const id = await territoryId();
      expect((await addCoverage(id, { type: 'COUNTRY', country: 'AE' })).status).toBe(201);
      expect((await addCoverage(id, { type: 'COUNTRY', country: 'SG' })).status).toBe(201);
    });

    it('accepts a city WITHOUT a state', async () => {
      const id = await territoryId();
      const response = await addCoverage(id, { type: 'CITY', country: 'SG', city: 'Singapore' });

      expect(response.status).toBe(201);
      expect(response.body.data.coverage[0]).toMatchObject({ city: 'Singapore', state: null });
    });

    it('refuses a country selector that also names a city', async () => {
      const id = await territoryId();
      const response = await addCoverage(id, { type: 'COUNTRY', country: 'IN', city: 'Pune' });

      // Either a mistake or a CITY selector. Storing it as the first while
      // somebody meant the second misroutes with nothing in the record to say so.
      expect(response.status).toBe(400);
    });

    it('refuses a state selector with no state', async () => {
      const id = await territoryId();
      expect((await addCoverage(id, { type: 'STATE', country: 'IN' })).status).toBe(400);
    });

    it('refuses a postal selector with no postal code', async () => {
      const id = await territoryId();
      expect((await addCoverage(id, { type: 'POSTAL_CODE', country: 'IN' })).status).toBe(400);
    });

    it('refuses a postal selector that also names a city', async () => {
      const id = await territoryId();
      const response = await addCoverage(id, {
        type: 'POSTAL_CODE',
        country: 'IN',
        postalCode: '411019',
        city: 'Pune',
      });

      expect(response.status).toBe(400);
    });

    it('refuses a country that is not a real region', async () => {
      const id = await territoryId();
      // The same ICU-backed check organization settings and the website intake
      // already use, rather than a second opinion about what a country is.
      expect((await addCoverage(id, { type: 'COUNTRY', country: 'ZZ' })).status).toBe(400);
      expect((await addCoverage(id, { type: 'COUNTRY', country: 'XX' })).status).toBe(400);
    });

    it('refuses a message typed into the postal code box', async () => {
      const id = await territoryId();
      const response = await addCoverage(id, {
        type: 'POSTAL_CODE',
        country: 'IN',
        postalCode: 'call me back',
      });

      expect(response.status).toBe(400);
    });

    it('never accepts a canonical key from the client', async () => {
      const id = await territoryId();
      const response = await addCoverage(id, {
        type: 'COUNTRY',
        country: 'IN',
        coverageKey: 'COUNTRY|XX',
      });

      // The key is what the database uses to decide who owns a place, so a
      // caller able to choose it could claim somebody else's. Refused outright
      // by the global pipe rather than ignored.
      expect(response.status).toBe(400);
    });

    it('refuses coverage on an archived territory', async () => {
      const id = await territoryId();
      await ctx
        .http()
        .patch(`/api/v1/territories/${id}`)
        .set(owner())
        .send({ status: 'ARCHIVED' })
        .expect(200);

      expect((await addCoverage(id, { type: 'COUNTRY', country: 'IN' })).status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Resolution — the matrix
  // ---------------------------------------------------------------------------

  describe('resolving a location', () => {
    it('resolves a country', async () => {
      const india = await territoryId(unique('India'));
      await addCoverage(india, { type: 'COUNTRY', country: 'IN' }).then((r) =>
        expect(r.status).toBe(201),
      );

      const response = await resolve({ country: 'IN' });

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        decision: 'MATCHED',
        territory: { id: india },
        matchedCoverage: { type: 'COUNTRY' },
      });
    });

    it('reports NO_MATCH for a country nobody covers', async () => {
      const india = await territoryId();
      await addCoverage(india, { type: 'COUNTRY', country: 'IN' });

      const response = await resolve({ country: 'FR' });

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        decision: 'NO_MATCH',
        territory: null,
        matchedCoverage: null,
      });
    });

    it('lets a state beat the country it is in', async () => {
      const india = await territoryId(unique('India'));
      const maharashtra = await territoryId(unique('Maharashtra'));
      await addCoverage(india, { type: 'COUNTRY', country: 'IN' });
      await addCoverage(maharashtra, { type: 'STATE', country: 'IN', state: 'Maharashtra' });

      const inState = await resolve({ country: 'IN', state: 'Maharashtra' });
      expect(inState.body.data.territory.id).toBe(maharashtra);
      expect(inState.body.data.matchedCoverage.type).toBe('STATE');

      // And anywhere else in India still resolves to India.
      const elsewhere = await resolve({ country: 'IN', state: 'Kerala' });
      expect(elsewhere.body.data.territory.id).toBe(india);
    });

    it('matches a state whatever the case', async () => {
      const maharashtra = await territoryId();
      await addCoverage(maharashtra, { type: 'STATE', country: 'IN', state: 'Maharashtra' });

      for (const spelling of ['maharashtra', 'MAHARASHTRA', '  Maharashtra ']) {
        const response = await resolve({ country: 'IN', state: spelling });
        expect(response.body.data.territory.id).toBe(maharashtra);
      }
    });

    it('lets a city beat the state it is in', async () => {
      const maharashtra = await territoryId(unique('Maharashtra'));
      const pune = await territoryId(unique('Pune'));
      await addCoverage(maharashtra, { type: 'STATE', country: 'IN', state: 'Maharashtra' });
      await addCoverage(pune, { type: 'CITY', country: 'IN', state: 'Maharashtra', city: 'Pune' });

      const response = await resolve({ country: 'IN', state: 'Maharashtra', city: 'Pune' });

      expect(response.body.data.territory.id).toBe(pune);
      expect(response.body.data.matchedCoverage.type).toBe('CITY');
    });

    it('matches a city whatever the spacing', async () => {
      const naviMumbai = await territoryId();
      await addCoverage(naviMumbai, { type: 'CITY', country: 'IN', city: 'Navi Mumbai' });

      for (const spelling of ['navi mumbai', '  Navi   Mumbai  ', 'NAVI MUMBAI']) {
        const response = await resolve({ country: 'IN', city: spelling });
        expect(response.body.data.territory.id).toBe(naviMumbai);
      }
    });

    it('keeps the same city name in two states apart', async () => {
      const illinois = await territoryId(unique('Illinois'));
      const missouri = await territoryId(unique('Missouri'));
      await addCoverage(illinois, {
        type: 'CITY',
        country: 'US',
        state: 'Illinois',
        city: 'Springfield',
      });
      await addCoverage(missouri, {
        type: 'CITY',
        country: 'US',
        state: 'Missouri',
        city: 'Springfield',
      });

      const inIllinois = await resolve({ country: 'US', state: 'Illinois', city: 'Springfield' });
      const inMissouri = await resolve({ country: 'US', state: 'Missouri', city: 'Springfield' });

      expect(inIllinois.body.data.territory.id).toBe(illinois);
      expect(inMissouri.body.data.territory.id).toBe(missouri);
    });

    it('does not use a state-qualified city when no state was supplied', async () => {
      const illinois = await territoryId();
      await addCoverage(illinois, {
        type: 'CITY',
        country: 'US',
        state: 'Illinois',
        city: 'Springfield',
      });

      // Two states have a Springfield. Picking Illinois because it is the only
      // one configured would be a guess that happens to work until somebody
      // adds Missouri — and then it would silently change answer.
      const response = await resolve({ country: 'US', city: 'Springfield' });
      expect(response.body.data.decision).toBe('NO_MATCH');
    });

    it('lets a postal code beat the city it is in', async () => {
      const pune = await territoryId(unique('Pune'));
      const pcmc = await territoryId(unique('PCMC'));
      await addCoverage(pune, { type: 'CITY', country: 'IN', city: 'Pune' });
      await addCoverage(pcmc, { type: 'POSTAL_CODE', country: 'IN', postalCode: '411019' });

      const response = await resolve({ country: 'IN', city: 'Pune', postalCode: '411019' });

      expect(response.body.data.territory.id).toBe(pcmc);
      expect(response.body.data.matchedCoverage.type).toBe('POSTAL_CODE');
    });

    it('matches a postal code whatever the formatting', async () => {
      const london = await territoryId();
      await addCoverage(london, { type: 'POSTAL_CODE', country: 'GB', postalCode: 'SW1A 1AA' });

      for (const spelling of ['SW1A1AA', 'sw1a 1aa', ' sw1a1aa ']) {
        const response = await resolve({ country: 'GB', postalCode: spelling });
        expect(response.body.data.territory.id).toBe(london);
      }
    });

    it('falls back to the city when the postal code is not covered', async () => {
      const pune = await territoryId();
      await addCoverage(pune, { type: 'CITY', country: 'IN', city: 'Pune' });

      const response = await resolve({ country: 'IN', city: 'Pune', postalCode: '999999' });

      expect(response.body.data.territory.id).toBe(pune);
      expect(response.body.data.matchedCoverage.type).toBe('CITY');
    });

    it('walks the whole order: postal, then city, then state, then country', async () => {
      const india = await territoryId(unique('India'));
      const maharashtra = await territoryId(unique('MH'));
      const pune = await territoryId(unique('Pune'));
      const pcmc = await territoryId(unique('PCMC'));

      await addCoverage(india, { type: 'COUNTRY', country: 'IN' });
      await addCoverage(maharashtra, { type: 'STATE', country: 'IN', state: 'Maharashtra' });
      await addCoverage(pune, { type: 'CITY', country: 'IN', state: 'Maharashtra', city: 'Pune' });
      await addCoverage(pcmc, { type: 'POSTAL_CODE', country: 'IN', postalCode: '411019' });

      const facts = { country: 'IN', state: 'Maharashtra', city: 'Pune', postalCode: '411019' };

      expect((await resolve(facts)).body.data.territory.id).toBe(pcmc);
      expect((await resolve({ ...facts, postalCode: undefined })).body.data.territory.id).toBe(pune);
      expect((await resolve({ country: 'IN', state: 'Maharashtra' })).body.data.territory.id).toBe(
        maharashtra,
      );
      expect((await resolve({ country: 'IN' })).body.data.territory.id).toBe(india);
    });

    it('never invents a fact it was not given', async () => {
      const pcmc = await territoryId(unique('PCMC'));
      await addCoverage(pcmc, { type: 'POSTAL_CODE', country: 'IN', postalCode: '411019' });

      // Pune is covered by pincode only. An enquiry that says "Pune" and no
      // more does NOT get that pincode's territory — looking one up would be
      // routing a customer on a guess.
      const response = await resolve({ country: 'IN', city: 'Pune' });
      expect(response.body.data.decision).toBe('NO_MATCH');
    });

    it('needs a country before anything else means a place', async () => {
      const maharashtra = await territoryId();
      await addCoverage(maharashtra, { type: 'STATE', country: 'IN', state: 'Maharashtra' });

      // Defaulting to the tenant's own country is the assumption that works
      // until the first export enquiry.
      expect((await resolve({ state: 'Maharashtra' })).body.data.decision).toBe('NO_MATCH');
      expect((await resolve({ postalCode: '411019' })).body.data.decision).toBe('NO_MATCH');
      expect((await resolve({})).body.data.decision).toBe('NO_MATCH');
    });

    it('gives the same answer every time', async () => {
      const pune = await territoryId();
      await addCoverage(pune, { type: 'CITY', country: 'IN', state: 'Maharashtra', city: 'Pune' });

      const answers = await Promise.all(
        Array.from({ length: 5 }, () =>
          resolve({ country: 'in', state: ' MAHARASHTRA ', city: 'pune' }),
        ),
      );

      // No AMBIGUOUS outcome exists to report, because a place has one live
      // owner and the order is fixed — the ambiguity was made impossible
      // rather than resolved by a preference.
      for (const answer of answers) {
        expect(answer.body.data.territory.id).toBe(pune);
        expect(answer.body.data.decision).toBe('MATCHED');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // One live owner per place
  // ---------------------------------------------------------------------------

  describe('coverage conflicts', () => {
    const duplicates: [string, Record<string, unknown>][] = [
      ['country', { type: 'COUNTRY', country: 'IN' }],
      ['state', { type: 'STATE', country: 'IN', state: 'Maharashtra' }],
      ['city', { type: 'CITY', country: 'IN', state: 'Maharashtra', city: 'Pune' }],
      ['city without a state', { type: 'CITY', country: 'IN', city: 'Pune' }],
      ['postal code', { type: 'POSTAL_CODE', country: 'IN', postalCode: '411019' }],
    ];

    it.each(duplicates)('refuses a second territory claiming the same %s', async (_label, body) => {
      const first = await territoryId(unique('First'));
      const second = await territoryId(unique('Second'));

      expect((await addCoverage(first, body)).status).toBe(201);

      const clash = await addCoverage(second, body);
      expect(clash.status).toBe(409);
      // Names the holder, rather than sending an administrator hunting
      // through every territory.
      expect(String(clash.body.error.message)).toContain('already covered');
    });

    it('refuses a duplicate written in a different case', async () => {
      const first = await territoryId(unique('First'));
      const second = await territoryId(unique('Second'));

      await addCoverage(first, { type: 'STATE', country: 'IN', state: 'Maharashtra' });
      const clash = await addCoverage(second, {
        type: 'STATE',
        country: 'in',
        state: '  MAHARASHTRA  ',
      });

      expect(clash.status).toBe(409);
    });

    it('treats re-adding a place the territory already has as success', async () => {
      const id = await territoryId();
      const body = { type: 'COUNTRY', country: 'IN' };

      expect((await addCoverage(id, body)).status).toBe(201);

      // A double-click asked for a state that already holds. A 409 here would
      // make success look like failure.
      const again = await addCoverage(id, body);
      expect(again.status).toBe(201);
      expect(again.body.data.coverageCount).toBe(1);
    });

    it('lets a place move between territories, removed first', async () => {
      const first = await territoryId(unique('First'));
      const second = await territoryId(unique('Second'));
      const body = { type: 'CITY', country: 'IN', city: 'Pune' };

      const added = await addCoverage(first, body);
      const coverageId = added.body.data.coverage[0].id as string;

      // Still held: the transfer has not happened yet.
      expect((await addCoverage(second, body)).status).toBe(409);

      await ctx
        .http()
        .post(`/api/v1/territories/${first}/coverage/${coverageId}/remove`)
        .set(owner())
        .expect(200);

      expect((await addCoverage(second, body)).status).toBe(201);
      expect((await resolve({ country: 'IN', city: 'Pune' })).body.data.territory.id).toBe(second);
    });
  });

  // ---------------------------------------------------------------------------
  // Concurrency — decided by PostgreSQL, not by a prior read
  // ---------------------------------------------------------------------------

  describe('two administrators at once', () => {
    it('produces at most one live owner when the same place is claimed twice', async () => {
      const first = await territoryId(unique('First'));
      const second = await territoryId(unique('Second'));
      const body = { type: 'STATE', country: 'IN', state: unique('State').replace(/\./g, ' ') };

      const [a, b] = await Promise.all([addCoverage(first, body), addCoverage(second, body)]);

      // One wins, one is refused. Both succeeding would make resolution depend
      // on row order, and the same enquiry would route two ways.
      expect([a.status, b.status].sort()).toEqual([201, 409]);

      const live = await asSystem('e2e coverage owners', () =>
        prisma().territoryCoverage.count({
          where: { organizationId: ctx.orgA.id, removedAt: null, territoryId: { in: [first, second] } },
        }),
      );
      expect(live).toBe(1);
    });

    it('produces at most one row when ONE territory claims a place twice at once', async () => {
      const id = await territoryId();
      const body = { type: 'POSTAL_CODE', country: 'IN', postalCode: '411019' };

      const [a, b] = await Promise.all([addCoverage(id, body), addCoverage(id, body)]);

      // Both are answered as success — the caller asked for a state that holds
      // — but only one row exists, so the place has one owner and one history.
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);

      const live = await asSystem('e2e single claim', () =>
        prisma().territoryCoverage.count({
          where: { organizationId: ctx.orgA.id, territoryId: id, removedAt: null },
        }),
      );
      expect(live).toBe(1);
    });

    it('never leaves two live owners when a place is removed and re-added at once', async () => {
      const first = await territoryId(unique('First'));
      const second = await territoryId(unique('Second'));
      const body = { type: 'CITY', country: 'IN', city: unique('City').replace(/\./g, ' ') };

      const added = await addCoverage(first, body);
      const coverageId = added.body.data.coverage[0].id as string;

      await Promise.all([
        ctx
          .http()
          .post(`/api/v1/territories/${first}/coverage/${coverageId}/remove`)
          .set(owner()),
        addCoverage(second, body),
      ]);

      const live = await asSystem('e2e transfer owners', () =>
        prisma().territoryCoverage.findMany({
          where: {
            organizationId: ctx.orgA.id,
            removedAt: null,
            territoryId: { in: [first, second] },
          },
          select: { territoryId: true },
        }),
      );

      // Either ordering is legitimate — the removal may or may not have landed
      // first — but two live owners never is.
      expect(live.length).toBeLessThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Removal and archiving
  // ---------------------------------------------------------------------------

  describe('retiring things', () => {
    it('keeps the coverage row when a place is removed', async () => {
      const id = await territoryId();
      const added = await addCoverage(id, { type: 'COUNTRY', country: 'IN' });
      const coverageId = added.body.data.coverage[0].id as string;

      const after = await ctx
        .http()
        .post(`/api/v1/territories/${id}/coverage/${coverageId}/remove`)
        .set(owner())
        .expect(200);

      expect(after.body.data.coverageCount).toBe(0);
      expect((await resolve({ country: 'IN' })).body.data.decision).toBe('NO_MATCH');

      // Soft removal: the row explains where enquiries went while it was live.
      const row = await asSystem('e2e removed coverage', () =>
        prisma().territoryCoverage.findFirst({ where: { id: coverageId } }),
      );
      expect(row?.removedAt).not.toBeNull();
    });

    it('leaves the territory alone when a place is removed', async () => {
      const id = await territoryId();
      const added = await addCoverage(id, { type: 'COUNTRY', country: 'IN' });

      await ctx
        .http()
        .post(`/api/v1/territories/${id}/coverage/${added.body.data.coverage[0].id}/remove`)
        .set(owner())
        .expect(200);

      const detail = await ctx.http().get(`/api/v1/territories/${id}`).set(owner()).expect(200);
      expect(detail.body.data.status).toBe('ACTIVE');
    });

    it('releases the places a territory covered when it is archived', async () => {
      const first = await territoryId(unique('First'));
      await addCoverage(first, { type: 'COUNTRY', country: 'IN' });

      await ctx
        .http()
        .patch(`/api/v1/territories/${first}`)
        .set(owner())
        .send({ status: 'ARCHIVED' })
        .expect(200);

      // Otherwise a retired territory would hold its claim on India forever,
      // and the administrator who archived it to redraw the map could not.
      const second = await territoryId(unique('Second'));
      expect((await addCoverage(second, { type: 'COUNTRY', country: 'IN' })).status).toBe(201);
    });

    it('stops an archived territory resolving', async () => {
      const id = await territoryId();
      await addCoverage(id, { type: 'COUNTRY', country: 'IN' });

      await ctx
        .http()
        .patch(`/api/v1/territories/${id}`)
        .set(owner())
        .send({ status: 'ARCHIVED' })
        .expect(200);

      expect((await resolve({ country: 'IN' })).body.data.decision).toBe('NO_MATCH');
    });
  });

  // ---------------------------------------------------------------------------
  // Permissions
  // ---------------------------------------------------------------------------

  describe('who may do what', () => {
    it('refuses a sales rep entirely', async () => {
      const rep = auth(ctx.orgA.rep.accessToken);

      expect((await ctx.http().get('/api/v1/territories').set(rep)).status).toBe(403);
      expect(
        (await ctx.http().post('/api/v1/territories').set(rep).send({ name: unique('Nope') }))
          .status,
      ).toBe(403);
      expect(
        (await ctx.http().post('/api/v1/territories/resolve').set(rep).send({ country: 'IN' }))
          .status,
      ).toBe(403);
    });

    it('refuses an unauthenticated caller', async () => {
      expect((await ctx.http().get('/api/v1/territories')).status).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Asking changes nothing
  // ---------------------------------------------------------------------------

  describe('resolution is read-only', () => {
    it('writes nothing anywhere', async () => {
      const id = await territoryId();
      await addCoverage(id, { type: 'CITY', country: 'IN', state: 'Maharashtra', city: 'Pune' });

      const before = await asSystem('e2e before resolve', async () => {
        const client = prisma();
        const where = { organizationId: ctx.orgA.id };

        return {
          leads: await client.lead.count({ where }),
          contacts: await client.contact.count({ where }),
          accounts: await client.account.count({ where }),
          followUps: await client.followUp.count({ where }),
          intakes: await client.integrationIntake.count({ where }),
          teams: await client.team.count({ where }),
          teamMembers: await client.teamMember.count({ where }),
          rules: await client.assignmentRule.count({ where }),
          territories: await client.territory.count({ where }),
          coverage: await client.territoryCoverage.count({ where }),
          liveCoverage: await client.territoryCoverage.count({
            where: { ...where, removedAt: null },
          }),
        };
      });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await resolve({ country: 'IN', state: 'Maharashtra', city: 'Pune', postalCode: '411019' });
        await resolve({ country: 'FR' });
      }

      const after = await asSystem('e2e after resolve', async () => {
        const client = prisma();
        const where = { organizationId: ctx.orgA.id };

        return {
          leads: await client.lead.count({ where }),
          contacts: await client.contact.count({ where }),
          accounts: await client.account.count({ where }),
          followUps: await client.followUp.count({ where }),
          intakes: await client.integrationIntake.count({ where }),
          teams: await client.team.count({ where }),
          teamMembers: await client.teamMember.count({ where }),
          rules: await client.assignmentRule.count({ where }),
          territories: await client.territory.count({ where }),
          coverage: await client.territoryCoverage.count({ where }),
          liveCoverage: await client.territoryCoverage.count({
            where: { ...where, removedAt: null },
          }),
        };
      });

      expect(after).toEqual(before);
    });

    it('marks no intake as processed', async () => {
      const id = await territoryId();
      await addCoverage(id, { type: 'COUNTRY', country: 'IN' });

      await resolve({ country: 'IN' });

      // Converting an intake into a lead is a later phase. Nothing here starts
      // it early.
      const processed = await asSystem('e2e intake untouched', () =>
        prisma().integrationIntake.count({
          where: { organizationId: ctx.orgA.id, status: { not: 'RECEIVED' } },
        }),
      );
      expect(processed).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Audit
  // ---------------------------------------------------------------------------

  describe('audit trail', () => {
    it('records the map being drawn and redrawn', async () => {
      const id = await territoryId(unique('Audited'));
      const added = await addCoverage(id, { type: 'COUNTRY', country: 'IN' });
      const coverageId = added.body.data.coverage[0].id as string;

      await ctx
        .http()
        .patch(`/api/v1/territories/${id}`)
        .set(owner())
        .send({ description: 'Redrawn' })
        .expect(200);

      await ctx
        .http()
        .post(`/api/v1/territories/${id}/coverage/${coverageId}/remove`)
        .set(owner())
        .expect(200);

      await ctx
        .http()
        .patch(`/api/v1/territories/${id}`)
        .set(owner())
        .send({ status: 'ARCHIVED' })
        .expect(200);

      const entries = await asSystem('e2e territory audit', () =>
        prisma().auditLog.findMany({
          where: { entityType: 'Territory', entityId: id },
          select: { action: true, after: true },
        }),
      );

      expect(entries.map((entry) => entry.action).sort()).toEqual([
        'territory.archived',
        'territory.coverage_added',
        'territory.coverage_removed',
        'territory.created',
        'territory.updated',
      ]);

      // Selectors and ids, never a customer. An audit row answers "who changed
      // the map" and needs no enquiry attached to it.
      expect(JSON.stringify(entries)).not.toMatch(/@example\.test/);
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant isolation
  // ---------------------------------------------------------------------------

  describe('one organization cannot see another', () => {
    const otherOwner = () => auth(ctx.orgB.owner.accessToken);

    it('lists only its own territories', async () => {
      const mine = await territoryId(unique('Mine'));

      const theirs = await ctx
        .http()
        .post('/api/v1/territories')
        .set(otherOwner())
        .send({ name: unique('Theirs') })
        .expect(201);

      const listA = await ctx.http().get('/api/v1/territories').set(owner()).expect(200);
      const ids = (listA.body.data as { id: string }[]).map((row) => row.id);

      expect(ids).toContain(mine);
      expect(ids).not.toContain(theirs.body.data.id);
    });

    it('cannot read, edit or extend another organization’s territory', async () => {
      const theirs = await ctx
        .http()
        .post('/api/v1/territories')
        .set(otherOwner())
        .send({ name: unique('Theirs') })
        .expect(201);

      const id = theirs.body.data.id as string;

      // 404 rather than 403 everywhere: a different answer for a foreign id
      // would confirm that it exists.
      expect((await ctx.http().get(`/api/v1/territories/${id}`).set(owner())).status).toBe(404);
      expect(
        (await ctx.http().patch(`/api/v1/territories/${id}`).set(owner()).send({ name: 'Taken' }))
          .status,
      ).toBe(404);
      expect((await addCoverage(id, { type: 'COUNTRY', country: 'IN' })).status).toBe(404);
    });

    it('cannot remove another organization’s coverage', async () => {
      const theirs = await ctx
        .http()
        .post('/api/v1/territories')
        .set(otherOwner())
        .send({ name: unique('Theirs') })
        .expect(201);

      const added = await ctx
        .http()
        .post(`/api/v1/territories/${theirs.body.data.id}/coverage`)
        .set(otherOwner())
        .send({ type: 'COUNTRY', country: 'DE' })
        .expect(201);

      const response = await ctx
        .http()
        .post(
          `/api/v1/territories/${theirs.body.data.id}/coverage/${added.body.data.coverage[0].id}/remove`,
        )
        .set(owner());

      expect(response.status).toBe(404);
    });

    it('never resolves using another organization’s map', async () => {
      const theirs = await ctx
        .http()
        .post('/api/v1/territories')
        .set(otherOwner())
        .send({ name: unique('Theirs') })
        .expect(201);

      await ctx
        .http()
        .post(`/api/v1/territories/${theirs.body.data.id}/coverage`)
        .set(otherOwner())
        .send({ type: 'COUNTRY', country: 'BR' })
        .expect(201);

      // Org B covers Brazil. Org A asking about Brazil learns nothing — not
      // the territory, not its name, not that anybody covers it at all.
      const response = await resolve({ country: 'BR' });
      expect(response.body.data).toMatchObject({ decision: 'NO_MATCH', territory: null });

      // And both may cover Brazil at once: the unique index is per tenant.
      const mine = await territoryId(unique('Mine'));
      expect((await addCoverage(mine, { type: 'COUNTRY', country: 'BR' })).status).toBe(201);
    });
  });
});
