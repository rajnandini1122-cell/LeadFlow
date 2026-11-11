import { Injectable, Logger } from '@nestjs/common';
import { type MailboxView, type MailConnectionTestResult } from '@leadflow/api-types';
import { AppConfig } from '../../../common/config/config.module';
import { AppException } from '../../../common/errors/app.exception';
import { AuditRepository } from '../../../common/audit/audit.repository';
import { auditAttribution, type MutationActor } from '../../../common/audit/mutation-actor';
import {
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
import type { MailboxSendingDto, SaveMailboxDto } from './dto/mailbox.dto';

export const MAILBOX_AUDIT = {
  SAVED: 'email.mailbox.saved',
  TESTED: 'email.mailbox.tested',
  SENDING_CHANGED: 'email.mailbox.sending_changed',
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
    if (dto.enabled === true && (!mailbox.lastSmtpOkAt || !mailbox.lastImapOkAt)) {
      throw AppException.validation(
        'Test both the SMTP and the IMAP connection successfully before turning the mailbox on.',
      );
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
