import { Logger } from '@nestjs/common';
import { EmailService } from './email.service';
import type { AppConfig } from '../config/config.module';
import type { EmailMessage, EmailProvider } from './email.types';

/**
 * What the rest of the application is allowed to learn about delivery.
 *
 * Almost nothing, and that is the design. `forgot-password` answers the same
 * for a known address as for an unknown one; if a provider outage changed the
 * response, the account-enumeration oracle that neutral answer exists to close
 * would simply reopen from the other side.
 */

const config = {
  get: (key: string) =>
    ({
      PRODUCT_NAME: 'LeadFlow',
      WEB_BASE_URL: 'https://app.example.test',
      SALES_EMAIL: 'sales@example.test',
    })[key],
} as unknown as AppConfig;

class RecordingProvider implements EmailProvider {
  readonly name = 'recording';
  readonly sent: EmailMessage[] = [];

  constructor(private readonly outcome: 'accept' | 'throw' = 'accept') {}

  async send(message: EmailMessage) {
    this.sent.push(message);

    if (this.outcome === 'throw') {
      throw Object.assign(new Error('SMTP connection timed out'), { code: 'ETIMEDOUT' });
    }

    return { accepted: true, messageId: '<id@example>' };
  }
}

describe('EmailService', () => {
  let errors: unknown[][];

  beforeEach(() => {
    errors = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
  });

  afterEach(() => jest.restoreAllMocks());

  describe('when the transport fails', () => {
    it('reports the password reset as undelivered instead of throwing', async () => {
      const service = new EmailService(new RecordingProvider('throw'), config);

      /*
       * The caller must be unable to tell a mail outage from an address that
       * has no account: both paths return, neither raises, and the HTTP
       * response is the same either way.
       */
      await expect(
        service.sendPasswordReset({
          to: 'someone@customer.test',
          name: 'Dana',
          token: 'SECRET-RESET-TOKEN',
          expiresInMinutes: 60,
        }),
      ).resolves.toEqual({ accepted: false });
    });

    it('reports an invitation as undelivered instead of throwing', async () => {
      const service = new EmailService(new RecordingProvider('throw'), config);

      // An invitation that could not be emailed is still a real pending
      // invitation an admin can resend; failing the request would leave the
      // UI reporting a failure for a row that exists.
      await expect(
        service.sendInvitation({
          to: 'newcomer@customer.test',
          inviterName: 'Dana',
          organizationName: 'Kestrel',
          role: 'SALES_REP',
          token: 'SECRET-INVITE-TOKEN',
          expiresInDays: 7,
        }),
      ).resolves.toEqual({ accepted: false });
    });

    it('logs neither the token nor the link it appears in', async () => {
      const service = new EmailService(new RecordingProvider('throw'), config);

      await service.sendPasswordReset({
        to: 'someone@customer.test',
        name: 'Dana',
        token: 'SECRET-RESET-TOKEN',
        expiresInMinutes: 60,
      });
      await service.sendInvitation({
        to: 'newcomer@customer.test',
        inviterName: 'Dana',
        organizationName: 'Kestrel',
        role: 'SALES_REP',
        token: 'SECRET-INVITE-TOKEN',
        expiresInDays: 7,
      });

      const logged = JSON.stringify(errors);
      expect(logged).not.toContain('SECRET-RESET-TOKEN');
      expect(logged).not.toContain('SECRET-INVITE-TOKEN');
      expect(logged).not.toContain('reset-password/');
      expect(logged).not.toContain('/invite/');
      // The tag is what an operator needs, and it identifies a KIND of
      // message rather than anybody's credential.
      expect(logged).toContain('password-reset');
    });
  });

  describe('contact enquiries', () => {
    it('always go to the configured sales address', async () => {
      const provider = new RecordingProvider();
      const service = new EmailService(provider, config);

      await service.sendContactEnquiry({
        name: 'Visitor',
        email: 'visitor@somewhere.test',
        message: 'Please call me about pricing.',
        reference: 'A1B2C3D4',
      });

      // The enquirer's own address is CONTENT, never a destination. If a
      // caller could choose where this goes, the public form would be an open
      // relay for mail from this domain.
      expect(provider.sent[0]?.to.email).toBe('sales@example.test');
    });

    it('ignores anything in the payload that looks like a destination', async () => {
      const provider = new RecordingProvider();
      const service = new EmailService(provider, config);

      await service.sendContactEnquiry({
        name: 'Visitor',
        email: 'visitor@somewhere.test',
        company: 'victim@elsewhere.test',
        message: 'to: victim@elsewhere.test',
        reference: 'A1B2C3D4',
      } as Parameters<EmailService['sendContactEnquiry']>[0]);

      expect(provider.sent[0]?.to.email).toBe('sales@example.test');
    });
  });

  it('builds links against the WEB base url, not the API', async () => {
    const provider = new RecordingProvider();
    const service = new EmailService(provider, config);

    await service.sendPasswordReset({
      to: 'someone@customer.test',
      name: 'Dana',
      token: 'abc',
      expiresInMinutes: 60,
    });

    expect(provider.sent[0]?.text).toContain('https://app.example.test/reset-password/abc');
  });
});
