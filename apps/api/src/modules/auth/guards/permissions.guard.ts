import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isPlatformRole, type Permission, type RoleKey } from '@leadflow/api-types';
import { AppException } from '../../../common/errors/app.exception';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service';
import { PERMISSIONS_KEY, ROLES_KEY } from '../decorators/permissions.decorator';
import { PLATFORM_OWNER_KEY } from '../decorators/platform-owner.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Authorization, enforced server-side (spec §5: "Frontend visibility is not a
 * security mechanism").
 *
 * Permissions are checked against the live membership loaded by JwtAuthGuard,
 * not against anything the client sent.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantContext: TenantContextService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const requiredRoles = this.reflector.getAllAndOverride<RoleKey[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const platformOnly = this.reflector.getAllAndOverride<boolean>(PLATFORM_OWNER_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required?.length && !requiredRoles?.length && !platformOnly) return true;

    const principal = this.tenantContext.principal;
    if (!principal) throw AppException.unauthorized();

    /*
     * The platform boundary.
     *
     * Checked HERE, in the guard that is already registered globally, rather
     * than in a separate guard an endpoint has to remember to apply. A
     * platform endpoint that forgot its guard would be an ordinary
     * authenticated endpoint — reachable by any customer's OWNER — and the
     * mistake would be invisible in review because the decorator above it
     * would still read `@PlatformOwner()`.
     *
     * Role AND permission, not either: the role says this is CRAVION, the
     * permission beside it says which capability. A customer OWNER holds no
     * `platform.*` permission and is not PLATFORM_OWNER, so both refuse them.
     *
     * 403 rather than 404. Unlike a tenant-scoped resource, the existence of
     * the platform surface is not a secret worth keeping — it is documented,
     * and pretending otherwise would make a misconfigured CRAVION account
     * indistinguishable from a missing route while somebody debugs it.
     */
    if (platformOnly && !isPlatformRole(principal.role)) {
      throw AppException.forbidden();
    }

    if (requiredRoles?.length && !requiredRoles.includes(principal.role as RoleKey)) {
      throw AppException.forbidden();
    }

    if (required?.length) {
      // ALL listed permissions are required, not any — the stricter reading is
      // the safe default when a decorator lists several.
      const missing = required.filter((p) => !principal.permissions.includes(p));
      if (missing.length > 0) throw AppException.forbidden();
    }

    return true;
  }
}
