import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Serving the React app from the API process.
 *
 * The browser bundle asks for `/api/v1/...` RELATIVELY, and the refresh token
 * is an httpOnly SameSite=Strict cookie. Both of those are decisions that only
 * hold if the SPA and the API answer on ONE origin: a separately hosted
 * frontend would need an absolute API URL baked in at build time, CORS, and a
 * cookie that is no longer same-site — three changes to security-relevant
 * behaviour, to avoid serving some static files.
 *
 * So the image that runs the API also serves the bundle it was built with.
 * They ship together and therefore cannot disagree about the contract between
 * them, which is the other half of why this is the smallest correct answer.
 *
 * No new dependency. The application is already a NestExpressApplication, and
 * `useStaticAssets` is Express's own static handler, which @nestjs/platform-
 * express already bundles.
 */

/**
 * Paths that belong to the API and must NEVER be answered with the SPA.
 *
 * Everything the server owns lives under one of these three. `/api` covers
 * every versioned route and `/api/metrics`; the other two are the probes,
 * which `setGlobalPrefix` deliberately excludes from the prefix and which
 * therefore sit at the root next to the SPA's own routes.
 *
 * A request that matches one of these falls through to the Nest router, so an
 * unknown API path answers with the API's JSON 404 rather than with HTML. That
 * distinction matters more than it looks: a client that asked for JSON and got
 * an HTML page reports a parse error, and whoever reads that error goes looking
 * in entirely the wrong place.
 */
export const API_PATH_PREFIXES = ['/api', '/health', '/readiness'] as const;

/** Whether a path is owned by the API rather than by the SPA. */
export function isApiPath(path: string): boolean {
  // Exact match or a real segment boundary — never a bare startsWith, which
  // would hand `/apiary` to the API and `/healthcheck` with it.
  return API_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Whether a path names a FILE rather than a client-side route.
 *
 * Used to decide what happens when a file is missing. `/assets/main-a1b2c3.js`
 * that is not on disk is a broken deploy and must answer 404; `/leads/42` is a
 * route the SPA renders itself and must answer with index.html. The difference
 * is an extension on the last segment.
 *
 * Deliberately not an Accept-header check. Browsers send a wildcard Accept for
 * scripts and `text/html` for navigation, which would work — until something
 * that is not a browser asks for `/`, sends no Accept header, and receives a
 * 404 for the application's front door.
 */
function looksLikeFile(path: string): boolean {
  return path.slice(path.lastIndexOf('/') + 1).includes('.');
}

/** Whether this request should be answered with the SPA's index.html. */
export function isSpaRequest(method: string, path: string): boolean {
  // Only navigation. A POST to an unknown path is not a client-side route, and
  // answering it with a page would turn a 404 into a misleading 200.
  if (method !== 'GET' && method !== 'HEAD') return false;

  return !isApiPath(path) && !looksLikeFile(path);
}

/**
 * Mounts the built web app, when there is one.
 *
 * Returns whether it mounted, so the caller can say so in the startup log —
 * an API that silently stopped serving the frontend is worth one line.
 *
 * Absent in development, where Vite serves the app on its own port and proxies
 * `/api` here; this is a no-op then, which is what keeps local behaviour
 * unchanged.
 */
export function serveWebApp(app: NestExpressApplication, root: string): boolean {
  if (!existsSync(join(root, 'index.html'))) return false;

  /*
   * Real files first, and ONLY real files.
   *
   * `index: false` because the fallback below owns index.html: with both
   * enabled, `/` would be served by one and `/leads` by the other, and the two
   * would need identical cache headers forever to avoid a stale shell.
   *
   * `redirect: false` so `/leads` is not 301'd to `/leads/` when a directory of
   * that name happens to exist in the bundle.
   */
  app.useStaticAssets(root, { index: false, redirect: false });

  const indexHtml = join(root, 'index.html');

  app.use((request: Request, response: Response, next: NextFunction) => {
    if (!isSpaRequest(request.method, request.path)) return next();

    /*
     * The shell is never cached.
     *
     * Vite fingerprints every asset it emits, so those are immutable and the
     * static handler above may cache them freely. index.html is the one file
     * that is not fingerprinted — it is what NAMES the current fingerprints —
     * so a cached copy pins a returning browser to a deploy that no longer
     * exists, and the assets it references are gone.
     */
    response.setHeader('Cache-Control', 'no-cache');

    return response.sendFile(indexHtml, (error: unknown) => {
      // Falls through to Nest rather than crashing the request: a missing
      // index.html after the existsSync check above means the bundle was
      // removed underneath a running process, which is a 404, not a 500.
      if (error) next();
    });
  });

  return true;
}

/**
 * Where the built web app lives, relative to the running API.
 *
 * `apps/api/dist/main.js` -> `apps/web/dist` in the image, and
 * `apps/api/src/main.ts` -> the same place from a source run. One expression
 * for both, because a second one would be the one that rots.
 */
export function webDistPath(fromDir: string): string {
  return join(fromDir, '..', '..', 'web', 'dist');
}
