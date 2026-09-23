import { Logger } from '@nestjs/common';
import type { EmailDeliveryResult, EmailMessage, EmailProvider } from '../email.types';

/**
 * Stands in for a transport this build does not have.
 *
 * Reached only outside production, and only when EMAIL_PROVIDER names
 * something unimplemented — production refuses to start instead, because a
 * provider that accepts every message and delivers none is invisible until a
 * customer cannot get back into their account.
 *
 * To add a real provider:
 *
 *   1. implement `EmailProvider` (one method) in this directory;
 *   2. register it in createEmailProvider under a new EMAIL_PROVIDER value;
 *   3. add its configuration to the env schema, required only when selected.
 *
 * Nothing in auth or invitations changes, which is the entire point of the
 * abstraction — see SmtpEmailProvider, which was added exactly that way.
 */
export class UnconfiguredEmailProvider implements EmailProvider {
  readonly name = 'unconfigured';

  private readonly logger = new Logger('Email');

  constructor(private readonly requested: string) {}

  async send(message: EmailMessage): Promise<EmailDeliveryResult> {
    // Fails LOUDLY but does not throw. A failed password-reset email must not
    // turn into a 500 that tells the caller whether the account exists — that
    // is exactly the enumeration oracle the neutral response exists to prevent.
    this.logger.error(
      `EMAIL NOT SENT — provider "${this.requested}" is not implemented. ` +
        `Message "${message.subject}" for ${message.to.email} was dropped.`,
    );

    return { accepted: false };
  }
}
