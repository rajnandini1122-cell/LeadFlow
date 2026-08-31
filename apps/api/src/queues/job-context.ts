import type { Permission, RoleKey } from '@leadflow/api-types';
import type { TenantPrincipal } from '../common/tenancy/tenant-context.service';

/**
 * The identity a background job runs as.
 *
 * A job has no request, therefore no logged-in user, therefore no principal —
 * and the tenant-scoping extension fails closed without one. There are exactly
 * two ways out of that, and only one of them is safe.
 *
 * The unsafe one is `runAsSystem()`, which disables tenant scoping entirely.
 * It is the obvious shortcut and it is how a background job leaks one tenant's
 * data into another's: a single missing `where` clause in a processor becomes a
 * cross-tenant read with nothing to catch it.
 *
 * The safe one is this. Every job carries an `organizationId` on its payload,
 * and the processor enters `runWithTenant()` with a SYNTHETIC principal scoped
 * to exactly that organization. The extension then narrows every query in the
 * job the same way it narrows every query in an HTTP request — same mechanism,
 * same fail-closed behaviour, no exception to reason about.
 *
 * The principal is deliberately minimal:
 *
 *   - `userId` is the organization id, not a real person. A job is not acting
 *     on anyone's behalf, and borrowing a real user's id would attribute
 *     automated writes to someone who did not make them.
 *   - permissions are EMPTY. A processor that tries to take a permission-gated
 *     path is refused rather than silently allowed, which is what forces
 *     workers to call repositories directly instead of reusing HTTP-facing
 *     services that assume a human caller.
 */
export function jobPrincipal(organizationId: string): TenantPrincipal {
  return {
    organizationId,
    /*
     * Not a real user. Writes made by a job should be attributable to the
     * system, and a UUID-shaped value is required by the columns that record
     * an actor — the organization's own id is the honest choice, because it
     * says "this organization's automation did it" rather than naming someone
     * who was asleep at the time.
     */
    userId: organizationId,
    membershipId: organizationId,
    role: 'OWNER' as RoleKey,
    /*
     * Empty on purpose.
     *
     * A worker must not be able to walk into a permission-gated service path
     * and have it succeed because the job "is an owner". Nothing in a
     * background job should depend on a permission check passing — if a
     * processor needs data, it goes to a repository, where the tenant
     * extension is the only gate that matters.
     */
    permissions: [] as readonly Permission[],
    sessionId: organizationId,
  };
}

/**
 * The shape every job payload must have.
 *
 * `organizationId` is mandatory and is what the processor enters tenant context
 * with. A job without it cannot be processed safely and is rejected rather than
 * run with scoping disabled.
 */
export interface TenantJob {
  organizationId: string;
}

/** Rejects a payload that could only be processed by disabling tenant scoping. */
export function requireTenantJob<T extends Partial<TenantJob>>(
  payload: T,
): asserts payload is T & TenantJob {
  if (!payload.organizationId || typeof payload.organizationId !== 'string') {
    throw new Error(
      'Job payload has no organizationId. A background job cannot run without ' +
        'tenant context — refusing rather than falling back to system scope.',
    );
  }
}

/**
 * A deterministic BullMQ job id.
 *
 * BullMQ deduplicates on job id, so a scheduler that fires twice enqueues once.
 * This is the FIRST of two independent idempotency layers; the second is the
 * unique dedupe key on the notification row itself. Either alone would be
 * adequate most of the time. Both together mean a duplicate needs the scheduler
 * to double-fire AND the constraint to be missing, which is the level of
 * paranoia a reminder system deserves — a CRM that double-notifies is one
 * people mute.
 */
export function deterministicJobId(parts: (string | number)[]): string {
  return parts.join(':');
}
