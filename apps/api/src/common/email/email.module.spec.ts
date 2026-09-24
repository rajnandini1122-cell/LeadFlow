import { SUPPORTED_PROVIDERS, createEmailProvider } from './email.module';
import { ResendEmailProvider } from './providers/resend-email.provider';
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

    it.each(['ses', 'postmark', 'sendgrid', 'typo', ''])(
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
      // Deliberately a provider that really is unimplemented: `resend` used to
      // serve as the example here and now ships, so leaving it would have made
      // this pass for the wrong reason.
      expect(() =>
        createEmailProvider(fakeConfig({ EMAIL_PROVIDER: 'postmark', NODE_ENV: 'production' })),
      ).toThrow(new RegExp(SUPPORTED_PROVIDERS.join('|')));
    });

    /**
     * The HTTPS transport, which exists because Railway blocks outbound SMTP.
     *
     * The two must not require each other's configuration: a deployment moving
     * to Resend should not have to keep SMTP credentials to satisfy a
     * validator, and one staying on SMTP should not need an API key.
     */
    it('builds the Resend provider from an API key alone', () => {
      const provider = createEmailProvider(
        fakeConfig({
          EMAIL_PROVIDER: 'resend',
          RESEND_API_KEY: 're_test_key_value',
          EMAIL_FROM: 'LeadFlow <info@cravionventures.com>',
          NODE_ENV: 'production',
        }),
      );

      expect(provider).toBeInstanceOf(ResendEmailProvider);
      expect(provider.name).toBe('resend');
    });

    it('needs no SMTP configuration when Resend is selected', () => {
      // Not one SMTP_* value is present here, and that must be fine.
      expect(() =>
        createEmailProvider(
          fakeConfig({
            EMAIL_PROVIDER: 'resend',
            RESEND_API_KEY: 're_test_key_value',
            EMAIL_FROM: 'LeadFlow <info@cravionventures.com>',
            NODE_ENV: 'production',
          }),
        ),
      ).not.toThrow();
    });

    it('refuses to start when the API key is missing', () => {
      // Defence in depth: the env schema refuses this first. A transport built
      // without its credential would accept every message and deliver none.
      expect(() =>
        createEmailProvider(
          fakeConfig({ EMAIL_PROVIDER: 'resend', NODE_ENV: 'production' }),
        ),
      ).toThrow(/RESEND_API_KEY/);
    });

    it('does not put the API key in the failure message', () => {
      const key = 're_should_never_be_quoted';

      try {
        createEmailProvider(
          fakeConfig({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: '', NODE_ENV: 'production' }),
        );
      } catch (error) {
        expect((error as Error).message).not.toContain(key);
      }
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
        // A name with no implementation. `resend` served this purpose until it
        // shipped; using it now would assert nothing.
        fakeConfig({ EMAIL_PROVIDER: 'postmark', NODE_ENV: 'development' }),
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
    expect(SUPPORTED_PROVIDERS).toEqual(['console', 'smtp', 'resend']);
  });
});
