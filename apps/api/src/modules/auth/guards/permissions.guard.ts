import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission, RoleKey } from '@leadflow/api-types';
import { AppException } from '../../../common/errors/app.exception';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service';
import { PERMISSIONS_KEY, ROLES_KEY } from '../decorators/permissions.decorator';
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

    if (!required?.length && !requiredRoles?.length) return true;

    const principal = this.tenantContext.principal;
    if (!principal) throw AppException.unauthorized();

    if (requiredRoles?.length && !requiredRoles.includes(principal.role)) {
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
