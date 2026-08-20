import { SetMetadata } from '@nestjs/common';
import type { Permission, RoleKey } from '@leadflow/api-types';

export const PERMISSIONS_KEY = 'leadflow:permissions';
export const ROLES_KEY = 'leadflow:roles';

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
