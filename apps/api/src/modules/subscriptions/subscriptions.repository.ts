import { Injectable } from '@nestjs/common';
import type { BillingInterval, SubscriptionStatus } from '@leadflow/api-types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';

/**
 * Plan and subscription data access.
 *
 * Two different scoping rules live here on purpose:
 *
 *   - `Plan` is a GLOBAL catalogue and is deliberately absent from
 *     TENANT_SCOPED_MODELS. The public pricing page reads it with no tenant
 *     context at all, which scoping would make impossible.
 *   - `Subscription` IS registered there, so every read below is narrowed to
 *     the caller's organization automatically and a foreign id resolves to
 *     nothing rather than to somebody else's billing.
 */
@Injectable()
export class SubscriptionsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private readonly planSelect = {
    id: true,
    code: true,
    name: true,
    tagline: true,
    description: true,
    featured: true,
    currency: true,
    monthlyPrice: true,
    yearlyPrice: true,
    maxUsers: true,
    maxActiveLeads: true,
    features: true,
  } as const;

  // ---------------------------------------------------------------------------
  // Plans — the public catalogue
  // ---------------------------------------------------------------------------

  /** Active plans in display order. No tenant context required. */
  async activePlans() {
    return this.prisma.client.plan.findMany({
      where: { active: true },
      orderBy: { sortOrder: 'asc' },
      select: this.planSelect,
    });
  }

  /**
   * One plan by code.
   *
   * Withdrawn plans are excluded: an organization already on one keeps it, but
   * nobody may newly subscribe to something no longer offered.
   */
  async findActivePlanByCode(code: string) {
    return this.prisma.client.plan.findFirst({
      where: { code, active: true },
      select: this.planSelect,
    });
  }

  // ---------------------------------------------------------------------------
  // Subscriptions — tenant-scoped
  // ---------------------------------------------------------------------------

  /** The caller's own subscription, or null. Scoped by the extension. */
  async findCurrent() {
    return this.prisma.client.subscription.findFirst({
      include: { plan: { select: this.planSelect } },
    });
  }

  /**
   * Creates the subscription for an organization.
   *
   * Takes an explicit organizationId because registration creates the
   * subscription before any request-scoped tenant context exists.
   */
  async create(input: {
    organizationId: string;
    planId: string;
    status: SubscriptionStatus;
    billingInterval: BillingInterval;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    trialEndsAt: Date | null;
    trialStartsAt?: Date | null;
    entitlementDecision?: string;
    decisionReason?: string;
  }) {
    return this.prisma.client.subscription.create({
      data: {
        trialStartsAt: input.trialStartsAt ?? null,
        entitlementDecision: input.entitlementDecision ?? null,
        decisionReason: input.decisionReason ?? null,
        decisionAt: input.entitlementDecision ? new Date() : null,
        decisionBy: input.entitlementDecision ? 'system:registration' : null,
        organizationId: input.organizationId,
        planId: input.planId,
        status: input.status,
        billingInterval: input.billingInterval,
        currentPeriodStart: input.currentPeriodStart,
        currentPeriodEnd: input.currentPeriodEnd,
        trialEndsAt: input.trialEndsAt,
      },
      include: { plan: { select: this.planSelect } },
    });
  }

  /**
   * Applies a change to the caller's own subscription.
   *
   * updateMany rather than update-by-id: it is tenant-scoped by the extension,
   * so a caller cannot reach another organization's row even by supplying its
   * id. Returns the number of rows affected so the service can tell "not
   * found" from "changed nothing".
   */
  /** When the organization was created: the authoritative activation timestamp. */
  async organizationCreatedAt(organizationId: string): Promise<Date | null> {
    const org = await this.prisma.client.organization.findUnique({
      where: { id: organizationId },
      select: { createdAt: true },
    });
    return org?.createdAt ?? null;
  }

  /** True if this person had not claimed a free trial before (one per fingerprint). */
  async claimTrial(fingerprint: string, organizationId: string): Promise<boolean> {
    const result = await this.prisma.client.trialClaim.createMany({
      data: [{ fingerprint, organizationId }],
      skipDuplicates: true,
    });
    return result.count === 1;
  }

  async recordChange(data: {
    organizationId: string;
    action: string;
    reason: string;
    after: Record<string, unknown>;
  }): Promise<void> {
    await this.prisma.client.subscriptionChange.create({
      data: { ...data, actorType: 'system', actorRef: 'registration', before: {}, after: data.after as object },
    });
  }

  async updateCurrent(data: Record<string, unknown>): Promise<number> {
    const result = await this.prisma.client.subscription.updateMany({ where: {}, data });
    return result.count;
  }

  /** Confirms a tenant context is active before a write. */
  requireOrganizationId(): string {
    return this.tenantContext.requireOrganizationId();
  }

  /** Members counted against a plan's user limit, when limits are enforced. */
  async activeMemberCount(): Promise<number> {
    return this.prisma.client.organizationUser.count({ where: { status: 'ACTIVE' } });
  }

  async activeLeadCount(): Promise<number> {
    return this.prisma.client.lead.count({
      where: { deletedAt: null, status: { notIn: ['WON', 'LOST'] } },
    });
  }
}
