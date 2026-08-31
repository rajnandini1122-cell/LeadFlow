import { validateEnv } from './env.schema';

/**
 * What refuses to boot, and why.
 *
 * Every check here exists to prevent the same failure: a process that looks
 * perfectly healthy while a capability the business depends on is silently
 * switched off. That failure has no symptom until a customer is missed, so the
 * only useful signal is one that arrives before the process starts serving.
 */

/** The minimum a valid configuration needs, so each test varies one thing. */
function baseEnv(overrides: Record<string, string> = {}): Record<string, unknown> {
  return {
    NODE_ENV: 'test',
    PORT: '3000',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/leadflow',
    DIRECT_DATABASE_URL: 'postgresql://user:pass@localhost:5432/leadflow',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'a-access-secret-that-is-at-least-32-chars',
    JWT_REFRESH_SECRET: 'a-different-refresh-secret-at-least-32ch',
    CORS_ORIGINS: 'http://localhost:5173',
    ...overrides,
  };
}

describe('production configuration', () => {
  it('accepts a complete development configuration', () => {
    expect(() => validateEnv(baseEnv())).not.toThrow();
  });

  describe('FCM', () => {
    it('REFUSES a half-configured push provider, in any environment', () => {
      /*
       * The worst kind of misconfiguration: with one or two of three values
       * set, the provider reports itself unconfigured, every notification is
       * created and persisted and silently never delivered, and every health
       * check stays green.
       */
      expect(() =>
        validateEnv(baseEnv({ FIREBASE_PROJECT_ID: 'leadflow-prod' })),
      ).toThrow(/FIREBASE/);

      expect(() =>
        validateEnv(
          baseEnv({
            FIREBASE_PROJECT_ID: 'leadflow-prod',
            FIREBASE_CLIENT_EMAIL: 'push@leadflow-prod.iam.gserviceaccount.com',
          }),
        ),
      ).toThrow(/FIREBASE/);
    });

    it('accepts all three together', () => {
      expect(() =>
        validateEnv(
          baseEnv({
            FIREBASE_PROJECT_ID: 'leadflow-prod',
            FIREBASE_CLIENT_EMAIL: 'push@leadflow-prod.iam.gserviceaccount.com',
            FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----',
          }),
        ),
      ).not.toThrow();
    });

    it('accepts none at all — push is optional', () => {
      // A deployment that has deliberately not enabled push still boots.
      expect(() => validateEnv(baseEnv())).not.toThrow();
    });
  });

  describe('in production', () => {
    const production = (overrides: Record<string, string> = {}) =>
      baseEnv({
        NODE_ENV: 'production',
        RELEASE_SHA: 'abc1234',
        CORS_ORIGINS: 'https://app.leadflow.example',
        ...overrides,
      });

    it('REFUSES a worker with no way to notify anyone', () => {
      /*
       * The check that matters most. A worker whose entire job is to reach
       * salespeople, deployed with no push provider, would sweep follow-ups
       * and write notifications that reach nobody — with every probe green.
       * Somebody would find out by missing a customer.
       */
      expect(() => validateEnv(production({ WORKER_ENABLED: 'true' }))).toThrow(
        /notifications nobody can receive/,
      );
    });

    it('allows a worker WITH push configured', () => {
      expect(() =>
        validateEnv(
          production({
            WORKER_ENABLED: 'true',
            FIREBASE_PROJECT_ID: 'leadflow-prod',
            FIREBASE_CLIENT_EMAIL: 'push@leadflow-prod.iam.gserviceaccount.com',
            FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----',
          }),
        ),
      ).not.toThrow();
    });

    it('does NOT require push on an API replica', () => {
      // An API replica delivers nothing, so push credentials are none of its
      // business — and requiring them would put a secret on every web pod.
      expect(() => validateEnv(production({ WORKER_ENABLED: 'false' }))).not.toThrow();
    });

    it('REFUSES a deploy with no release identifier', () => {
      /*
       * Without it every deploy groups as the same deploy in the error
       * tracker, and a regression shipped today is indistinguishable from
       * noise from three months ago.
       */
      const env = production();
      delete env['RELEASE_SHA'];

      expect(() => validateEnv(env)).toThrow(/RELEASE_SHA/);
    });

    it('still REFUSES an empty CORS list', () => {
      expect(() => validateEnv(production({ CORS_ORIGINS: '' }))).toThrow(/CORS_ORIGINS/);
    });

    it('does not require a release identifier outside production', () => {
      expect(() => validateEnv(baseEnv({ WORKER_ENABLED: 'true' }))).not.toThrow();
    });
  });

  it('REJECTS object-storage variables that no longer have a consumer', () => {
    /*
     * The five S3_* variables were accepted by the schema and read by nothing:
     * no SDK, no service, no reference outside the schema and .env.example.
     * Avatars store bytes in Postgres, and omnichannel media deliberately
     * stores nothing at all.
     *
     * Dead configuration is not harmless. It invites an operator to paste a
     * real object-storage credential into a production secret store for a
     * feature that does not exist, where it sits unused and unrotated until
     * somebody finds it.
     *
     * The schema STRIPS rather than rejects, and that is correct: process.env
     * always carries variables that are none of our business — PATH, HOME, the
     * platform's own RAILWAY_* — so a strict schema would refuse to boot
     * anywhere real. What this asserts is the guarantee that matters: even if
     * somebody sets them, the value never reaches the application, so no code
     * can quietly start depending on one again.
     */
    const parsed = validateEnv(
      baseEnv({ S3_BUCKET: 'leadflow-uploads', S3_SECRET_ACCESS_KEY: 'x' }),
    ) as Record<string, unknown>;

    expect(parsed['S3_BUCKET']).toBeUndefined();
    expect(parsed['S3_SECRET_ACCESS_KEY']).toBeUndefined();
  });

  describe('auth secrets', () => {
    it('REFUSES identical access and refresh secrets', () => {
      // Sharing them lets a refresh token be presented as an access token.
      const shared = 'the-same-secret-value-at-least-32-chars-x';

      expect(() =>
        validateEnv(baseEnv({ JWT_ACCESS_SECRET: shared, JWT_REFRESH_SECRET: shared })),
      ).toThrow(/JWT_REFRESH_SECRET/);
    });
  });

  it('reports EVERY problem at once, not one per restart', () => {
    /*
     * A validator that stops at the first error turns configuring a deployment
     * into a guessing game of restart, read, fix, repeat.
     */
    const env = baseEnv({
      NODE_ENV: 'production',
      CORS_ORIGINS: '',
      WORKER_ENABLED: 'true',
    });
    delete env['RELEASE_SHA'];

    try {
      validateEnv(env);
      throw new Error('should have thrown');
    } catch (error) {
      const message = (error as Error).message;

      expect(message).toContain('CORS_ORIGINS');
      expect(message).toContain('RELEASE_SHA');
      expect(message).toContain('FIREBASE_PROJECT_ID');
    }
  });
});
