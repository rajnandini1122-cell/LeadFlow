import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service';
import type { DevicePlatform } from '../../../generated/prisma/enums';

/**
 * Device registry data access.
 *
 * `UserDevice` is registered in TENANT_SCOPED_MODELS, so every query here is
 * narrowed by the extension and fails closed without context. On top of that,
 * every method takes an explicit `userId` — because tenant scoping alone would
 * let one colleague manage another's phone, and a device token is a credential.
 *
 * Nothing in this file ever returns a token to a caller. The token is selected
 * only where it is about to be handed to a provider.
 */
@Injectable()
export class DevicesRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Registers a device, or refreshes the one already holding this token.
   *
   * An upsert on `(organizationId, token)` rather than an insert. FCM rotates
   * tokens on reinstall and on some upgrades, and a plain insert would leave a
   * dead row behind on every rotation — one the fan-out keeps trying and the
   * provider keeps rejecting, forever.
   *
   * Re-registering also REACTIVATES: a device deactivated because its token
   * went stale is alive again the moment it presents a working one.
   */
  async register(input: {
    userId: string;
    token: string;
    platform: DevicePlatform;
    label?: string | undefined;
  }) {
    const organizationId = this.tenantContext.requireOrganizationId();

    return this.prisma.client.userDevice.upsert({
      where: { organizationId_token: { organizationId, token: input.token } },
      create: {
        organizationId,
        userId: input.userId,
        token: input.token,
        platform: input.platform,
        label: input.label ?? null,
      },
      update: {
        /*
         * The owner is updated too.
         *
         * A shared handset genuinely changes hands — a rep leaves, a colleague
         * takes the phone, logs in and registers. Leaving the old userId would
         * send that person's notifications to whoever now holds the device.
         */
        userId: input.userId,
        platform: input.platform,
        ...(input.label ? { label: input.label } : {}),
        active: true,
        deactivatedAt: null,
        deactivatedReason: null,
        lastSeenAt: new Date(),
      },
      select: {
        id: true,
        platform: true,
        label: true,
        active: true,
        lastSeenAt: true,
        createdAt: true,
      },
    });
  }

  /**
   * This user's devices, for the device list.
   *
   * The token is deliberately NOT selected. There is no legitimate reason for
   * an API response to carry it, and a field that is never selected cannot be
   * accidentally serialised into one.
   */
  async listForUser(userId: string) {
    return this.prisma.client.userDevice.findMany({
      where: { userId },
      select: {
        id: true,
        platform: true,
        provider: true,
        label: true,
        active: true,
        deactivatedReason: true,
        lastSeenAt: true,
        createdAt: true,
      },
      orderBy: [{ active: 'desc' }, { lastSeenAt: 'desc' }],
    });
  }

  /**
   * Active devices for a recipient, WITH tokens — the fan-out query.
   *
   * The one place a token is read. Called from the dispatch path only, already
   * inside tenant context.
   */
  async activeTokensFor(userId: string) {
    return this.prisma.client.userDevice.findMany({
      where: { userId, active: true },
      select: { id: true, token: true, platform: true },
    });
  }

  /**
   * Deactivates one device, on behalf of its owner.
   *
   * Scoped to the caller's own userId as well as the id: without that, any
   * authenticated colleague could silence someone else's phone by guessing an
   * id.
   */
  async deactivateOwn(id: string, userId: string, reason: string): Promise<number> {
    const result = await this.prisma.client.userDevice.updateMany({
      where: { id, userId, active: true },
      data: { active: false, deactivatedAt: new Date(), deactivatedReason: reason },
    });
    return result.count;
  }

  /**
   * Deactivates a device the provider says is dead.
   *
   * Keyed on the TOKEN, because that is what the provider reports back — it
   * does not know our ids. Deactivated rather than deleted, so the registration
   * history survives and a later re-registration is an update.
   */
  async deactivateByToken(token: string, reason: string): Promise<number> {
    const result = await this.prisma.client.userDevice.updateMany({
      where: { token, active: true },
      data: { active: false, deactivatedAt: new Date(), deactivatedReason: reason },
    });
    return result.count;
  }

  /**
   * Deactivates the device belonging to one logout.
   *
   * Deliberately by token, not by user: logging out on a phone must not silence
   * the same person's tablet. That is the §11 decision — a logout ends the
   * device's relationship with this user, and nothing else.
   */
  async deactivateByTokenForUser(token: string, userId: string): Promise<number> {
    const result = await this.prisma.client.userDevice.updateMany({
      where: { token, userId, active: true },
      data: { active: false, deactivatedAt: new Date(), deactivatedReason: 'signed out' },
    });
    return result.count;
  }

  async activeCount(): Promise<number> {
    return this.prisma.client.userDevice.count({ where: { active: true } });
  }
}
