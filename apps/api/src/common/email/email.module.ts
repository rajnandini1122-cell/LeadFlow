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

  // A named-but-unimplemented provider fails loudly per message rather than
  // pretending to work. See UnconfiguredEmailProvider for why there is no
  // half-written SMTP client here.
  new Logger('Email').warn(
    `EMAIL_PROVIDER="${requested}" has no implementation yet — messages will be dropped.`,
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
