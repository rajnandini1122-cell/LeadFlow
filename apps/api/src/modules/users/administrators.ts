import { PERMISSIONS, ROLE_PERMISSION_MATRIX, type RoleKey } from '@leadflow/api-types';

/**
 * Which roles can administer an organization.
 *
 * Derived from the permission matrix rather than hardcoded, so a role added
 * later is classified by what it can actually DO. A list of role names would
 * quietly stop being true the first time someone adds a role.
 *
 * "Administer" means: can change who is in the organization AND can change its
 * configuration. A MANAGER can reassign leads and read reports but cannot
 * invite, remove or reconfigure — losing every OWNER and ADMIN would leave the
 * organization unadministrable even though managers remained.
 */
export const ADMIN_PERMISSIONS = [
  PERMISSIONS.USER_UPDATE,
  PERMISSIONS.USER_INVITE,
  PERMISSIONS.ORG_UPDATE,
] as const;

export function isAdministrativeRole(role: RoleKey): boolean {
  const granted = ROLE_PERMISSION_MATRIX[role];
  if (!granted) return false;
  return ADMIN_PERMISSIONS.every((permission) => granted.includes(permission));
}

/** The administrative roles, computed once at module load. */
export const ADMIN_ROLE_KEYS: RoleKey[] = (
  Object.keys(ROLE_PERMISSION_MATRIX) as RoleKey[]
).filter(isAdministrativeRole);

/**
 * Whether an action removes someone's administrative standing.
 *
 * `nextRole`/`nextStatus` are undefined when unchanged, which is what PATCH
 * semantics mean — the caller is not saying "make it the same", they are not
 * mentioning it at all.
 */
export function losesAdminStanding(
  current: { role: RoleKey; status: string },
  next: { role?: RoleKey | undefined; status?: string | undefined },
): boolean {
  if (!isAdministrativeRole(current.role) || current.status !== 'ACTIVE') return false;

  const roleAfter = next.role ?? current.role;
  const statusAfter = next.status ?? current.status;

  return !isAdministrativeRole(roleAfter) || statusAfter !== 'ACTIVE';
}
