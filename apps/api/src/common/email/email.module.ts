import { Global, Logger, Module } from '@nestjs/common';
import { AppConfig } from '../config/config.module';
import { EmailService } from './email.service';
import { EMAIL_PROVIDER, type EmailProvider } from './email.types';
import { ConsoleEmailProvider } from './providers/console-email.provider';
import { UnconfiguredEmailProvider } from './providers/smtp-email.provider';

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
export const SUPPORTED_PROVIDERS = ['console'] as const;

export function createEmailProvider(config: AppConfig): EmailProvider {
  const requested = config.get('EMAIL_PROVIDER');

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
