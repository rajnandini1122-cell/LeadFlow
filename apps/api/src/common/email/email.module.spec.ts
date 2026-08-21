import { SUPPORTED_PROVIDERS, createEmailProvider } from './email.module';
import type { AppConfig } from '../config/config.module';

/**
 * Production must refuse to start on a mail configuration that would lose
 * messages.
 *
 * Both failures below are silent in the worst possible way: the application
 * boots, every send is accepted, and nothing is delivered. Nobody notices until
 * a customer cannot reset their password, and by then the cause — a typo in an
 * environment variable weeks earlier — is not the first thing anyone suspects.
 */
function fakeConfig(values: { EMAIL_PROVIDER: string; NODE_ENV: string }): AppConfig {
  return {
    get: (key: string) => (values as Record<string, string>)[key],
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

describe('createEmailProvider', () => {
  describe('in production', () => {
    it('refuses the console provider', () => {
      // It only logs, so live reset tokens would be written to logs and no
      // message would ever arrive.
      expect(() =>
        createEmailProvider(fakeConfig({ EMAIL_PROVIDER: 'console', NODE_ENV: 'production' })),
      ).toThrow(/not permitted in production/i);
    });

    it.each(['resend', 'ses', 'postmark', 'smtp', 'sendgrid', 'typo', ''])(
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
  });

  describe('outside production', () => {
    it('allows the console provider in development', () => {
      const provider = createEmailProvider(
        fakeConfig({ EMAIL_PROVIDER: 'console', NODE_ENV: 'development' }),
      );

      expect(provider.name).toBeTruthy();
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
  });

  it('lists only providers that are actually implemented', () => {
    // The list is what turns an unsupported value into a startup failure. If a
    // name is added here without an implementation, production would boot and
    // silently drop mail again.
    expect(SUPPORTED_PROVIDERS).toEqual(['console']);
  });
});
