import { Injectable, Logger } from '@nestjs/common';
import { type MailboxView, type MailConnectionTestResult } from '@leadflow/api-types';
import { AppConfig } from '../../../common/config/config.module';
import { AppException } from '../../../common/errors/app.exception';
import { AuditRepository } from '../../../common/audit/audit.repository';
import { auditAttribution, type MutationActor } from '../../../common/audit/mutation-actor';
import {
  credentialHint,
  openSecret,
  parseEncryptionKey,
  sealSecret,
  SecretBoxError,
} from '../../../common/crypto/secret-box';
import type { EmailMailbox } from '../../../generated/prisma/client';
import { isAcceptableMailHostname, normalizeMailHostname, MailHostError } from './mail-host';
import {
  resolveMailHost,
  testImap,
  testSmtp,
  type ConnectionDeps,
  type MailAccount,
} from './mail-connection';
import { MailboxRepository } from './mailbox.repository';
import { checkResendKey, checkSendingDomainDns } from './resend-transport';
import type { MailboxSendingDto, SaveMailboxDto, SaveProviderDto } from './dto/mailbox.dto';

export const MAILBOX_AUDIT = {
  SAVED: 'email.mailbox.saved',
  TESTED: 'email.mailbox.tested',
  SENDING_CHANGED: 'email.mailbox.sending_changed',
  PROVIDER_SAVED: 'email.mailbox.provider_saved',
} as const;

/** Fields that decide WHERE and AS WHOM LeadFlow connects. Changing any of them invalidates past tests. */
const CONNECTION_FIELDS = [
  'emailAddress',
  'username',
  'imapHost',
  'imapPort',
  'imapSecurity',
  'smtpHost',
  'smtpPort',
  'smtpSecurity',
] as const;

/**
 * The organization's mailbox.
 *
 * The password is write-only: it is sealed with CREDENTIAL_ENCRYPTION_KEY on the
 * way in and opened only immediately before a connection. No response, log
 * line or audit entry carries it — or any part of it.
 */
@Injectable()
export class MailboxService {
  private readonly logger = new Logger(MailboxService.name);
  private connectionDeps: ConnectionDeps = {};

  constructor(
    private readonly repository: MailboxRepository,
    private readonly audit: AuditRepository,
    private readonly config: AppConfig,
  ) {}

  /** Tests only. */
  useConnectionDeps(deps: ConnectionDeps): void {
    this.connectionDeps = deps;
  }

  get deps(): ConnectionDeps {
    return this.connectionDeps;
  }

  async view(): Promise<MailboxView> {
    return this.toView(await this.find());
  }

