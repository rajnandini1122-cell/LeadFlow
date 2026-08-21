import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/config.module';
import { EMAIL_PROVIDER, type EmailDeliveryResult, type EmailProvider } from './email.types';
import { invitationEmail, passwordResetEmail } from './email.templates';

/**
 * The seam between business logic and however mail actually leaves the system.
 *
 * Auth and invitations call these two methods. They never know which provider
 * is configured, never construct HTML, and never learn whether delivery
 * succeeded — because they must not behave differently if it did not.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    @Inject(EMAIL_PROVIDER) private readonly provider: EmailProvider,
    private readonly config: AppConfig,
  ) {}

  get providerName(): string {
    return this.provider.name;
  }

  /**
   * Sends the password reset link.
   *
   * Never throws. A provider outage must not change the response the caller
   * gets, because `forgot-password` deliberately answers identically for known
   * and unknown addresses — surfacing a send failure would reintroduce the
   * enumeration oracle from the other direction.
   */
  async sendPasswordReset(input: {
    to: string;
    name: string;
    token: string;
    expiresInMinutes: number;
  }): Promise<EmailDeliveryResult> {
    const link = this.url(`/reset-password/${input.token}`);

    return this.deliver(
      passwordResetEmail({
        productName: this.config.get('PRODUCT_NAME'),
        name: input.name,
        link,
        expiresInMinutes: input.expiresInMinutes,
        to: input.to,
      }),
    );
  }

  async sendInvitation(input: {
    to: string;
    inviterName: string;
    organizationName: string;
    role: string;
    token: string;
    expiresInDays: number;
  }): Promise<EmailDeliveryResult> {
    const link = this.url(`/invite/${input.token}`);

    return this.deliver(
      invitationEmail({
        productName: this.config.get('PRODUCT_NAME'),
        organizationName: input.organizationName,
        inviterName: input.inviterName,
        role: input.role,
        link,
        expiresInDays: input.expiresInDays,
        to: input.to,
      }),
    );
  }

  private async deliver(
    message: Parameters<EmailProvider['send']>[0],
  ): Promise<EmailDeliveryResult> {
    try {
      return await this.provider.send(message);
    } catch (error) {
      // Logged, never rethrown. See the class comment.
      this.logger.error(
        { tag: message.tag, err: error },
        `Email provider "${this.provider.name}" threw while sending`,
      );
      return { accepted: false };
    }
  }

  /** Links point at the WEB app, not the API. */
  private url(path: string): string {
    return `${this.config.get('WEB_BASE_URL').replace(/\/+$/, '')}${path}`;
  }
}
