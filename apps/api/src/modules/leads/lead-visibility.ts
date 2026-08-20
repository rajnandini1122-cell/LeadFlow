import { PERMISSIONS } from '@leadflow/api-types';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';

/**
 * How much of the organization's pipeline a caller may see.
 *
 * Tenant isolation keeps organizations apart. This is the layer INSIDE one
 * organization: a sales rep holds `lead.view.own` and must not read a
 * colleague's leads, while a manager or owner sees the whole team.
 *
 * `OWN` is the default when no broader permission is present — deny by default,
 * so a new role that nobody remembered to grant sees less rather than more.
 */
export type LeadVisibility = 'OWN' | 'TEAM' | 'ALL';

export function resolveLeadVisibility(principal: TenantPrincipal): LeadVisibility {
  if (principal.permissions.includes(PERMISSIONS.LEAD_VIEW_ALL)) return 'ALL';
  if (principal.permissions.includes(PERMISSIONS.LEAD_VIEW_TEAM)) return 'TEAM';
  return 'OWN';
}

/**
 * The `assignedToId` filter implied by a caller's visibility, or undefined for
 * no restriction.
 *
 * TEAM and ALL are currently identical because there is no reporting hierarchy
 * yet — a manager sees every lead in the organization. They are kept as
 * separate values so that introducing manager→rep relationships later is a
 * change here rather than a change at every call site.
 */
export function visibilityFilter(
  principal: TenantPrincipal,
): { assignedToId: string } | undefined {
  const visibility = resolveLeadVisibility(principal);
  return visibility === 'OWN' ? { assignedToId: principal.userId } : undefined;
}
