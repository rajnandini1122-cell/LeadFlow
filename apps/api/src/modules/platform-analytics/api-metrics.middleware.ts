import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ApiMetricsCollector } from './api-metrics.collector';

/** Paths recorded as API traffic. Health probes are excluded: they are the platform, not usage. */
function isMeasured(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/**
 * The route TEMPLATE Express matched (/api/v1/leads/:id), never the concrete
 * URL with its ids or query string. An API request no route matched is
 * "(unmatched)" -- one bounded value, however many random paths are probed.
 */
export function routeTemplate(request: Request): string {
  const route = (request as Request & { route?: { path?: unknown } }).route;
  const path = typeof route?.path === 'string' ? route.path : null;
  if (!path) return '(unmatched)';
  const base = request.baseUrl ?? '';
  return `${base}${path}`.replace(/\/{2,}/g, '/');
}

/**
 * Central API instrumentation: method, route template, status, duration,
 * error code and organization -- nothing else. No headers, no tokens, no
 * bodies, no query strings. Observes on `finish`, so it never delays or alters
 * a response, and a failure inside it is swallowed.
 */
@Injectable()
export class ApiMetricsMiddleware implements NestMiddleware {
  constructor(private readonly collector: ApiMetricsCollector) {}

  use(request: Request, response: Response, next: NextFunction): void {
    // originalUrl, not path: inside mounted middleware `path` is relative to the mount.
    const pathname = (request.originalUrl ?? request.url).split('?')[0] ?? '';
    if (!isMeasured(pathname)) return next();
    const started = process.hrtime.bigint();

    response.on('finish', () => {
      try {
        const principal = (request as Request & { principal?: { organizationId?: string } })
          .principal;
        const errorCode = response.locals['errorCode'];
        this.collector.record({
          method: request.method,
          route: routeTemplate(request),
          status: response.statusCode,
          errorCode: typeof errorCode === 'string' ? errorCode : '',
          durationMs: Number(process.hrtime.bigint() - started) / 1e6,
          organizationId: principal?.organizationId,
        });
      } catch {
        // Analytics must never affect the API.
      }
    });
    next();
  }
}
