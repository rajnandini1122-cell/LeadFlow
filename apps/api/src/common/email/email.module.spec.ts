import { SUPPORTED_PROVIDERS, createEmailProvider } from './email.module';
import { SmtpEmailProvider } from './providers/smtp-email.provider';
import type { AppConfig } from '../config/config.module';

/**
 * Production must refuse to start on a mail configuration that would lose
 * messages.
 *
 * Every failure guarded here is silent in the worst possible way: the
 * application boots, every send is accepted, and nothing is delivered. Nobody
 * notices until a customer cannot reset their password, and by then the cause —
 * a typo in an environment variable weeks earlier — is not the first thing
 * anyone suspects.
 */
function fakeConfig(values: Record<string, unknown> & { NODE_ENV: string }): AppConfig {
  return {
    get: (key: string) => values[key],
    get isProduction() {
      return values.NODE_ENV === 'production';
    },
    get isDevelopment() {
      return values.NODE_ENV === 'development';
    },
    get isTest() {
      return values.NODE_ENV === 'test';
    },
  } as unknown as AppConfig;
}

/** A complete SMTP configuration, so each case can remove exactly one thing. */
const smtpEnv = {
  EMAIL_PROVIDER: 'smtp',
  SMTP_HOST: 'smtp.example.test',
  SMTP_PORT: 587,
  SMTP_SECURE: false,
  SMTP_USER: 'no-reply@example.test',
  SMTP_PASSWORD: 'not-a-real-password',
  EMAIL_FROM: 'Example <no-reply@example.test>',
};

describe('createEmailProvider', () => {
  describe('in production', () => {
    it('refuses the console provider', () => {
      // It only logs, so live reset tokens would be written to logs and no
      // message would ever arrive.
      expect(() =>
        createEmailProvider(fakeConfig({ EMAIL_PROVIDER: 'console', NODE_ENV: 'production' })),
      ).toThrow(/not permitted in production/i);
    });

    it.each(['resend', 'ses', 'postmark', 'sendgrid', 'typo', ''])(
      'refuses to start on the unimplemented provider "%s"',
      (provider) => {
        // The regression this guards: an unrecognised value used to return a
        // provider that accepts every message and delivers none.
        expect(() =>
          createEmailProvider(fakeConfig({ EMAIL_PROVIDER: provider, NODE_ENV: 'production' })),
        ).toThrow(/has no implementation/i);
      },
    );

    it('names the supported values in the failure', () => {
      // An operator reading a crash log needs to know what to set instead.
      expect(() =>
        createEmailProvider(fakeConfig({ EMAIL_PROVIDER: 'resend', NODE_ENV: 'production' })),
      ).toThrow(new RegExp(SUPPORTED_PROVIDERS.join('|')));
    });

    it('builds the SMTP provider from a complete configuration', async () => {
      const provider = createEmailProvider(fakeConfig({ ...smtpEnv, NODE_ENV: 'production' }));

      expect(provider).toBeInstanceOf(SmtpEmailProvider);
      expect(provider.name).toBe('smtp');

      // Nothing is left running: the transport closes on shutdown, and a
      // pooled connection outliving the process is how a suite hangs.
      await (provider as SmtpEmailProvider).onModuleDestroy();
    });

    it.each(['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_SECURE'])(
      'refuses to start when %s is missing',
      (missing) => {
        // Defence in depth. The env schema refuses this first; if anything
        // ever reaches the factory half-configured, a transport that fails on
        // every message must not be what gets built.
        const partial: Record<string, unknown> = { ...smtpEnv, NODE_ENV: 'production' };
        delete partial[missing];

        expect(() => createEmailProvider(fakeConfig(partial as typeof partial & { NODE_ENV: string }))).toThrow(
          new RegExp(missing),
        );
      },
    );
  });

  describe('outside production', () => {
    it('allows the console provider in development', () => {
      const provider = createEmailProvider(
        fakeConfig({ EMAIL_PROVIDER: 'console', NODE_ENV: 'development' }),
      );

      expect(provider.name).toBe('console');
    });

    it('warns but still boots on an unimplemented provider', () => {
      // A developer must be able to work without a mail account, while still
      // being told what is happening.
      const provider = createEmailProvider(
        fakeConfig({ EMAIL_PROVIDER: 'resend', NODE_ENV: 'development' }),
      );

      // It reports itself as unconfigured rather than pretending to be a
      // working provider, which is what a health check should see.
      expect(provider.name).toBe('unconfigured');
    });

    it('allows SMTP in development too', async () => {
      // Pointing a local build at a real relay is legitimate; the provider is
      // not production-only, only the refusal of `console` is.
      const provider = createEmailProvider(fakeConfig({ ...smtpEnv, NODE_ENV: 'development' }));

      expect(provider.name).toBe('smtp');
      await (provider as SmtpEmailProvider).onModuleDestroy();
    });
  });

  it('lists only providers that are actually implemented', () => {
    // The list is what turns an unsupported value into a startup failure. If a
    // name is added here without an implementation, production would boot and
    // silently drop mail again.
    expect(SUPPORTED_PROVIDERS).toEqual(['console', 'smtp']);
  });
});