  async save(dto: SaveMailboxDto, actor: MutationActor): Promise<MailboxView> {
    const existing = await this.find();
    if (!existing && !dto.password) {
      throw AppException.validation('Enter the mailbox password.');
    }

    const next = {
      emailAddress: dto.emailAddress,
      description: dto.description?.length ? dto.description : null,
      username: dto.username?.length ? dto.username : dto.emailAddress,
      imapHost: normalizeMailHostname(dto.imapHost),
      imapPort: dto.imapPort,
      imapSecurity: dto.imapSecurity,
      smtpHost: normalizeMailHostname(dto.smtpHost),
      smtpPort: dto.smtpPort,
      smtpSecurity: dto.smtpSecurity,
    };
    assertPortMatchesSecurity('IMAP', next.imapPort, next.imapSecurity, 993);
    assertPortMatchesSecurity('SMTP', next.smtpPort, next.smtpSecurity, 465);
    for (const [label, host] of [
      ['IMAP', next.imapHost],
      ['SMTP', next.smtpHost],
    ] as const) {
      if (!isAcceptableMailHostname(host)) {
        throw AppException.validation(
          `${label} hostname must be the mail server’s public name, for example mail.example.com.`,
        );
      }
      try {
        await resolveMailHost(host, this.connectionDeps);
      } catch (error) {
        if (error instanceof MailHostError)
          throw AppException.validation(`${label}: ${error.message}`);
        throw error;
      }
    }

    const changed = CONNECTION_FIELDS.filter((field) => existing?.[field] !== next[field]);
    const passwordChanged = Boolean(dto.password);
    const connectionChanged = !existing || changed.length > 0 || passwordChanged;
    const sealed = dto.password ? sealSecret(dto.password, this.key()) : undefined;
    const now = new Date();

    // Anything that changes where or as whom LeadFlow connects switches the
    // mailbox off and forgets the old test results: it must be re-tested.
    const reset = connectionChanged
      ? {
          enabled: false,
          lastSmtpOkAt: null,
          lastImapOkAt: null,
          lastSmtpError: null,
          lastImapError: null,
        }
      : {};
    // A different inbox is a different UID space.
    const resetSync =
      existing && (existing.imapHost !== next.imapHost || existing.username !== next.username)
        ? { imapUidValidity: null, imapLastUid: null }
        : {};

    if (existing) {
      await this.repository.update(existing.id, {
        ...next,
        ...reset,
        ...resetSync,
        ...(sealed ? { encryptedPassword: sealed, passwordUpdatedAt: now } : {}),
        updatedBy: actorUserId(actor),
      });
    } else {
      await this.repository.create({
        ...next,
        encryptedPassword: sealed!,
        passwordUpdatedAt: now,
        createdBy: actorUserId(actor),
        updatedBy: actorUserId(actor),
      });
    }

    await this.audit.record({
      action: MAILBOX_AUDIT.SAVED,
      entityType: 'EmailMailbox',
      entityId: existing?.id,
      ...auditAttribution(actor),
      before: existing ? pick(existing, changed) : null,
      after: {
        ...pick(next, existing ? changed : [...CONNECTION_FIELDS]),
        ...(passwordChanged ? { password: 'changed' } : {}),
        ...(connectionChanged && existing?.enabled ? { enabled: false } : {}),
      },
    });

    return this.view();
  }

  /**
   * How campaign mail is sent: SMTP through the mailbox, or the Resend HTTPS
   * API. The API key and webhook secret are sealed exactly like the password.
   *
   * Campaigns must not share the platform's transactional key: a bad campaign
   * must never be able to take password resets and invitations down with it.
   */
  async saveProvider(dto: SaveProviderDto, actor: MutationActor): Promise<MailboxView> {
    const mailbox = await this.require();
    const fromAddress = dto.fromAddress ?? mailbox.fromAddress ?? mailbox.emailAddress;
    if (dto.provider === 'RESEND') {
      if (!dto.apiKey && !mailbox.encryptedApiKey) {
        throw AppException.validation('Enter the Resend API key for campaigns.');
      }
      const transactional = this.config.get('RESEND_API_KEY');
      if (dto.apiKey && transactional && dto.apiKey === transactional) {
        throw AppException.validation(
          'Use a separate Resend API key for campaigns, not the one LeadFlow uses for sign-in and invitation emails.',
        );
      }
    }
    const changed =
      dto.provider !== mailbox.sendingProvider ||
      fromAddress !== (mailbox.fromAddress ?? mailbox.emailAddress) ||
      Boolean(dto.apiKey) ||
      Boolean(dto.webhookSecret);
    await this.repository.update(mailbox.id, {
      sendingProvider: dto.provider,
      fromAddress: fromAddress === mailbox.emailAddress ? null : fromAddress,
      ...(dto.apiKey
        ? {
            encryptedApiKey: sealSecret(dto.apiKey, this.key()),
            apiKeyHint: credentialHint(dto.apiKey),
          }
        : {}),
      ...(dto.webhookSecret
        ? {
            encryptedWebhookSecret: sealSecret(dto.webhookSecret, this.key()),
            // Rotation: events signed with the old secret are still accepted for 24 hours.
            encryptedWebhookSecretPrevious: mailbox.encryptedWebhookSecret,
            webhookSecretRotatedAt: mailbox.encryptedWebhookSecret ? new Date() : null,
          }
        : {}),
      ...(dto.apiKey ? { apiKeyAccess: null } : {}),
      // A different way of sending must be proven again before it is used.
      ...(changed
        ? { enabled: false, providerOkAt: null, providerError: null, domainVerifiedAt: null }
        : {}),
      updatedBy: actorUserId(actor),
    });
    await this.audit.record({
      action: MAILBOX_AUDIT.PROVIDER_SAVED,
      entityType: 'EmailMailbox',
      entityId: mailbox.id,
      ...auditAttribution(actor),
      before: {
        provider: mailbox.sendingProvider,
        fromAddress: mailbox.fromAddress ?? mailbox.emailAddress,
      },
      after: {
        provider: dto.provider,
        fromAddress,
        ...(dto.apiKey ? { apiKey: 'changed' } : {}),
        ...(dto.webhookSecret ? { webhookSecret: 'changed' } : {}),
        ...(changed && mailbox.enabled ? { enabled: false } : {}),
      },
    });
    return this.view();
  }

