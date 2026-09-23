import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { TenantContextService } from '../../../../common/tenancy/tenant-context.service';

/**
 * Integration lookups for the WhatsApp adapter.
 *
 * Separate from OmnichannelRepository because one method here is unlike
 * anything else in the module: resolving a webhook to a tenant necessarily
 * happens BEFORE a tenant is known, so it must run outside tenant scope. That
 * is a genuine exception to the fail-closed rule, and it is easier to audit
 * sitting on its own than buried among ordinary scoped queries.
 */
@Injectable()
export class WhatsAppIntegrationRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * The integration that owns a WhatsApp phone number id.
   *
   * Runs as system, because a webhook arrives with no session and no tenant —
   * this lookup is what ESTABLISHES the tenant. It is safe to do so for one
   * reason: `@@unique([channel, providerAccountId])` is global, so a phone
   * number id matches at most one row and there is never a choice to make. If
   * that constraint were per-tenant, this query could return two integrations
   * belonging to different organizations and picking one would be a coin toss.
   *
   * Only the fields needed to make a routing decision are selected. Notably
   * NOT the encrypted access token: nothing on the inbound path needs it, and
   * not loading it is one fewer way for it to end up somewhere it should not.
   */
  async findByPhoneNumberId(phoneNumberId: string) {
    return this.tenantContext.runAsSystem(
      'whatsapp: resolve inbound webhook to its organization',
      () =>
        this.prisma.client.channelIntegration.findFirst({
          where: { channel: 'WHATSAPP', providerAccountId: phoneNumberId },
          select: {
            id: true,
            organizationId: true,
            enabled: true,
            status: true,
          },
        }),
    );
  }

  /** Records that the integration is working. Called only after a verified message. */
  async clearError(id: string): Promise<void> {
    await this.prisma.client.channelIntegration.updateMany({
      where: { id, lastErrorAt: { not: null } },
      data: { lastErrorAt: null, lastErrorMessage: null },
    });
  }

  // --- setup ----------------------------------------------------------------

  /** The tenant's existing WhatsApp integration, if it has one. */
  async findForCurrentTenant() {
    return this.prisma.client.channelIntegration.findFirst({
      where: { channel: 'WHATSAPP' },
    });
  }

  /**
   * Whether another organization has already claimed this phone number id.
   *
   * Checked before writing so the caller gets a clear conflict rather than a
   * unique-constraint violation surfacing as a 500. The constraint is still the
   * real guarantee — this is the readable error in front of it.
   */
  async claimedByAnotherTenant(phoneNumberId: string, organizationId: string): Promise<boolean> {
    const existing = await this.tenantContext.runAsSystem(
      'whatsapp: check a phone number id is not already connected elsewhere',
      () =>
        this.prisma.client.channelIntegration.findFirst({
          where: { channel: 'WHATSAPP', providerAccountId: phoneNumberId },
          select: { organizationId: true },
        }),
    );

    return existing !== null && existing.organizationId !== organizationId;
  }

  async upsertForCurrentTenant(input: {
    providerAccountId: string;
    businessAccountId: string | null;
    displayName: string | null;
    encryptedAccessToken: string;
    accessTokenHint: string;
    status: 'CONNECTING' | 'CONNECTED' | 'ERROR';
    actorId: string;
  }) {
    const organizationId = this.tenantContext.requireOrganizationId();
    const existing = await this.findForCurrentTenant();

    const data = {
      providerAccountId: input.providerAccountId,
      businessAccountId: input.businessAccountId,
      displayName: input.displayName,
      encryptedAccessToken: input.encryptedAccessToken,
      accessTokenHint: input.accessTokenHint,
      status: input.status,
      enabled: true,
      connectedById: input.actorId,
      connectedAt: new Date(),
      disconnectedAt: null,
      lastErrorAt: null,
      lastErrorMessage: null,
    };

    if (existing) {
      return this.prisma.client.channelIntegration.update({
        where: { id: existing.id },
        data,
      });
    }

    return this.prisma.client.channelIntegration.create({
      data: { organizationId, channel: 'WHATSAPP', ...data },
    });
  }

  async markError(id: string, message: string): Promise<void> {
    await this.prisma.client.channelIntegration.update({
      where: { id },
      data: { status: 'ERROR', lastErrorAt: new Date(), lastErrorMessage: message },
    });
  }

  async markConnected(id: string, displayName: string | null): Promise<void> {
    await this.prisma.client.channelIntegration.update({
      where: { id },
      data: {
        status: 'CONNECTED',
        ...(displayName ? { displayName } : {}),
        lastErrorAt: null,
        lastErrorMessage: null,
      },
    });
  }

  /**
   * Disconnect, keeping the record.
   *
   * The credential is cleared — a disconnected integration has no business
   * holding a live bearer token — but the row, and every conversation and
   * message it produced, stay exactly where they are.
   */
  async disconnect(id: string): Promise<void> {
    await this.prisma.client.channelIntegration.update({
      where: { id },
      data: {
        status: 'DISCONNECTED',
        enabled: false,
        disconnectedAt: new Date(),
        encryptedAccessToken: null,
        accessTokenHint: null,
      },
    });
  }
}
