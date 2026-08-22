import { Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES } from '@leadflow/api-types';
import { AppConfig } from '../../../../common/config/config.module';
import { AppException } from '../../../../common/errors/app.exception';
import { AuditRepository } from '../../../../common/audit/audit.repository';
import { openSecret, parseEncryptionKey } from '../../../../common/crypto/secret-box';
import { OmnichannelRepository } from '../../omnichannel.repository';
import { WhatsAppTemplateRepository } from './whatsapp-template.repository';
import { parseTemplateList, readStoredComponents } from './whatsapp-template';

/**
 * Reading a tenant's WhatsApp templates back from Meta.
 *
 * LeadFlow discovers templates; it does not create or approve them. Meta is the
 * only authority on whether a template may be sent, so nothing here ever writes
 * an approval — `status` is whatever Meta last said, and an unrecognised value
 * becomes DISABLED rather than being assumed good.
 *
 * Sync is explicit. Fetching on every conversation open would put a provider
 * call behind a screen people use constantly, and would take the feature down
 * whenever Meta was slow.
 */
@Injectable()
export class WhatsAppTemplateService {
  private readonly logger = new Logger(WhatsAppTemplateService.name);

  constructor(
    private readonly config: AppConfig,
    private readonly integrations: OmnichannelRepository,
    private readonly templates: WhatsAppTemplateRepository,
    private readonly audit: AuditRepository,
  ) {}

  /** The cached list. No provider call. */
  async list() {
    const [rows, integration] = await Promise.all([
      this.templates.list(),
      this.integrations.findIntegrationForChannel('WHATSAPP'),
    ]);

    return {
      // Deliberately no credential and no account id. The sections are read
      // into named fields rather than handed over as a raw provider blob, so
      // the client renders a preview without having to parse Meta's shapes.
      items: rows.map((row) => {
        const sections = readStoredComponents(row.components);

        return {
          name: row.name,
          language: row.language,
          category: row.category,
          // Meta's answer, passed through unchanged.
          status: row.status,
          supported: row.supported,
          unsupportedReason: row.unsupportedReason,
          headerText: sections.header?.text ?? null,
          bodyText: sections.body?.text ?? null,
          footerText: sections.footer,
          buttons: sections.buttons,
          headerParameterCount: row.headerParameterCount,
          bodyParameterCount: row.bodyParameterCount,
          syncedAt: row.syncedAt.toISOString(),
        };
      }),
      connected: integration?.status === 'CONNECTED' && integration.enabled,
    };
  }

  /**
   * Re-reads the template list from Meta and replaces the cache.
   *
   * Requires the WhatsApp Business Account id, which is what Meta lists
   * templates against. It is optional at connect time — inbound and outbound
   * text never needed it — so a tenant that omitted it gets a clear instruction
   * rather than a confusing provider error.
   */
  async sync(actorId: string) {
    const integration = await this.integrations.findIntegrationForChannel('WHATSAPP');

    if (!integration || integration.status !== 'CONNECTED') {
      throw new AppException(
        ERROR_CODES.CONFLICT,
        'Connect WhatsApp before loading templates.',
        409,
      );
    }

    const full = await this.integrations.findIntegration(integration.id);

    if (!full?.businessAccountId) {
      throw new AppException(
        ERROR_CODES.CONFLICT,
        'Add your WhatsApp Business Account ID in settings before loading templates.',
        409,
      );
    }

    if (!integration.encryptedAccessToken) {
      throw new AppException(
        ERROR_CODES.CONFLICT,
        'WhatsApp needs reconnecting in settings.',
        409,
      );
    }

    let accessToken: string;
    try {
      const key = parseEncryptionKey(this.config.get('CREDENTIAL_ENCRYPTION_KEY'));
      accessToken = openSecret(integration.encryptedAccessToken, key);
    } catch {
      this.logger.error('Stored WhatsApp credential could not be decrypted for template sync.');
      throw new AppException(
        ERROR_CODES.CONFLICT,
        'Credentials could not be read. Reconnect the channel in settings.',
        409,
      );
    }

    const version = this.config.get('WHATSAPP_API_VERSION');
    const url =
      `https://graph.facebook.com/${version}/${encodeURIComponent(full.businessAccountId)}` +
      `/message_templates?limit=200`;

    let payload: unknown;
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(20_000),
      });

      if (!response.ok) {
        // Status only. Meta's bodies echo request parameters and can carry
        // the token.
        this.logger.warn(`WhatsApp template sync rejected: HTTP ${response.status}.`);

        throw new AppException(
          ERROR_CODES.CONFLICT,
          response.status === 401 || response.status === 403
            ? 'Meta rejected the credentials. Check the token has whatsapp_business_management permission.'
            : `Meta returned an error (HTTP ${response.status}).`,
          409,
        );
      }

      payload = await response.json();
    } catch (error) {
      if (error instanceof AppException) throw error;

      this.logger.warn(
        `WhatsApp template sync failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
      throw new AppException(
        ERROR_CODES.CONFLICT,
        'Could not reach Meta to load templates. Please try again.',
        409,
      );
    }

    const parsed = parseTemplateList(payload);
    await this.templates.replaceAll(integration.id, parsed);
    await this.templates.markSynced(integration.id);

    await this.audit.record({
      action: 'omnichannel.whatsapp_templates_synced',
      entityType: 'channel_integration',
      entityId: integration.id,
      actorUserId: actorId,
      after: {
        total: parsed.length,
        // Counted rather than listed: how many are usable is the operational
        // fact, and template names are not audit material.
        supported: parsed.filter((template) => template.supported).length,
        approved: parsed.filter((template) => template.status === 'APPROVED').length,
      },
    });

    return {
      total: parsed.length,
      supported: parsed.filter((template) => template.supported).length,
      approved: parsed.filter(
        (template) => template.status === 'APPROVED' && template.supported,
      ).length,
    };
  }

  /** Whether this tenant has anything it could actually send. */
  async hasSendableTemplate(): Promise<boolean> {
    return this.templates.hasSendable();
  }
}
