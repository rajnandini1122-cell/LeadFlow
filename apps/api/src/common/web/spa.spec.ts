import { isApiPath, isSpaRequest, webDistPath, API_PATH_PREFIXES } from './spa';

/**
 * Which requests belong to the API and which to the SPA.
 *
 * The decision is a pure function on purpose. Serving the frontend from the
 * API process means one wrong answer here turns an API route into an HTML
 * page — a client asking for JSON gets a parse error and goes looking in the
 * wrong place entirely — or turns the application's front door into a 404.
 * Both are cheap to assert exhaustively and expensive to discover in
 * production.
 */
describe('SPA routing decision', () => {
  describe('paths the API owns', () => {
    it.each([
      '/api',
      '/api/v1/leads',
      '/api/v1/integrations/website/intake',
      '/api/v1/integrations/admin-control/summary',
      '/api/metrics',
      '/api/docs',
      '/health',
      '/readiness',
    ])('%s is an API path', (path) => {
      expect(isApiPath(path)).toBe(true);
      expect(isSpaRequest('GET', path)).toBe(false);
    });

    it('never hands an API path to the SPA, whatever the method', () => {
      for (const method of ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE']) {
        expect(isSpaRequest(method, '/api/v1/leads')).toBe(false);
      }
    });

    it('matches on a segment boundary, not a bare prefix', () => {
      /*
       * `/apiary` and `/healthy` are ordinary client-side routes that happen
       * to start with the same letters. A startsWith check would hand them to
       * the API, which would 404 them — a bug that only appears when somebody
       * adds a page whose name begins with "api".
       */
      expect(isApiPath('/apiary')).toBe(false);
      expect(isApiPath('/healthy')).toBe(false);
      expect(isApiPath('/readinessx')).toBe(false);

      expect(isSpaRequest('GET', '/apiary')).toBe(true);
    });
  });

  describe('paths the SPA owns', () => {
    it.each(['/', '/leads', '/leads/42', '/follow-ups/today', '/settings/team'])(
      '%s falls back to the shell',
      (path) => {
        expect(isSpaRequest('GET', path)).toBe(true);
      },
    );

    it('answers HEAD as well as GET, so a link check sees the real status', () => {
      expect(isSpaRequest('HEAD', '/leads/42')).toBe(true);
    });

    it('does not rewrite a non-navigation method', () => {
      // A POST to an unknown path is not a client-side route. Answering it
      // with a page would turn a 404 into a misleading 200.
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(isSpaRequest(method, '/leads/42')).toBe(false);
      }
    });
  });

  describe('missing files stay missing', () => {
    it.each(['/assets/index-a1b2c3.js', '/assets/index-a1b2c3.css', '/favicon.ico', '/logo.svg'])(
      '%s is not rewritten to the shell',
      (path) => {
        /*
         * A fingerprinted asset that is not on disk is a broken deploy, and it
         * must say so. Rewriting it to index.html would answer a JavaScript
         * request with HTML: the browser reports a syntax error at line 1 and
         * the actual fault — a half-copied bundle — stays hidden.
         */
        expect(isSpaRequest('GET', path)).toBe(false);
      },
    );
  });

  describe('the exclusion list itself', () => {
    it('covers every path the server owns', () => {
      // Guards the list against a future route added outside the global
      // prefix: /health and /readiness are the only two excluded from it
      // today, and anything else added there would silently become the SPA.
      expect([...API_PATH_PREFIXES]).toEqual(['/api', '/health', '/readiness']);
    });
  });

  describe('where the bundle is looked for', () => {
    it('resolves the web build next to the api build', () => {
      // apps/api/dist -> apps/web/dist, the layout the Dockerfile produces.
      expect(webDistPath('/app/apps/api/dist').replace(/\\/g, '/')).toBe('/app/apps/web/dist');
    });
  });
});
