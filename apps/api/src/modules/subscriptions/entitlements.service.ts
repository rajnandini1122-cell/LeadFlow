import { Injectable } from '@nestjs/common';
import {
  customerEntitlement,
  platformInternalEntitlement,
  type EntitlementView,
} from '@leadflow/api-types';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
import { OrganizationTypeRepository } from './organization-type.repository';
import { PLAN_LIMITS_ENFORCED } from './subscriptions.service';
import type { SubscriptionsService } from './subscriptions.service';

/**
 * May this organization use LeadFlow, and should it be shown a bill?
 *
 * ONE place that answers both, so a guard, a controller and a React component
 * cannot answer them differently. Today the answer is only reported — nothing
 * in the product blocks a request on subscription status, and
 * `PLAN_LIMITS_ENFORCED` is false. That is worth stating plainly rather than
 * implying this service bypasses an enforcement that does not exist: what it
 * does is make sure that WHEN enforcement is written, there is already a single
 * function to consult, and it already knows about the platform operator.
 *
 * Two sources, and the distinction is the whole design:
 *
 *   a CUSTOMER organization is entitled by its subscription — trial, active,
 *   past due — exactly as before this file existed;
 *
 *   the INTERNAL organization is entitled because CRAVION operates the
 *   platform. No plan, no period, no payment, and no trial that can expire.
 *
 * The exemption is keyed on `organizations.organization_type`, a column, and
 * applies to the ONE row that may hold INTERNAL — enforced by a partial unique
 * index. It is not a global switch, not an environment flag, and not a name
 * comparison. Customer behaviour is reached by the same code path it always
 * was.
 */
@Injectable()
export class EntitlementsService {
  constructor(
    private readonly organizationTypes: OrganizationTypeRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * The current tenant's entitlement.
   *
   * Takes the subscriptions service as an argument rather than injecting it, to
   * keep the dependency one-directional: the subscriptions service asks this
   * one for an entitlement, so this one must not hold a reference back. A
   * circular provider pair would resolve at runtime and then surprise somebody
   * with an undefined method during a refactor.
   */
  async current(subscriptions: SubscriptionsService): Promise<EntitlementView> {
    if (await this.isPlatformInternal()) {
      /*
       * Returned BEFORE looking for a subscription, deliberately.
       *
       * The internal organization has no subscription row, and it should not:
       * the alternative is a fabricated ACTIVE row with a zero-price plan,
       * which then has to be maintained, appears in every revenue query as a
       * customer, and asserts a payment that never happened.
       */
      return platformInternalEntitlement(PLAN_LIMITS_ENFORCED);
    }

    return customerEntitlement(await subscriptions.current());
  }

  /**
   * Whether the CALLER's organization is CRAVION's own.
   *
   * Read from the database each time rather than cached on the principal or put
   * into the JWT. A token is valid for fifteen minutes, and "is this the
   * platform operator" is the input to a privilege decision — a stale copy of
   * it is a privilege that outlives the change that removed it.
   */
  async isPlatformInternal(): Promise<boolean> {
    const organizationId = this.tenantContext.requireOrganizationId();
    return this.organizationTypes.isInternal(organizationId);
  }
}
