import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { AppException } from '../../../common/errors/app.exception';
import type { TenantPrincipal } from '../../../common/tenancy/tenant-context.service';
import type { AuthenticatedRequest } from '../guards/jwt-auth.guard';
import type { AccessTokenClaims } from '../token.service';

/**
 * Injects the server-resolved principal.
 *
 * Controllers take the caller's identity from here and never from a route
 * parameter or request body, which is what makes "user X acting as user Y"
 * unrepresentable.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantPrincipal => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request.principal;
    if (!principal) throw AppException.unauthorized();
    return principal;
  },
);

/** The raw token claims. Needed only by logout, to deny-list the jti. */
export const TokenClaims = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AccessTokenClaims => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.claims) throw AppException.unauthorized();
    return request.claims;
  },
);
