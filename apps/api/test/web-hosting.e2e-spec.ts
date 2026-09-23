import { createTestContext, type TestContext } from './helpers/test-app';

/**
 * The SPA and the API on ONE origin.
 *
 * Production serves the React bundle from the API process, which is what makes
 * the browser's relative `/api/v1` calls and its SameSite=Strict refresh cookie
 * work without CORS. That convenience has a sharp edge: every API route now
 * shares a URL space with a catch-all that answers with HTML.
 *
 * So the boundary is asserted from the outside, over real HTTP, against the
 * same helper main.ts uses. The questions are: does the shell reach a browser,
 * does it stay away from everything the server owns, and does a missing asset
 * still say it is missing.
 */
describe('Web hosting (SPA on the API origin)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const shell = /leadflow-spa-shell/;

  describe('the SPA is served', () => {
    it('answers the root with the shell', async () => {
      const response = await ctx.http().get('/').expect(200);

      expect(response.text).toMatch(shell);
      expect(response.headers['content-type']).toMatch(/text\/html/);
    });

    it('answers a deep client-side route with the shell', async () => {
      /*
       * The fallback, and the reason it exists. `/leads/42` is a route the
       * React router renders; the server has no such file and no such
       * endpoint. Without this a customer who refreshes the page — or opens a
       * link somebody sent them — gets a 404 for a page that works fine when
       * navigated to from inside the app.
       */
      const response = await ctx.http().get('/leads/42').expect(200);

      expect(response.text).toMatch(shell);
    });

    it('serves a real asset as itself', async () => {
      const response = await ctx.http().get('/assets/app.js').expect(200);

      expect(response.text).toMatch(/leadflow-spa-asset/);
      expect(response.text).not.toMatch(shell);
    });

    it('does not cache the shell', async () => {
      // index.html names the current fingerprinted assets, so a cached copy
      // pins a returning browser to a deploy whose assets no longer exist.
      const response = await ctx.http().get('/').expect(200);

      expect(response.headers['cache-control']).toMatch(/no-cache/);
    });

    it('answers a missing asset with 404, not the shell', async () => {
      /*
       * A fingerprinted file that is not on disk is a broken deploy. Rewriting
       * it to index.html would answer a JavaScript request with HTML, and the
       * browser would report a syntax error at line 1 — sending whoever reads
       * it to look at the wrong thing entirely.
       */
      const response = await ctx.http().get('/assets/does-not-exist.js');

      expect(response.status).toBe(404);
      expect(response.text).not.toMatch(shell);
    });
  });

  describe('the API is never shadowed', () => {
    it('keeps /api/v1 as the API', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/leads')
        .set({ Authorization: `Bearer ${ctx.orgA.owner.accessToken}` })
        .expect(200);

      // The envelope is the proof: this came from the API's interceptor, not
      // from a static handler. The exact payload shape is the leads suite's
      // business, not this one's.
      expect(response.body.success).toBe(true);
      expect(response.body).toHaveProperty('meta.requestId');
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.text).not.toMatch(shell);
    });

    it('answers an unknown API route with the API 404, not the shell', async () => {
      /*
       * The assertion that would catch a too-greedy fallback. A client that
       * asked for JSON and received an HTML page reports a parse error, which
       * looks like a client bug and sends nobody to the routing table.
       */
      const response = await ctx.http().get('/api/v1/not-a-real-route');

      expect(response.status).toBe(404);
      expect(response.text).not.toMatch(shell);
      expect(response.body.success).toBe(false);
    });

    it('keeps an unauthenticated API route refusing, not rendering', async () => {
      // 401 must survive. A fallback that caught this would turn "you are not
      // signed in" into a 200 and an empty page.
      const response = await ctx.http().get('/api/v1/leads');

      expect(response.status).toBe(401);
      expect(response.text).not.toMatch(shell);
    });

    it('keeps /health as the liveness probe', async () => {
      const response = await ctx.http().get('/health').expect(200);

      // Railway restarts on this. If it ever returned the SPA it would return
      // 200 forever, and a dead API would never be restarted.
      expect(response.body).toMatchObject({ status: 'ok' });
      expect(response.text).not.toMatch(shell);
    });

    it('keeps /readiness as the readiness probe', async () => {
      const response = await ctx.http().get('/readiness').expect(200);

      expect(response.body).toMatchObject({ status: 'ready' });
      expect(response.body.checks).toEqual({ database: true, cache: true });
    });

    it('keeps /api/metrics authenticated', async () => {
      // Still not public, and still not the SPA. A metrics endpoint that
      // started answering with a page would look "up" to any scraper.
      const anonymous = await ctx.http().get('/api/metrics');
      expect(anonymous.status).toBe(401);
      expect(anonymous.text).not.toMatch(shell);
    });

    it('does not rewrite a POST to an unknown path', async () => {
      const response = await ctx.http().post('/leads/42').send({});

      expect(response.status).toBe(404);
      expect(response.text).not.toMatch(shell);
    });
  });
});
