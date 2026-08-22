import { Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import { AuditRepository } from '../../common/audit/audit.repository';
import { OmnichannelRepository } from './omnichannel.repository';

/**
 * Channel integrations, as the settings screen sees them.
 *
 * No provider is implemented yet, and this service says so rather than
 * pretending otherwise. There is deliberately no `connect` operation: an
 * endpoint that created a CONNECTED row without a real OAuth exchange would be
 * a lie told in the database, and the first person to believe it would be an
 * owner who thinks their WhatsApp number is live and stops checking their
 * phone.
 *
 * What exists is honest bookkeeping — what is on record, whether it is switched
 * on, when it last carried a message, and what went wrong if anything did.
 */

/** The channels the product intends to support. */
export const SUPPORTED_CHANNELS = ['WHATSAPP', 'INSTAGRAM', 'FACEBOOK'] as const;
export type SupportedChannel = (typeof SUPPORTED_CHANNELS)[number];

/**
 * Providers with a working implementation.
 *
 * Empty, and that is the point: the settings screen reads this to decide
 * whether "Connect" can do anything. When the Meta integration lands it is
 * added here, and the UI stops saying "not available yet" without any other
 * change.
 */
export const IMPLEMENTED_PROVIDERS: readonly SupportedChannel[] = [];

export interface IntegrationView {
  channel: SupportedChannel;
  /** Null when this channel has never been connected. */
  id: string | null;
  status: 'NOT_CONNECTED' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
  enabled: boolean;
  displayName: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
  lastActivityAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  connectedBy: { id: string; fullName: string } | null;
  /** False for every channel today. The UI must not offer to connect. */
  connectable: boolean;
}

@Injectable()
export class IntegrationsService {
  constructor(
    private readonly repository: OmnichannelRepository,
    private readonly audit: AuditRepository,
  ) {}

  /**
   * One row per supported channel, connected or not.
   *
   * Built from the supported list rather than from stored rows, so a channel
   * nobody has touched still appears — as NOT_CONNECTED, derived from the
   * absence of a record rather than from a state somebody had to remember to
   * write.
   */
  async list(): Promise<IntegrationView[]> {
    const [rows, lastActivity] = await Promise.all([
      this.repository.listIntegrations(),
      this.repository.lastActivityByChannel(),
    ]);

    const byChannel = new Map(rows.map((row) => [row.channel, row]));

    return SUPPORTED_CHANNELS.map((channel) => {
      const row = byChannel.get(channel);

      if (!row) {
        return {
          channel,
          id: null,
          status: 'NOT_CONNECTED' as const,
          enabled: false,
          displayName: null,
          connectedAt: null,
          disconnectedAt: null,
          // No record means no messages. Nothing is invented here.
          lastActivityAt: null,
          lastErrorAt: null,
          lastErrorMessage: null,
          connectedBy: null,
          connectable: IMPLEMENTED_PROVIDERS.includes(channel),
        };
      }

      return {
        channel,
        id: row.id,
        status: row.status,
        enabled: row.enabled,
        displayName: row.displayName,
        connectedAt: row.connectedAt?.toISOString() ?? null,
        disconnectedAt: row.disconnectedAt?.toISOString() ?? null,
        lastActivityAt: lastActivity[channel] ?? null,
        lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
        lastErrorMessage: row.lastErrorMessage,
        connectedBy: row.connectedBy,
        connectable: IMPLEMENTED_PROVIDERS.includes(channel),
      };
    });
  }

  /**
   * Switch an integration on or off.
   *
   * Affects whether the integration is acted on, and nothing else. Every
   * conversation, message, lead and activity it has ever produced stays exactly
   * where it is — turning a channel off is not a way to delete its history, and
   * an owner who used it as one would be destroying their own records.
   */
  async setEnabled(id: string, enabled: boolean, actorId: string) {
    const integration = await this.repository.findIntegration(id);
    if (!integration) {
      throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Channel integration not found.');
    }

    await this.repository.setIntegrationEnabled(id, enabled);

    await this.audit.record({
      action: enabled ? 'omnichannel.integration_enabled' : 'omnichannel.integration_disabled',
      entityType: 'channel_integration',
      entityId: id,
      actorUserId: actorId,
      before: { enabled: integration.enabled },
      after: { enabled },
    });

    return { id, enabled };
  }
}
