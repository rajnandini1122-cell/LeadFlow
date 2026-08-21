import { Injectable, Logger } from '@nestjs/common';
import type { EmailDeliveryResult, EmailMessage, EmailProvider } from '../email.types';

/**
 * Development provider. Writes the message to the log instead of sending it.
 *
 * This is the default so that a fresh checkout has a working, end-to-end
 * password-reset and invitation flow with no account signup, no API key and no
 * network access. The link is printed where a developer will actually see it.
 *
 * The guard rail that matters: this provider is REFUSED in production by
 * createEmailProvider. Silently logging password reset links on a live system
 * would put live credentials into log aggregation, and a "no email configured"
 * deployment would look like it was working while nobody received anything.
 */
@Injectable()
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console';

  private readonly logger = new Logger('Email');

  async send(message: EmailMessage): Promise<EmailDeliveryResult> {
    // The action link is the only part a developer needs; printing the whole
    // HTML body would bury it.
    const link = extractFirstUrl(message.text);

    this.logger.log(
      [
        '',
        '  ┌─────────────────────────────────────────────────────────────',
        `  │ EMAIL (not sent — console provider)`,
        `  │ to:      ${message.to.email}`,
        `  │ subject: ${message.subject}`,
        `  │ tag:     ${message.tag}`,
        ...(link ? ['  │', `  │ link:    ${link}`] : []),
        '  └─────────────────────────────────────────────────────────────',
        '',
      ].join('\n'),
    );

    return {
      accepted: true,
      messageId: `console-${Date.now()}`,
      ...(link ? { previewUrl: link } : {}),
    };
  }
}

function extractFirstUrl(text: string): string | undefined {
  return /https?:\/\/\S+/.exec(text)?.[0];
}
