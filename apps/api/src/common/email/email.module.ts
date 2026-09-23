import { Global, Logger, Module } from '@nestjs/common';
import { AppConfig } from '../config/config.module';
import { EmailService } from './email.service';
import { EMAIL_PROVIDER, type EmailProvider } from './email.types';
import { ConsoleEmailProvider } from './providers/console-email.provider';
import { SmtpEmailProvider, type SmtpSettings } from './providers/smtp-email.provider';
import { UnconfiguredEmailProvider } from './providers/unconfigured-email.provider';

/**
 * Chooses the transport from configuration.
 *
 * The important rule is the production guard: the console provider only logs,
 * so allowing it in production would mean a deployment with no mail
 * configuration looks healthy while every password reset silently goes
 * nowhere — and live reset links land in log aggregation. Better to refuse to
 * boot.
 */
/**
 * Providers this build can actually deliver with.
 *
 * `console` is development-only and is refused in production below. Adding a
 * real provider means implementing EmailProvider and listing it here — the
 * list is what makes an unsupported value a startup failure rather than a
 * silent one.
 */
export const SUPPORTED_PROVIDERS = ['console', 'smtp'] as const;

/**
 * Reads the SMTP settings, and refuses a half-configured one.
 *
 * The env schema already requires these together when EMAIL_PROVIDER=smtp, so
 * in a real process this check never fires. It stays because the cost of being
 * wrong is asymmetric: a transporter built with an undefined host would
 * construct happily and fail on every message, which is precisely the silent
 * failure the schema exists to prevent.
 */
function smtpSettings(config: AppConfig): SmtpSettings {
  const host = config.get('SMTP_HOST');
  const port = config.get('SMTP_PORT');
  const secure = config.get('SMTP_SECURE');
  const user = config.get('SMTP_USER');
  const password = config.get('SMTP_PASSWORD');

  const missing = Object.entries({ SMTP_HOST: host, SMTP_PORT: port, SMTP_USER: user, SMTP_PASSWORD: password, SMTP_SECURE: secure })
    .filter(([, value]) => value === undefined || value === '')
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `EMAIL_PROVIDER=smtp requires ${missing.join(', ')}. Without them the ` +
        'transport would accept every message and deliver none. See .env.example.',
    );
  }

  return {
    host: host as string,
    port: port as number,
    secure: secure as boolean,
    user: user as string,
    password: password as string,
    from: config.get('EMAIL_FROM'),
  };
}

export function createEmailProvider(config: AppConfig): EmailProvider {
  const requested = config.get('EMAIL_PROVIDER');

  /*
   * The production transport: any standards-compliant SMTP server, chosen
   * entirely by configuration. No vendor lives in this file.
   */
  if (requested === 'smtp') {
    return new SmtpEmailProvider(smtpSettings(config));
  }

  if (requested === 'console') {
    if (config.isProduction) {
      throw new Error(
        'EMAIL_PROVIDER=console is not permitted in production: it only logs, so ' +
          'password reset and invitation emails would never be delivered, and live ' +
          'tokens would be written to logs. Configure a real provider.',
      );
    }
    return new ConsoleEmailProvider();
  }

  /*
   * An unrecognised provider must never reach production.
   *
   * Previously this warned once at boot and returned a provider that accepts
   * every message and delivers none. In production that means password resets
   * and invitations vanish silently — the failure is invisible until a
   * customer cannot get into their own account, and by then nobody connects it
   * to a typo in an environment variable.
   *
   * Refusing to start is the loud, early failure that a deploy pipeline
   * actually catches.
   */
  if (config.isProduction) {
    throw new Error(
      `EMAIL_PROVIDER="${requested}" has no implementation. In production this ` +
        'would accept every message and deliver none, so password resets and ' +
        `invitations would be lost silently. Supported values: ${SUPPORTED_PROVIDERS.join(', ')}.`,
    );
  }

  // Outside production the same configuration is a warning, so a developer can
  // work without a mail account while still being told what is happening.
  new Logger('Email').warn(
    `EMAIL_PROVIDER="${requested}" has no implementation yet — messages will be dropped. ` +
      `Supported values: ${SUPPORTED_PROVIDERS.join(', ')}.`,
  );
  return new UnconfiguredEmailProvider(requested);
}

@Global()
@Module({
  providers: [
    {
      provide: EMAIL_PROVIDER,
      inject: [AppConfig],
      useFactory: createEmailProvider,
    },
    EmailService,
  ],
  exports: [EmailService],
})
export class EmailModule {}