  /**
   * Resend: the key works (checked without sending) and the From domain has
   * the DKIM and return-path records Resend requires, read from public DNS.
   * Both must hold before the mailbox can be switched on.
   */
  async testProvider(actor: MutationActor): Promise<MailConnectionTestResult> {
    const mailbox = await this.require();
    if (mailbox.sendingProvider !== 'RESEND') return this.test('smtp', actor);
    const apiKey = this.resendApiKey(mailbox);
    const from = mailbox.fromAddress ?? mailbox.emailAddress;
    const [key, dns] = await Promise.all([
      checkResendKey(apiKey, from, this.connectionDeps.fetchImpl),
      checkSendingDomainDns(from, this.connectionDeps.dns),
    ]);
    const missing = [
      !dns.dkim && 'DKIM (resend._domainkey.' + dns.domain + ')',
      !dns.returnPathMx && 'return-path MX (send.' + dns.domain + ')',
      !dns.returnPathSpf && 'return-path SPF (send.' + dns.domain + ')',
    ].filter(Boolean);
    const ok = key.ok && dns.ok;
    const message = [
      key.message,
      dns.ok
        ? dns.domain +
          ': DKIM and return-path records found' +
          (dns.dmarc ? '.' : '; no DMARC record.')
        : dns.domain + ': missing ' + missing.join(', ') + '.',
      mailbox.encryptedWebhookSecret
        ? ''
        : 'Add the webhook signing secret so bounces and complaints are recorded.',
    ]
      .filter(Boolean)
      .join(' ');
    const checkedAt = new Date();
    await this.repository.update(mailbox.id, {
      providerCheckAt: checkedAt,
      ...(ok
        ? { providerOkAt: checkedAt, providerError: null }
        : { providerError: message.slice(0, 300) }),
      domainVerifiedAt: dns.ok ? checkedAt : null,
      apiKeyAccess: key.access,
    });
    await this.audit.record({
      action: MAILBOX_AUDIT.TESTED,
      entityType: 'EmailMailbox',
      entityId: mailbox.id,
      ...auditAttribution(actor),
      after: {
        protocol: 'RESEND',
        ok,
        access: key.access,
        dkim: dns.dkim,
        returnPath: dns.returnPathMx && dns.returnPathSpf,
      },
    });
    return { ok, message, checkedAt: checkedAt.toISOString() };
  }

  async test(kind: 'smtp' | 'imap', actor: MutationActor): Promise<MailConnectionTestResult> {
    const mailbox = await this.require();
    const account = this.account(mailbox);
    const result =
      kind === 'smtp'
        ? await testSmtp(account, this.connectionDeps)
        : await testImap(account, this.connectionDeps);
    const checkedAt = new Date();

    await this.repository.update(
      mailbox.id,
      kind === 'smtp'
        ? {
            lastSmtpCheckAt: checkedAt,
            ...(result.ok
              ? { lastSmtpOkAt: checkedAt, lastSmtpError: null }
              : { lastSmtpError: result.message.slice(0, 300) }),
          }
        : {
            lastImapCheckAt: checkedAt,
            ...(result.ok
              ? { lastImapOkAt: checkedAt, lastImapError: null }
              : { lastImapError: result.message.slice(0, 300) }),
          },
    );
    await this.audit.record({
      action: MAILBOX_AUDIT.TESTED,
      entityType: 'EmailMailbox',
      entityId: mailbox.id,
      ...auditAttribution(actor),
      after: { protocol: kind.toUpperCase(), ok: result.ok },
    });
    return { ...result, checkedAt: checkedAt.toISOString() };
  }

