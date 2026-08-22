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
import { InstagramIntegrationRepository } from './instagram-integration.repository';

/**
 * Connecting a tenant's Instagram professional account.
 *
 * Same rule as WhatsApp, for the same reason: CONNECTED is written only after
 * the credentials have actually worked against Meta. Accepting a form and
 * calling it connected leaves an owner believing their DMs are being captured,
 * and the first they hear otherwise is a customer who never got an answer.
 *
 * Not OAuth, and not pretending to be. Instagram messaging requires a Page
 * access token from an app the business has already authorised at Meta; the
 * owner pastes the identifiers and the token, exactly as for WhatsApp. A
 * browser redirect flow here would be theatre around the same three values.
 */
@Injectable()
export class InstagramSetupService {
  private readonly logger = new Logger(InstagramSetupService.name);

  constructor(
    private readonly config: AppConfig,
    private readonly repository: InstagramIntegrationRepository,
    private readonly audit: AuditRepository,
  ) {}

  async connect(
    input: { instagramAccountId: string; pageId?: string; accessToken: string },
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
        `Cannot connect Instagram: ${
          error instanceof SecretBoxError ? error.message : 'encryption key unavailable'
        }`,
      );
      throw new AppException(
        ERROR_CODES.INTERNAL_ERROR,
        'Credential storage is not configured on this server. Contact your administrator.',
        500,
      );
    }

    if (await this.repository.claimedByAnotherTenant(input.instagramAccountId, organizationId)) {
      throw new AppException(
        ERROR_CODES.CONFLICT,
        'That Instagram account is already connected to another LeadFlow organization.',
        409,
      );
    }

    const integration = await this.repository.upsertForCurrentTenant({
      providerAccountId: input.instagramAccountId,
      pageId: input.pageId ?? null,
      encryptedAccessToken: sealSecret(input.accessToken, key),
      accessTokenHint: credentialHint(input.accessToken),
      actorId,
    });

    await this.audit.record({
      action: 'omnichannel.instagram_connect_attempted',
      entityType: 'channel_integration',
      entityId: integration.id,
      actorUserId: actorId,
      after: {
        instagramAccountId: input.instagramAccountId,
        pageId: input.pageId ?? null,
        // The hint, never the token.
        accessTokenHint: credentialHint(input.accessToken),
      },
    });

    const validation = await this.validate(input.instagramAccountId, input.accessToken);

    if (!validation.ok) {
      await this.repository.markError(integration.id, validation.message);
      return { id: integration.id, status: 'ERROR' as const, message: validation.message };
    }

    await this.repository.markConnected(integration.id, validation.displayName);

    await this.audit.record({
      action: 'omnichannel.instagram_connected',
      entityType: 'channel_integration',
      entityId: integration.id,
      actorUserId: actorId,
      after: {
        instagramAccountId: input.instagramAccountId,
        displayName: validation.displayName,
      },
    });

    return { id: integration.id, status: 'CONNECTED' as const, displayName: validation.displayName };
  }

  async disconnect(actorId: string) {
    const integration = await this.repository.findForCurrentTenant();
    if (!integration) {
      throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'No Instagram integration is connected.');
    }

    await this.repository.disconnect(integration.id);

    await this.audit.record({
      action: 'omnichannel.instagram_disconnected',
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
   * for a different account would otherwise sit there looking healthy until the
   * first real DM failed to be attributed.
   *
   * Every failure is one short non-secret sentence. Meta's error bodies echo
   * request parameters back and are not something to store in a column the
   * settings screen renders.
   */
  private async validate(
    accountId: string,
    accessToken: string,
  ): Promise<{ ok: true; displayName: string | null } | { ok: false; message: string }> {
    const version = this.config.get('WHATSAPP_API_VERSION');
    const url = `https://graph.facebook.com/${version}/${encodeURIComponent(accountId)}?fields=username,name`;

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          return {
            ok: false,
            message:
              'Instagram rejected the access token. Check it has not expired and that the app ' +
              'has instagram_manage_messages permission.',
          };
        }
        if (response.status === 404) {
          return {
            ok: false,
            message:
              'Meta does not recognise that Instagram account id for this token. Check the ' +
              'account is a professional account linked to the connected Facebook Page.',
          };
        }
        return { ok: false, message: `Meta returned an error (HTTP ${response.status}).` };
      }

      const payload = (await response.json()) as { username?: string; name?: string };

      // A username proves we read the right account, not just any account.
      if (!payload.username && !payload.name) {
        return {
          ok: false,
          message: 'Instagram did not return account details for that id. Check the account type.',
        };
      }

      return { ok: true, displayName: payload.username ? `@${payload.username}` : (payload.name ?? null) };
    } catch (error) {
      // Never the URL — it carries the account id — and never the token.
      this.logger.warn(
        `Instagram validation call failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
      return { ok: false, message: 'Could not reach Meta to verify the credentials.' };
    }
  }
}
