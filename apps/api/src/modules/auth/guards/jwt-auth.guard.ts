import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppException } from '../../../common/errors/app.exception';
import {
  TenantContextService,
  type TenantPrincipal,
} from '../../../common/tenancy/tenant-context.service';
import { TokenService, type AccessTokenClaims } from '../token.service';
import { MembershipCacheService } from '../membership-cache.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

export interface AuthenticatedRequest extends Request {
  claims?: AccessTokenClaims;
  principal?: TenantPrincipal;
}

/**
 * Establishes tenant context for every authenticated request.
 *
 * The order matters and each step exists for a reason:
 *
 *   1. verify the JWT signature   — proves the claims are ours, not forged
 *   2. check the deny list        — makes logout immediate
 *   3. re-load the membership     — a suspended user must not ride out their
 *                                   remaining token lifetime
 *   4. check org and user status  — suspension takes effect now
 *   5. populate CLS               — this is what the Prisma extension reads
 *
 * Step 3 is the one people skip. Without it, `role` and `org` are only as fresh
 * as the token, which is up to 15 minutes stale.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly membershipCache: MembershipCacheService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request);
    if (!token) throw AppException.unauthorized();

    const claims = await this.tokens.verifyAccessToken(token);

    const membership = await this.membershipCache.get(claims.sub, claims.org);

    // No membership at all, or one that has been REMOVED: the token names an
    // organization this user is not in. 401 — the credential itself no longer
    // identifies anyone here.
    if (!membership || membership.membershipStatus === 'REMOVED') {
      throw AppException.unauthorized();
    }

    // Suspended is different from removed: the person is still a member, and
    // 403 tells them (and support) that access was withdrawn rather than that
    // their session broke.
    if (membership.membershipStatus === 'SUSPENDED') throw AppException.accountSuspended();
    if (membership.membershipStatus !== 'ACTIVE') throw AppException.unauthorized();
    if (membership.userStatus === 'SUSPENDED') throw AppException.accountSuspended();
    if (membership.organizationStatus === 'SUSPENDED') throw AppException.organizationSuspended();

    // The role is taken from the LIVE membership, never from the token, so a
    // demotion applies immediately.
    const principal: TenantPrincipal = {
      organizationId: membership.organizationId,
      userId: membership.userId,
      membershipId: membership.membershipId,
      role: membership.role,
      permissions: membership.permissions,
      sessionId: claims.sid,
    };

    // CLS is what the Prisma tenant-scoping extension reads; the request copy
    // is what the @CurrentUser() param decorator reads. Both are set from the
    // same object so they cannot disagree.
    this.tenantContext.setPrincipal(principal);
    request.principal = principal;
    request.claims = claims;

    return true;
  }
}

function extractBearerToken(request: Request): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;

  const [scheme, value] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !value) return undefined;

  return value.trim();
}
