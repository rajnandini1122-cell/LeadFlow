import { Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES } from '@leadflow/api-types';
import { AppConfig } from '../../../../common/config/config.module';
import { AppException } from '../../../../common/errors/app.exception';
import { AuditRepository } from '../../../../common/audit/audit.repository';
import {
  credentialHint,
  parseEncryptionKey,
  sealSecret,
  SecretBoxError,
} from '../../../../common/crypto/secret-box';
import { MessengerIntegrationRepository } from './messenger-integration.repository';
import type { MessengerChannelConfig } from './messenger-channels';

/**
 * Connecting a tenant's Instagram account or Facebook Page.
 *
 * Same rule as WhatsApp, for the same reason: CONNECTED is written only after
 * the credentials have actually worked against Meta. Accepting a form and
 * calling it connected leaves an owner believing their messages are being
 * captured, and the first they hear otherwise is a customer who never got an
 * answer.
 *
 * Not OAuth, and not pretending to be. Both channels need a token from an app
 * the business has already authorised at Meta; the owner pastes the identifiers
 * and the token. A browser redirect flow here would be theatre around the same
 * two values.
 */
@Injectable()
export class MessengerSetupService {
  private readonly logger = new Logger(MessengerSetupService.name);

  constructor(
    private readonly config: AppConfig,
    private readonly repository: MessengerIntegrationRepository,
    private readonly audit: AuditRepository,
  ) {}

  async connect(
    channel: MessengerChannelConfig,
    input: { accountId: string; linkedAccountId?: string | undefined; accessToken: string },
    actorId: string,
    organizationId: string,
  ) {
    // Refuse before storing anything if the key is unusable, rather than
    // writing a bearer token somewhere it cannot be protected.
    let key: Buffer;
    try {
      key = parseEncryptionKey(this.config.get('CREDENTIAL_ENCRYPTION_KEY'));
    } catch (error) {
      this.logger.error(
        `Cannot connect ${channel.label}: ${
          error instanceof SecretBoxError ? error.message : 'encryption key unavailable'
        }`,
      );
      throw new AppException(
        ERROR_CODES.INTERNAL_ERROR,
        'Credential storage is not configured on this server. Contact your administrator.',
        500,
      );
    }

    if (await this.repository.claimedByAnotherTenant(channel.channel, input.accountId, organizationId)) {
      throw new AppException(
        ERROR_CODES.CONFLICT,
        `That ${channel.label} account is already connected to another LeadFlow organization.`,
        409,
      );
    }

    const integration = await this.repository.upsertForCurrentTenant({
      channel: channel.channel,
      providerAccountId: input.accountId,
      linkedAccountId: input.linkedAccountId ?? null,
      encryptedAccessToken: sealSecret(input.accessToken, key),
      accessTokenHint: credentialHint(input.accessToken),
      actorId,
    });

    await this.audit.record({
      action: `omnichannel.${channel.channel.toLowerCase()}_connect_attempted`,
      entityType: 'channel_integration',
      entityId: integration.id,
      actorUserId: actorId,
      after: {
        accountId: input.accountId,
        linkedAccountId: input.linkedAccountId ?? null,
        // The hint, never the token.
        accessTokenHint: credentialHint(input.accessToken),
      },
    });

    const validation = await this.validate(channel, input.accountId, input.accessToken);

    if (!validation.ok) {
      await this.repository.markError(integration.id, validation.message);
      return { id: integration.id, status: 'ERROR' as const, message: validation.message };
    }

    await this.repository.markConnected(integration.id, validation.displayName);

    await this.audit.record({
      action: `omnichannel.${channel.channel.toLowerCase()}_connected`,
      entityType: 'channel_integration',
      entityId: integration.id,
      actorUserId: actorId,
      after: { accountId: input.accountId, displayName: validation.displayName },
    });

    return { id: integration.id, status: 'CONNECTED' as const, displayName: validation.displayName };
  }

  async disconnect(channel: MessengerChannelConfig, actorId: string) {
    const integration = await this.repository.findForCurrentTenant(channel.channel);
    if (!integration) {
      throw AppException.notFound(
        ERROR_CODES.NOT_FOUND,
        `No ${channel.label} integration is connected.`,
      );
    }

    await this.repository.disconnect(integration.id);

    await this.audit.record({
      action: `omnichannel.${channel.channel.toLowerCase()}_disconnected`,
      entityType: 'channel_integration',
      entityId: integration.id,
      actorUserId: actorId,
    });

    return { id: integration.id, status: 'DISCONNECTED' as const };
  }

  /**
   * Proves the credentials work by reading the account back from Meta.
   *
   * Reading the account node exercises exactly what matters: that the token is
   * valid, unexpired, and actually scoped to THIS account. A token that works
   * for a different Page would otherwise sit there looking healthy until the
   * first real message was misattributed.
   *
   * Every failure is one short non-secret sentence. Meta's error bodies echo
   * request parameters back and are not something to store in a column the
   * settings screen renders.
   */
  private async validate(
    channel: MessengerChannelConfig,
    accountId: string,
    accessToken: string,
  ): Promise<{ ok: true; displayName: string | null } | { ok: false; message: string }> {
    const version = this.config.get('WHATSAPP_API_VERSION');
    const url = `https://graph.facebook.com/${version}/${encodeURIComponent(accountId)}?fields=${channel.validationFields}`;

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          return { ok: false, message: channel.setupErrors.unauthorized };
        }
        if (response.status === 404) {
          return { ok: false, message: channel.setupErrors.notFound };
        }
        return { ok: false, message: `Meta returned an error (HTTP ${response.status}).` };
      }

      const payload = (await response.json()) as Record<string, unknown>;
      const displayName = channel.displayName(payload);

      // A name proves we read the right account, not merely that a call
      // succeeded against some account.
      if (!displayName) return { ok: false, message: channel.setupErrors.noDetails };

      return { ok: true, displayName };
    } catch (error) {
      // Never the URL — it carries the account id — and never the token.
      this.logger.warn(
        `${channel.label} validation call failed: ${
          error instanceof Error ? error.name : 'unknown error'
        }`,
      );
      return { ok: false, message: 'Could not reach Meta to verify the credentials.' };
    }
  }
}
