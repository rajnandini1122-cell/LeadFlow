import { createTestContext, type TestContext } from './helpers/test-app';

/**
 * Home market vs international leads — for CRAVION, Indian buyers vs
 * importers abroad. The market is derived from the lead's country, else the
 * dialling code of its mobile, against the ORGANIZATION's country.
 */
describe('Lead market (domestic vs international)', () => {
  let ctx: TestContext;
  const owner = () => ({ Authorization: `Bearer ${ctx.orgA.owner.accessToken}` });
  const inDays = (d: number): string => new Date(Date.now() + d * 86_400_000).toISOString();
  const suffix = () => String(Math.floor(1_000_000 + Math.random() * 8_999_999));

  let home = '';
  const ids: Record<string, string> = {};

  const create = async (key: string, mobile: string) => {
    const res = await ctx
      .http()
      .post('/api/v1/leads')
      .set(owner())
      .send({ firstName: `Market ${key}`, mobile, assignedToId: ctx.orgA.owner.id, nextFollowUpAt: inDays(1) })
      .expect(201);
    ids[key] = res.body.data.id as string;
  };

  const list = async (market: string) =>
    (
      (await ctx.http().get(`/api/v1/leads?market=${market}&limit=100`).set(owner()).expect(200)).body.data as {
        items: { id: string; market: string }[];
        total: number;
      }
    );

  beforeAll(async () => {
    ctx = await createTestContext();
    home = ((await ctx.http().get('/api/v1/organizations/current').set(owner()).expect(200)).body.data.country as string) ?? 'US';

    // One number from India, one from the UAE, one from the UK.
    await create('india', `+91981${suffix()}`.slice(0, 13));
    await create('uae', `+97150${suffix()}`);
    await create('uk', `+4477${suffix()}${'0'}`.slice(0, 13));
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const expected = (key: 'india' | 'uae' | 'uk') =>
    ({ india: 'IN', uae: 'AE', uk: 'GB' })[key] === home ? 'DOMESTIC' : 'INTERNATIONAL';

  it('labels each lead with its market', async () => {
    const all = (await ctx.http().get('/api/v1/leads?limit=100').set(owner()).expect(200)).body.data.items as {
      id: string;
      market: string;
    }[];
    for (const key of ['india', 'uae', 'uk'] as const) {
      expect({ key, market: all.find((l) => l.id === ids[key])?.market }).toEqual({ key, market: expected(key) });
    }
  });

  it('filters by market, and the total matches the rows', async () => {
    const intl = await list('INTERNATIONAL');
    const dom = await list('DOMESTIC');

    for (const key of ['india', 'uae', 'uk'] as const) {
      const bucket = expected(key) === 'DOMESTIC' ? dom : intl;
      const other = expected(key) === 'DOMESTIC' ? intl : dom;
      expect(bucket.items.map((l) => l.id)).toContain(ids[key]);
      expect(other.items.map((l) => l.id)).not.toContain(ids[key]);
    }
    expect(intl.items.every((l) => l.market === 'INTERNATIONAL')).toBe(true);
    expect(dom.items.every((l) => l.market === 'DOMESTIC')).toBe(true);
    expect(intl.total).toBe(intl.items.length);
    expect(dom.total).toBe(dom.items.length);
  });

  it('refuses an unknown market value', async () => {
    await ctx.http().get('/api/v1/leads?market=MARS').set(owner()).expect(400);
  });
});