  async setSending(dto: MailboxSendingDto, actor: MutationActor): Promise<MailboxView> {
    const mailbox = await this.require();
    const hourlyLimit = dto.hourlyLimit ?? mailbox.hourlyLimit;
    const dailyLimit = dto.dailyLimit ?? mailbox.dailyLimit;
    if (hourlyLimit > dailyLimit) {
      throw AppException.validation('The hourly limit cannot be higher than the daily limit.');
    }
    if (dto.enabled === true) {
      if (!mailbox.lastImapOkAt) {
        throw AppException.validation(
          'Test the IMAP connection (replies) successfully before turning the mailbox on.',
        );
      }
      if (mailbox.sendingProvider === 'SMTP' && !mailbox.lastSmtpOkAt) {
        throw AppException.validation(
          'Test the SMTP connection successfully before turning the mailbox on.',
        );
      }
      if (
        mailbox.sendingProvider === 'RESEND' &&
        (!mailbox.providerOkAt || !mailbox.domainVerifiedAt)
      ) {
        throw AppException.validation(
          'Test Resend successfully (API key and the sending domain’s DKIM and return-path records) before turning the mailbox on.',
        );
      }
    }
    const enabled = dto.enabled ?? mailbox.enabled;
    await this.repository.update(mailbox.id, {
      enabled,
      hourlyLimit,
      dailyLimit,
      updatedBy: actorUserId(actor),
    });
    await this.audit.record({
      action: MAILBOX_AUDIT.SENDING_CHANGED,
      entityType: 'EmailMailbox',
      entityId: mailbox.id,
      ...auditAttribution(actor),
      before: {
        enabled: mailbox.enabled,
        hourlyLimit: mailbox.hourlyLimit,
        dailyLimit: mailbox.dailyLimit,
      },
      after: { enabled, hourlyLimit, dailyLimit },
    });
    return this.view();
  }

  // --- used by the dispatcher and the inbox sync ------------------------------

  /** The decrypted account. Callers must not log, return or persist it. */
  account(mailbox: EmailMailbox): MailAccount {
    let password: string;
    try {
      password = openSecret(mailbox.encryptedPassword, this.key());
    } catch (error) {
      this.logger.error(
        `Mailbox ${mailbox.id}: stored password cannot be decrypted (${(error as Error).name})`,
      );
      throw AppException.validation('The stored mailbox password cannot be read. Enter it again.');
    }
    return {
      username: mailbox.username,
      password,
      smtp: { host: mailbox.smtpHost, port: mailbox.smtpPort, security: mailbox.smtpSecurity },
      imap: { host: mailbox.imapHost, port: mailbox.imapPort, security: mailbox.imapSecurity },
    };
  }

  /** The campaign API key. Callers must not log, return or persist it. */
  resendApiKey(mailbox: EmailMailbox): string {
    if (!mailbox.encryptedApiKey) {
      throw AppException.validation('Enter the Resend API key for campaigns.');
    }
    return openSecret(mailbox.encryptedApiKey, this.key());
  }

  /** The webhook signing secret, or null when none is configured. */
  resendWebhookSecret(mailbox: EmailMailbox): string | null {
    return mailbox.encryptedWebhookSecret
      ? openSecret(mailbox.encryptedWebhookSecret, this.key())
      : null;
  }

  /** The secret before the last rotation, while it is still within its 24-hour overlap. */
  resendPreviousWebhookSecret(mailbox: EmailMailbox, now = new Date()): string | null {
    if (!mailbox.encryptedWebhookSecretPrevious || !mailbox.webhookSecretRotatedAt) return null;
    if (now.getTime() - mailbox.webhookSecretRotatedAt.getTime() > 24 * 3_600_000) return null;
    return openSecret(mailbox.encryptedWebhookSecretPrevious, this.key());
  }

  async find(): Promise<EmailMailbox | null> {
    return this.repository.find();
  }

  async require(): Promise<EmailMailbox> {
    const mailbox = await this.find();
    if (!mailbox) throw AppException.validation('Set up the email account first.');
    return mailbox;
  }

  private key(): Buffer {
    try {
      return parseEncryptionKey(this.config.get('CREDENTIAL_ENCRYPTION_KEY'));
    } catch (error) {
      if (error instanceof SecretBoxError) {
        this.logger.error(
          'CREDENTIAL_ENCRYPTION_KEY is missing or invalid; mailbox passwords cannot be stored',
        );
        throw AppException.validation('Email accounts cannot be connected on this server yet.');
      }
      throw error;
    }
  }

