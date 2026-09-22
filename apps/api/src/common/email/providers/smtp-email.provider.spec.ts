import { Logger } from '@nestjs/common';
import { SmtpEmailProvider, type SmtpSettings } from './smtp-email.provider';
import type { EmailMessage } from '../email.types';

/**
 * SMTP delivery, without an SMTP server.
 *
 * Nothing here talks to a network: the transport factory is a stand-in, which
 * is what lets these cases assert the two things that actually matter — the
 * options the transport is built with, and what does and does not reach the
 * log when a send fails.
 */

const PASSWORD = 'correct-horse-battery-staple';

const settings = (overrides: Partial<SmtpSettings> = {}): SmtpSettings => ({
  host: 'smtp.example.test',
  port: 587,
  secure: false,
  user: 'no-reply@example.test',
  password: PASSWORD,
  from: 'Example <no-reply@example.test>',
  ...overrides,
});

const message = (overrides: Partial<EmailMessage> = {}): EmailMessage => ({
  to: { email: 'recipient@customer.test', name: 'Dana Whitfield' },
  subject: 'Reset your password',
  text: 'Open https://app.example.test/reset-password/SECRET-TOKEN to continue.',
  html: '<p>Open <a href="https://app.example.test/reset-password/SECRET-TOKEN">this link</a>.</p>',
  tag: 'password-reset',
  ...overrides,
});

/** A transporter that records what it was asked to send. */
function fakeTransport(behaviour: {
  send?: (mail: Record<string, unknown>) => Promise<unknown>;
} = {}) {
  const options: Record<string, unknown>[] = [];
  const sent: Record<string, unknown>[] = [];
  let closed = 0;

  const factory = ((transportOptions: Record<string, unknown>) => {
    options.push(transportOptions);

    return {
      sendMail: async (mail: Record<string, unknown>) => {
        sent.push(mail);
        return behaviour.send
          ? behaviour.send(mail)
          : { accepted: [(mail as { to: unknown }).to], rejected: [], messageId: '<abc@example>' };
      },
      close: () => {
        closed += 1;
      },
    };
  }) as never;

  return { factory, options, sent, closed: () => closed };
}

