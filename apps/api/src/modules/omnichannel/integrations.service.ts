import { Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import { AuditRepository } from '../../common/audit/audit.repository';
import { OmnichannelRepository } from './omnichannel.repository';

/**
 * Channel integrations, as the settings screen sees them.
 *
 * WhatsApp has a real setup flow as of Phase E1; Instagram and Facebook do not,
 * and this service says so rather than pretending otherwise. `connectable` is
 * what the UI reads to decide whether Connect can do anything, so a channel
 * without an implementation can never present a button that goes nowhere.
 *
 * CONNECTED is never written here. It is written by WhatsAppSetupService, and
 * only after the credentials have actually worked against Meta — an owner who
 * believes their number is live stops watching their phone.
 *
 * Nothing in the shape returned here carries a credential. The access token is
 * not selected by the query at all; only its last four characters are, which is
 * enough to answer "is this the token I pasted?" and not enough to use.
 */

/** The channels the product intends to support. */
export const SUPPORTED_CHANNELS = ['WHATSAPP', 'INSTAGRAM', 'FACEBOOK'] as const;
export type SupportedChannel = (typeof SUPPORTED_CHANNELS)[number];

/**
 * Providers with a working implementation.
 *
 * WhatsApp arrived in Phase E1, Instagram in Phase F. Facebook Messenger is
 * still absent, and the settings screen reads this list rather than assuming —
 * so adding one later turns its Connect button on with no other change, and
 * forgetting to add one leaves a button that is honestly disabled rather than
 * broken.
 *
 * Note this says nothing about SENDING. Instagram is inbound only; whether a
 * conversation can be replied to is decided by send-capability.ts, which
 * refuses every channel but WhatsApp.
 */
export const IMPLEMENTED_PROVIDERS: readonly SupportedChannel[] = ['WHATSAPP', 'INSTAGRAM'];

export interface IntegrationView {
  channel: SupportedChannel;
  /** Null when this channel has never been connected. */
  id: string | null;
  status: 'NOT_CONNECTED' | 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
  enabled: boolean;
  displayName: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
  lastActivityAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  connectedBy: { id: string; fullName: string } | null;
  /** Whether a real setup flow exists. The UI must not offer to connect without one. */
  connectable: boolean;
  /** Last four characters of the stored token, or null. Never the token. */
  accessTokenHint: string | null;
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
          accessTokenHint: null,
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
        accessTokenHint: row.accessTokenHint,
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
