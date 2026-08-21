import { Logger } from '@nestjs/common';
import type { EmailDeliveryResult, EmailMessage, EmailProvider } from '../email.types';

/**
 * Placeholder for a real transport.
 *
 * Deliberately NOT implemented, and deliberately loud about it.
 *
 * The alternative — a half-written SMTP client, or an SDK dependency added
 * "ready for later" — is worse than nothing: it looks like a working feature,
 * it carries a supply-chain cost for code nobody runs, and the first person to
 * deploy discovers the gap in production.
 *
 * To add a real provider:
 *
 *   1. implement `EmailProvider` (one method) in this directory;
 *   2. register it in createEmailProvider under a new EMAIL_PROVIDER value;
 *   3. add its credentials to the env schema.
 *
 * Nothing in auth or invitations changes, which is the entire point of the
 * abstraction.
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