describe('SmtpEmailProvider', () => {
  let errors: unknown[][];
  let warnings: unknown[][];

  beforeEach(() => {
    errors = [];
    warnings = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('the transport it builds', () => {
    it('passes the configured host, port and credentials through', () => {
      const transport = fakeTransport();
      new SmtpEmailProvider(settings(), transport.factory);

      expect(transport.options[0]).toMatchObject({
        host: 'smtp.example.test',
        port: 587,
        auth: { user: 'no-reply@example.test', pass: PASSWORD },
      });
    });

    it('maps SMTP_SECURE=false to an upgraded connection that REQUIRES STARTTLS', () => {
      const transport = fakeTransport();
      new SmtpEmailProvider(settings({ secure: false, port: 587 }), transport.factory);

      // Without requireTLS a server that does not offer STARTTLS would get the
      // password in cleartext, and nothing would look wrong.
      expect(transport.options[0]).toMatchObject({ secure: false, requireTLS: true });
    });

    it('maps SMTP_SECURE=true to implicit TLS', () => {
      const transport = fakeTransport();
      new SmtpEmailProvider(settings({ secure: true, port: 465 }), transport.factory);

      expect(transport.options[0]).toMatchObject({ secure: true, port: 465 });
    });

    it('never disables certificate validation', () => {
      const transport = fakeTransport();
      new SmtpEmailProvider(settings(), transport.factory);

      const tls = transport.options[0]?.['tls'] as Record<string, unknown> | undefined;

      // rejectUnauthorized:false accepts any certificate, which is an open
      // door for anything sitting between here and the mail server.
      expect(tls?.['rejectUnauthorized']).toBeUndefined();
      expect(tls?.['minVersion']).toBe('TLSv1.2');
    });

    it('reuses one pooled transport rather than reconnecting per message', async () => {
      const transport = fakeTransport();
      const provider = new SmtpEmailProvider(settings(), transport.factory);

      await provider.send(message());
      await provider.send(message());

      expect(transport.options).toHaveLength(1);
      expect(transport.options[0]).toMatchObject({ pool: true });
    });

    it('bounds every phase of the conversation', () => {
      // These sends are awaited inside the HTTP request that caused them, so
      // nodemailer's minutes-long defaults would hold a reset request open
      // long past any client's patience.
      const transport = fakeTransport();
      new SmtpEmailProvider(settings(), transport.factory);

      const options = transport.options[0] as Record<string, number>;
      expect(options['connectionTimeout']).toBeLessThanOrEqual(15_000);
      expect(options['greetingTimeout']).toBeLessThanOrEqual(15_000);
      expect(options['socketTimeout']).toBeLessThanOrEqual(30_000);
    });
  });

  describe('sending', () => {
    it('maps the message onto the envelope', async () => {
      const transport = fakeTransport();
      const provider = new SmtpEmailProvider(settings(), transport.factory);

      await provider.send(message());

      expect(transport.sent[0]).toEqual({
        from: 'Example <no-reply@example.test>',
        to: { name: 'Dana Whitfield', address: 'recipient@customer.test' },
        subject: 'Reset your password',
        text: expect.stringContaining('reset-password'),
        html: expect.stringContaining('<a href'),
      });
    });

    it('sends a bare address when the recipient has no display name', async () => {
      const transport = fakeTransport();
      const provider = new SmtpEmailProvider(settings(), transport.factory);

      await provider.send(message({ to: { email: 'plain@customer.test' } }));

      expect(transport.sent[0]?.['to']).toBe('plain@customer.test');
    });

    it('reports acceptance and the provider message id', async () => {
      const transport = fakeTransport();
      const provider = new SmtpEmailProvider(settings(), transport.factory);

      const result = await provider.send(message());

      expect(result).toEqual({ accepted: true, messageId: '<abc@example>' });
      // previewUrl belongs to the console provider alone.
      expect(result.previewUrl).toBeUndefined();
    });

    it('reports a refused recipient as not accepted', async () => {
      const transport = fakeTransport({
        send: async () => ({ accepted: [], rejected: ['recipient@customer.test'], messageId: '<x>' }),
      });
      const provider = new SmtpEmailProvider(settings(), transport.factory);

      // A 250 for nobody is not a delivery, whatever the absence of an
      // exception suggests.
      expect(await provider.send(message())).toMatchObject({ accepted: false });
      expect(warnings).toHaveLength(1);
    });

    it('returns rather than throws when the server refuses', async () => {
      const transport = fakeTransport({
        send: async () => {
          throw Object.assign(new Error('Invalid login: 535 authentication failed'), {
            code: 'EAUTH',
            responseCode: 535,
          });
        },
      });
      const provider = new SmtpEmailProvider(settings(), transport.factory);

      /*
       * The EmailProvider contract: a failure is a result, not an exception.
       * forgot-password answers identically for known and unknown addresses,
       * and a send failure that became a 500 would rebuild that enumeration
       * oracle from the other side.
       */
      await expect(provider.send(message())).resolves.toEqual({ accepted: false });
    });
  });

  describe('what reaches the log', () => {
    const failing = () =>
      fakeTransport({
        send: async () => {
          throw Object.assign(
            new Error(
              `Invalid login: 535 5.7.8 Authentication failed for no-reply@example.test ` +
                `with ${PASSWORD} (AUTH PLAIN AG5vLXJlcGx5QGV4YW1wbGUudGVzdABzZWNyZXQtcGFzc3dvcmQ=)`,
            ),
            { code: 'EAUTH', responseCode: 535 },
          );
        },
      });

    it('never writes the SMTP password', async () => {
      const provider = new SmtpEmailProvider(settings(), failing().factory);
      await provider.send(message());

      expect(JSON.stringify(errors)).not.toContain(PASSWORD);
    });

    it('never writes the credential in its encoded form either', async () => {
      const provider = new SmtpEmailProvider(settings(), failing().factory);
      await provider.send(message());

      // The base64 AUTH payload is the same secret in a different alphabet.
      expect(JSON.stringify(errors)).not.toContain('AG5vLXJlcGx5QGV4YW1wbGUudGVzdA');
    });

    it('never writes the reset token, the link or the body', async () => {
      const provider = new SmtpEmailProvider(settings(), failing().factory);
      await provider.send(message());

      const logged = JSON.stringify(errors);
      expect(logged).not.toContain('SECRET-TOKEN');
      expect(logged).not.toContain('reset-password');
      expect(logged).not.toContain('<a href');
    });

    it('never writes the invitation token', async () => {
      const provider = new SmtpEmailProvider(settings(), failing().factory);
      await provider.send(
        message({
          tag: 'invitation',
          text: 'Join at https://app.example.test/invite/INVITE-TOKEN-VALUE',
          html: '<a href="https://app.example.test/invite/INVITE-TOKEN-VALUE">Join</a>',
        }),
      );

      expect(JSON.stringify(errors)).not.toContain('INVITE-TOKEN-VALUE');
    });

    it('does write what an operator needs to act on', async () => {
      const provider = new SmtpEmailProvider(settings(), failing().factory);
      await provider.send(message());

      const context = errors[0]?.[0] as Record<string, unknown>;
      expect(context['tag']).toBe('password-reset');
      // The domain tells "our relay is down" from "that customer's server is
      // refusing us" without recording who was written to.
      expect(context['recipientDomain']).toBe('customer.test');
      expect(context['smtp']).toMatchObject({ code: 'EAUTH', responseCode: 535 });
    });

    it('does not write the recipient in full', async () => {
      const provider = new SmtpEmailProvider(settings(), failing().factory);
      await provider.send(message());

      expect(JSON.stringify(errors)).not.toContain('recipient@customer.test');
    });
  });

  describe('shutdown', () => {
    it('closes the pooled transport', async () => {
      const transport = fakeTransport();
      const provider = new SmtpEmailProvider(settings(), transport.factory);

      await provider.onModuleDestroy();

      // B2 ended with an hour-long CI hang caused by exactly one unclosed
      // connection, in a suite that runs without forceExit.
      expect(transport.closed()).toBe(1);
    });
  });
});
