import { Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES } from '@leadflow/api-types';
import { AppConfig } from '../../../../common/config/config.module';
import { AppException } from '../../../../common/errors/app.exception';
import { AuditRepository } from '../../../../common/audit/audit.repository';
import { credentialHint, parseEncryptionKey, sealSecret, SecretBoxError } from '../../../../common/crypto/secret-box';
import { WhatsAppIntegrationRepository } from './whatsapp-integration.repository';

/**
 * Connecting a tenant's WhatsApp Business number.
 *
 * The rule this service exists to enforce: CONNECTED is only ever written after
 * the credentials have been used successfully against Meta. Accepting a form
 * and calling it connected would leave an owner believing their number is live
 * — they would stop watching their phone, and the first they would know is a
 * customer who never got an answer.
 *
 * So the flow is: store as CONNECTING, call Meta, and let the result decide.
 * A failure leaves an honest ERROR with a non-secret explanation rather than a
 * healthy-looking row.
 */
@Injectable()
export class WhatsAppSetupService {
  private readonly logger = new Logger(WhatsAppSetupService.name);

  constructor(
    private readonly config: AppConfig,
    private readonly repository: WhatsAppIntegrationRepository,
    private readonly audit: AuditRepository,
  ) {}

  async connect(
    input: { phoneNumberId: string; businessAccountId?: string; accessToken: string },
    actorId: string,
    organizationId: string,
  ) {
    // Refuse before storing anything if the key is missing or wrong: the
    // alternative is a token written somewhere it cannot be protected.
    let key: Buffer;
    try {
      key = parseEncryptionKey(this.config.get('CREDENTIAL_ENCRYPTION_KEY'));
    } catch (error) {
      this.logger.error(
        `Cannot connect WhatsApp: ${error instanceof SecretBoxError ? error.message : 'encryption key unavailable'}`,
      );
      throw new AppException(
        ERROR_CODES.INTERNAL_ERROR,
        'Credential storage is not configured on this server. Contact your administrator.',
        500,
      );
    }

    /*
     * One phone number, one organization.
     *
     * The database enforces this globally, so this check exists to give a
     * readable conflict instead of a constraint violation — and to say plainly
     * that the number is connected elsewhere without revealing to whom.
     */
    if (await this.repository.claimedByAnotherTenant(input.phoneNumberId, organizationId)) {
      throw new AppException(
        ERROR_CODES.CONFLICT,
        'That WhatsApp phone number is already connected to another LeadFlow organization.',
        409,
      );
    }

    const integration = await this.repository.upsertForCurrentTenant({
      providerAccountId: input.phoneNumberId,
      businessAccountId: input.businessAccountId ?? null,
      displayName: null,
      encryptedAccessToken: sealSecret(input.accessToken, key),
      accessTokenHint: credentialHint(input.accessToken),
      // Not CONNECTED. Nothing has been proven yet.
      status: 'CONNECTING',
      actorId,
    });

    // The audit trail records that a credential was set, never the credential.
    await this.audit.record({
      action: 'omnichannel.whatsapp_connect_attempted',
      entityType: 'channel_integration',
      entityId: integration.id,
      actorUserId: actorId,
      after: {
        phoneNumberId: input.phoneNumberId,
        businessAccountId: input.businessAccountId ?? null,
        accessTokenHint: credentialHint(input.accessToken),
      },
    });

    const validation = await this.validate(input.phoneNumberId, input.accessToken);

    if (!validation.ok) {
      await this.repository.markError(integration.id, validation.message);
      return {
        id: integration.id,
        status: 'ERROR' as const,
        message: validation.message,
      };
    }

    await this.repository.markConnected(integration.id, validation.displayName);

    await this.audit.record({
      action: 'omnichannel.whatsapp_connected',
      entityType: 'channel_integration',
      entityId: integration.id,
      actorUserId: actorId,
      after: { phoneNumberId: input.phoneNumberId, displayName: validation.displayName },
    });

    return {
      id: integration.id,
      status: 'CONNECTED' as const,
      displayName: validation.displayName,
    };
  }

  async disconnect(actorId: string) {
    const integration = await this.repository.findForCurrentTenant();
    if (!integration) {
      throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'No WhatsApp integration is connected.');
    }

    await this.repository.disconnect(integration.id);

    await this.audit.record({
      action: 'omnichannel.whatsapp_disconnected',
      entityType: 'channel_integration',
      entityId: integration.id,
      actorUserId: actorId,
    });

    return { id: integration.id, status: 'DISCONNECTED' as const };
  }

  /**
   * Proves the credentials work by reading the phone number back from Meta.
   *
   * A GET on the phone number node is the cheapest call that exercises exactly
   * what matters: that the token is valid, unexpired, and actually scoped to
   * THIS number. A token that works for a different number would otherwise sit
   * there looking healthy until the first real message failed.
   *
   * Every failure is reported as a short non-secret sentence. Meta's raw error
   * bodies echo request parameters back, which is not something to store in a
   * column the settings screen renders.
   */
  private async validate(
    phoneNumberId: string,
    accessToken: string,
  ): Promise<{ ok: true; displayName: string | null } | { ok: false; message: string }> {
    const version = this.config.get('WHATSAPP_API_VERSION');
    const url = `https://graph.facebook.com/${version}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`;

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        // Mapped to something an administrator can act on. The status is the
        // useful part; the body is not safe to surface.
        if (response.status === 401 || response.status === 403) {
          return { ok: false, message: 'Meta rejected the access token. Check it has not expired.' };
        }
        if (response.status === 404) {
          return {
            ok: false,
            message: 'Meta does not recognise that phone number id for this token.',
          };
        }
        return { ok: false, message: `Meta returned an error (HTTP ${response.status}).` };
      }

      const payload = (await response.json()) as {
        display_phone_number?: string;
        verified_name?: string;
      };

      const displayName =
        payload.verified_name ?? payload.display_phone_number ?? null;

      return { ok: true, displayName };
    } catch (error) {
      // Network failure or timeout. Never the URL — it carries the number id —
      // and never the token.
      this.logger.warn(
        `WhatsApp validation call failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
      return { ok: false, message: 'Could not reach Meta to verify the credentials.' };
    }
  }
}
