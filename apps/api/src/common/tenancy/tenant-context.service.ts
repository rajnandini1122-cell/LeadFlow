import { Injectable } from '@nestjs/common';
import { ClsService, type ClsStore } from 'nestjs-cls';
import type { AnyRoleKey, Permission } from '@leadflow/api-types';
import { TenantContextMissingError } from './tenancy.errors';

/**
 * The authenticated caller, as resolved by the server.
 *
 * Nothing in here comes from a request body or query string. `organizationId`
 * is read from a server-signed JWT and then re-validated against a live
 * membership record before it lands here.
 */
export interface TenantPrincipal {
  organizationId: string;
  userId: string;
  membershipId: string;
  /**
   * The membership's role, which may be PLATFORM_OWNER.
   *
   * AnyRoleKey rather than RoleKey because this carries whatever the database
   * holds, and PLATFORM_OWNER is a real membership role. The narrower RoleKey
   * stays where a TENANT chooses a role — invitations, role changes — so those
   * still cannot name it.
   */
  role: AnyRoleKey;
  permissions: readonly Permission[];
  sessionId: string;
}

export interface TenantStore extends ClsStore {
  principal?: TenantPrincipal;
  /**
   * Set only inside `runAsSystem()`. Disables automatic tenant scoping, so
   * every use is audit-logged with a stated reason.
   */
  system?: { reason: string };
  /**
   * Set only inside `runForOrganization()`: a real tenant, but no acting user.
   *
   * This is what inbound webhook ingestion runs under. It is deliberately NOT
   * `system` — scoping stays fully ON and pinned to one organization, so a bug
   * in ingestion can still only ever touch the tenant the message belongs to.
   * The difference from `principal` is that there is genuinely nobody to
   * attribute the work to, and inventing a user id would put a fictional actor
   * on real audit rows.
   */
  ingestion?: { organizationId: string; reason: string };
  requestId?: string;
}

export const TENANT_CLS_KEY = 'tenant';

@Injectable()
export class TenantContextService {
  constructor(private readonly cls: ClsService<TenantStore>) {}

  // --- reads ----------------------------------------------------------------

  /** The principal, or undefined for unauthenticated / system / worker calls. */
  get principal(): TenantPrincipal | undefined {
    return this.cls.isActive() ? this.cls.get('principal') : undefined;
  }

  get organizationId(): string | undefined {
    return this.principal?.organizationId ?? this.ingestionOrganizationId;
  }

  /** The tenant fixed by `runForOrganization()`, if that is what we are in. */
  private get ingestionOrganizationId(): string | undefined {
    return this.cls.isActive() ? this.cls.get('ingestion')?.organizationId : undefined;
  }

  get userId(): string | undefined {
    return this.principal?.userId;
  }

  get requestId(): string | undefined {
    return this.cls.isActive() ? this.cls.get('requestId') : undefined;
  }

  get isSystem(): boolean {
    return this.cls.isActive() && this.cls.get('system') !== undefined;
  }

  /**
   * The tenant to scope queries to, or a throw.
   *
   * Fail closed: a missing context must never degrade into an unscoped query
   * that quietly returns every tenant's rows.
   */
  requireOrganizationId(): string {
    const organizationId = this.organizationId;
    if (!organizationId) {
      throw new TenantContextMissingError(
        'No tenant context is active. Authenticated code must run inside a request ' +
          'scope; background jobs must use runWithTenant(); genuinely cross-tenant ' +
          'work must use runAsSystem() with a stated reason.',
      );
    }
    return organizationId;
  }

  requirePrincipal(): TenantPrincipal {
    const principal = this.principal;
    if (!principal) {
      throw new TenantContextMissingError('No authenticated principal is active.');
    }
    return principal;
  }

  hasPermission(permission: Permission): boolean {
    return this.principal?.permissions.includes(permission) ?? false;
  }

  // --- writes ---------------------------------------------------------------

  setPrincipal(principal: TenantPrincipal): void {
    this.cls.set('principal', principal);
  }

  setRequestId(requestId: string): void {
    this.cls.set('requestId', requestId);
  }

  /**
   * Runs `fn` scoped to one organization. This is how background jobs and
   * queue processors obtain a tenant context — they have no HTTP request to
   * derive one from.
   *
   * The `async () => await fn()` wrapper is load-bearing, not decoration.
   *
   * Prisma's query builders return LAZY promises: `prisma.x.findMany(...)`
   * builds a PrismaPromise that does not execute until it is awaited. Passing
   * `() => prisma.x.findMany(...)` straight to `runWith` would therefore return
   * an unstarted promise, the AsyncLocalStorage scope would exit, and the query
   * would finally run with NO tenant context — which the Prisma extension
   * correctly rejects. Awaiting inside the scope forces execution to begin
   * while the context is still active.
   */
  async runWithTenant<T>(principal: TenantPrincipal, fn: () => Promise<T>): Promise<T> {
    return this.cls.runWith({ principal } as TenantStore, async () => await fn());
  }

  /**
   * Escape hatch for genuinely cross-tenant work: super-admin queries, the
   * follow-up sweep that scans every tenant, login itself (which must find a
   * user before any tenant is known).
   *
   * `reason` is required so that every bypass is self-documenting and greppable.
   */
  async runAsSystem<T>(reason: string, fn: () => Promise<T>): Promise<T> {
    // See runWithTenant for why the await must happen inside the scope.
    return this.cls.runWith({ system: { reason } } as TenantStore, async () => await fn());
  }

  /**
   * Run inside one tenant with no acting user — inbound channel ingestion.
   *
   * A webhook arrives with no session, so there is no principal to run under,
   * but it is emphatically NOT cross-tenant work: the message belongs to
   * exactly one organization and must never reach another. So this pins the
   * tenant and leaves scoping switched on, rather than using `runAsSystem()`,
   * which would disable it entirely.
   *
   * `userId` stays undefined here on purpose. Audit rows and lead activities
   * created under this scope record no actor, which is the truth: the system
   * received a message, a person did not do anything.
   */
  async runForOrganization<T>(
    organizationId: string,
    reason: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    // See runWithTenant for why the await must happen inside the scope.
    return this.cls.runWith({ ingestion: { organizationId, reason } } as TenantStore, async () =>
      await fn(),
    );
  }
}