  private toView(mailbox: EmailMailbox | null): MailboxView {
    const platform = {
      sendingEnabled: this.config.get('EMAIL_CAMPAIGNS_SENDING_ENABLED'),
      dispatcherEnabled: this.config.get('EMAIL_DISPATCH_ENABLED'),
    };
    const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);
    if (!mailbox) {
      return {
        configured: false,
        emailAddress: null,
        description: null,
        username: null,
        imapHost: null,
        imapPort: null,
        imapSecurity: null,
        smtpHost: null,
        smtpPort: null,
        smtpSecurity: null,
        passwordSet: false,
        passwordUpdatedAt: null,
        enabled: false,
        hourlyLimit: 50,
        dailyLimit: 300,
        smtp: { checkedAt: null, okAt: null, error: null },
        imap: { checkedAt: null, okAt: null, error: null },
        sync: { at: null, error: null, count: null },
        sendingProvider: 'SMTP',
        fromAddress: null,
        resend: {
          apiKeySet: false,
          apiKeyHint: null,
          webhookSecretSet: false,
          webhookUrl: null,
          domainVerifiedAt: null,
          lastWebhookAt: null,
        },
        provider: { checkedAt: null, okAt: null, error: null },
        platform,
      };
    }
    return {
      configured: true,
      emailAddress: mailbox.emailAddress,
      description: mailbox.description,
      username: mailbox.username,
      imapHost: mailbox.imapHost,
      imapPort: mailbox.imapPort,
      imapSecurity: mailbox.imapSecurity,
      smtpHost: mailbox.smtpHost,
      smtpPort: mailbox.smtpPort,
      smtpSecurity: mailbox.smtpSecurity,
      passwordSet: true,
      passwordUpdatedAt: iso(mailbox.passwordUpdatedAt),
      enabled: mailbox.enabled,
      hourlyLimit: mailbox.hourlyLimit,
      dailyLimit: mailbox.dailyLimit,
      smtp: {
        checkedAt: iso(mailbox.lastSmtpCheckAt),
        okAt: iso(mailbox.lastSmtpOkAt),
        error: mailbox.lastSmtpError,
      },
      imap: {
        checkedAt: iso(mailbox.lastImapCheckAt),
        okAt: iso(mailbox.lastImapOkAt),
        error: mailbox.lastImapError,
      },
      sync: {
        at: iso(mailbox.lastSyncAt),
        error: mailbox.lastSyncError,
        count: mailbox.lastSyncCount,
      },
      sendingProvider: mailbox.sendingProvider,
      fromAddress: mailbox.fromAddress ?? mailbox.emailAddress,
      resend: {
        apiKeySet: Boolean(mailbox.encryptedApiKey),
        apiKeyHint: mailbox.apiKeyHint,
        webhookSecretSet: Boolean(mailbox.encryptedWebhookSecret),
        webhookUrl:
          this.config.get('WEB_BASE_URL').replace(/\/$/, '') +
          '/api/v1/webhooks/email/resend/' +
          mailbox.id,
        domainVerifiedAt: iso(mailbox.domainVerifiedAt),
        lastWebhookAt: iso(mailbox.lastWebhookAt),
      },
      provider: {
        checkedAt: iso(mailbox.providerCheckAt),
        okAt: iso(mailbox.providerOkAt),
        error: mailbox.providerError,
      },
      platform,
    };
  }
}

function assertPortMatchesSecurity(
  label: string,
  port: number,
  security: string,
  implicitPort: number,
): void {
  const implicit = port === implicitPort;
  if ((security === 'SSL_TLS') !== implicit) {
    throw AppException.validation(
      `${label} port ${port} does not match ${security === 'SSL_TLS' ? 'SSL/TLS' : 'STARTTLS'}. Use ${
        security === 'SSL_TLS' ? implicitPort : implicitPort === 993 ? 143 : 587
      }.`,
    );
  }
}

function actorUserId(actor: MutationActor): string | null {
  return actor.kind === 'USER' ? actor.userId : null;
}

function pick<T extends object>(source: T, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, (source as Record<string, unknown>)[key]]));
}
