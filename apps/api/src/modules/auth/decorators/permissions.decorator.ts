import { SetMetadata } from '@nestjs/common';
import type { Permission, RoleKey } from '@idea001/api-types';

export const PERMISSIONS_KEY = 'idea001:permissions';
export const ROLES_KEY = 'idea001:roles';

/**
 * Requires every listed permission.
 *
 * Prefer this over `Roles` — permissions survive the introduction of custom
 * roles, role names do not.
 */
export const RequirePermissions = (...permissions: Permission[]): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** Requires one of the listed roles. Use only where the role itself is the rule. */
export const Roles = (...roles: RoleKey[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
