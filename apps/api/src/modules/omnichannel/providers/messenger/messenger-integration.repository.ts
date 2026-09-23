import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { TenantContextService } from '../../../../common/tenancy/tenant-context.service';
import type { ChannelType } from '../../../../generated/prisma/enums';

/**
 * Integration lookups for the Messenger-protocol channels.
 *
 * Shared by Instagram and Facebook because the queries differ only in a channel
 * constant. WhatsApp keeps its own, since its inbound path also has to reason
 * about outbound credentials this one never loads.
 *
 * One method here runs OUTSIDE tenant scope, and that is deliberately called
 * out below rather than buried — it is the exception a reviewer needs to see.
 */
@Injectable()
export class MessengerIntegrationRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * The integration that owns a provider account.
   *
   * Runs as system because a webhook arrives with no session and no tenant —
   * this lookup is what ESTABLISHES the tenant. Safe for exactly one reason:
   * `@@unique([channel, providerAccountId])` is global, so a Page id or an
   * Instagram account id matches at most one row and there is never a choice
   * to make. Were that constraint per-tenant, this query could return two
   * integrations in different organizations and picking one would be a guess.
   *
   * The encrypted token is deliberately not selected. Nothing on the inbound
   * path needs it, and a credential never loaded cannot leak.
   */
  async findByAccountId(channel: ChannelType, accountId: string) {
    return this.tenantContext.runAsSystem(
      `${channel.toLowerCase()}: resolve inbound webhook to its organization`,
      () =>
        this.prisma.client.channelIntegration.findFirst({
          where: { channel, providerAccountId: accountId },
          select: { id: true, organizationId: true, enabled: true, status: true },
        }),
    );
  }

  async findForCurrentTenant(channel: ChannelType) {
    return this.prisma.client.channelIntegration.findFirst({ where: { channel } });
  }

  /**
   * Whether another organization already connected this account.
   *
   * Checked before writing so the caller gets a readable conflict rather than
   * a unique-constraint violation surfacing as a 500. The constraint remains
   * the real guarantee; this is the readable error in front of it.
   */
  async claimedByAnotherTenant(
    channel: ChannelType,
    accountId: string,
    organizationId: string,
  ): Promise<boolean> {
    const existing = await this.tenantContext.runAsSystem(
      `${channel.toLowerCase()}: check an account is not already connected elsewhere`,
      () =>
        this.prisma.client.channelIntegration.findFirst({
          where: { channel, providerAccountId: accountId },
          select: { organizationId: true },
        }),
    );

    return existing !== null && existing.organizationId !== organizationId;
  }

  async upsertForCurrentTenant(input: {
    channel: ChannelType;
    providerAccountId: string;
    /** The linked Page id for Instagram; unused for Facebook, where the Page IS the account. */
    linkedAccountId: string | null;
    encryptedAccessToken: string;
    accessTokenHint: string;
    actorId: string;
  }) {
    const organizationId = this.tenantContext.requireOrganizationId();
    const existing = await this.findForCurrentTenant(input.channel);

    const data = {
      providerAccountId: input.providerAccountId,
      businessAccountId: input.linkedAccountId,
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
      data: { organizationId, channel: input.channel, ...data },
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
