import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { TenantContextService } from '../../../../common/tenancy/tenant-context.service';

/**
 * Integration lookups for the Instagram adapter.
 *
 * Deliberately a sibling of WhatsAppIntegrationRepository rather than a shared
 * base class. The two are structurally similar today and there is a real
 * temptation to fold them together — but the one method that matters here runs
 * OUTSIDE tenant scope, and a shared abstraction is exactly where that
 * exception would stop being visible to whoever reviews it next.
 */
@Injectable()
export class InstagramIntegrationRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * The integration that owns an Instagram business account id.
   *
   * Runs as system because a webhook arrives with no session and no tenant —
   * this lookup is what ESTABLISHES the tenant. Safe for exactly one reason:
   * `@@unique([channel, providerAccountId])` is global, so an account id
   * matches at most one row and there is never a choice to make.
   *
   * The encrypted token is deliberately not selected. Nothing on the inbound
   * path needs it, and a credential that is never loaded cannot leak.
   */
  async findByAccountId(instagramAccountId: string) {
    return this.tenantContext.runAsSystem(
      'instagram: resolve inbound webhook to its organization',
      () =>
        this.prisma.client.channelIntegration.findFirst({
          where: { channel: 'INSTAGRAM', providerAccountId: instagramAccountId },
          select: { id: true, organizationId: true, enabled: true, status: true },
        }),
    );
  }

  async findForCurrentTenant() {
    return this.prisma.client.channelIntegration.findFirst({ where: { channel: 'INSTAGRAM' } });
  }

  /**
   * Whether another organization already connected this account.
   *
   * Checked before writing so the caller gets a readable conflict instead of a
   * unique-constraint violation surfacing as a 500. The constraint remains the
   * real guarantee.
   */
  async claimedByAnotherTenant(accountId: string, organizationId: string): Promise<boolean> {
    const existing = await this.tenantContext.runAsSystem(
      'instagram: check an account is not already connected elsewhere',
      () =>
        this.prisma.client.channelIntegration.findFirst({
          where: { channel: 'INSTAGRAM', providerAccountId: accountId },
          select: { organizationId: true },
        }),
    );

    return existing !== null && existing.organizationId !== organizationId;
  }

  async upsertForCurrentTenant(input: {
    providerAccountId: string;
    /** The linked Facebook Page id, which Instagram messaging requires. */
    pageId: string | null;
    encryptedAccessToken: string;
    accessTokenHint: string;
    actorId: string;
  }) {
    const organizationId = this.tenantContext.requireOrganizationId();
    const existing = await this.findForCurrentTenant();

    const data = {
      providerAccountId: input.providerAccountId,
      businessAccountId: input.pageId,
      displayName: null,
      encryptedAccessToken: input.encryptedAccessToken,
      accessTokenHint: input.accessTokenHint,
      // Never CONNECTED here. Nothing has been proven yet.
      status: 'CONNECTING' as const,
      enabled: true,
      connectedById: input.actorId,
      connectedAt: new Date(),
      disconnectedAt: null,
      lastErrorAt: null,
      lastErrorMessage: null,
    };

    if (existing) {
      return this.prisma.client.channelIntegration.update({ where: { id: existing.id }, data });
    }

    return this.prisma.client.channelIntegration.create({
      data: { organizationId, channel: 'INSTAGRAM', ...data },
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

  async markError(id: string, message: string): Promise<void> {
    await this.prisma.client.channelIntegration.update({
      where: { id },
      data: { status: 'ERROR', lastErrorAt: new Date(), lastErrorMessage: message },
    });
  }

  /**
   * Disconnect, keeping the record.
   *
   * The credential is cleared — a disconnected integration has no business
   * holding a live token — but the row, and every conversation and message it
   * produced, stay exactly where they are.
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

  async clearError(id: string): Promise<void> {
    await this.prisma.client.channelIntegration.updateMany({
      where: { id, lastErrorAt: { not: null } },
      data: { lastErrorAt: null, lastErrorMessage: null },
    });
  }
}
