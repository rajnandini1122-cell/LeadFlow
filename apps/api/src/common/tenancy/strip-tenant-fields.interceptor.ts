import {
  Injectable,
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Observable } from 'rxjs';

/**
 * Layer 1 of tenant isolation: make client-supplied tenant identifiers
 * structurally unreachable.
 *
 * Spec §4 and §19: "The frontend or Android application must never be trusted
 * to provide an arbitrary organization_id." Validation alone is not enough —
 * a DTO that simply omits the field still leaves it sitting on `req.body` where
 * a future `...body` spread would pick it up.
 *
 * So the field is deleted before it ever reaches a controller. A client that
 * sends `{ organizationId: "<other org>" }` gets its own organization, not a
 * 400 — the request succeeds, scoped correctly, and the attempt is logged.
 * That behaviour is asserted by the cross-tenant test suite.
 */
@Injectable()
export class StripTenantFieldsInterceptor implements NestInterceptor {
  private readonly logger = new Logger(StripTenantFieldsInterceptor.name);

  /** Every spelling a client might plausibly send. */
  private static readonly FORBIDDEN_KEYS = [
    'organizationId',
    'organization_id',
    'orgId',
    'org_id',
    'tenantId',
    'tenant_id',
  ];

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<Request>();
    const stripped = [
      ...this.strip(request.body as Record<string, unknown> | undefined),
      ...this.stripQuery(request),
      ...this.strip(request.params as Record<string, unknown> | undefined),
    ];

    if (stripped.length > 0) {
      // Not necessarily an attack — more often a client bug — but it is always
      // worth knowing about, so it is logged with the route.
      this.logger.warn(
        `Stripped client-supplied tenant field(s) [${stripped.join(', ')}] from ` +
          `${request.method} ${request.url}`,
      );
    }

    return next.handle();
  }

  /**
   * Express 5 exposes `req.query` as a lazily-evaluated getter on the
   * prototype, so `delete req.query.organizationId` does not persist — the next
   * read re-parses the original query string and the field reappears.
   *
   * Redefining the property as a plain own value is what actually removes it.
   * Without this the field survives all the way to the ValidationPipe, which
   * was exactly the gap the cross-tenant suite caught.
   */
  private stripQuery(request: Request): string[] {
    const current = request.query as Record<string, unknown> | undefined;
    if (!current || typeof current !== 'object') return [];

    const removed: string[] = [];
    const cleaned: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(current)) {
      if (StripTenantFieldsInterceptor.FORBIDDEN_KEYS.includes(key)) removed.push(key);
      else cleaned[key] = value;
    }

    if (removed.length > 0) {
      Object.defineProperty(request, 'query', {
        value: cleaned,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }

    return removed;
  }

  private strip(target: Record<string, unknown> | undefined): string[] {
    if (!target || typeof target !== 'object') return [];

    const removed: string[] = [];
    for (const key of StripTenantFieldsInterceptor.FORBIDDEN_KEYS) {
      if (Object.prototype.hasOwnProperty.call(target, key)) {
        delete target[key];
        removed.push(key);
      }
    }
    return removed;
  }
}
