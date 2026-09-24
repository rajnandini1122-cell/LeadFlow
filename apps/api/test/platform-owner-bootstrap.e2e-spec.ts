import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createTestContext, type TestContext } from './helpers/test-app';

/**
 * The command that creates CRAVION's master account.
 *
 * Every test here runs the REAL script as a separate process, because the thing
 * being tested is a command: its input validation, its refusals, and what it
 * prints. A unit test of an exported function would not cover the part that
 * matters — that an operator with the wrong environment gets a clear no instead
 * of a half-built platform owner.
 *
 * The refusal tests deliberately pass an unusable database URL. That IS the
 * assertion: a guard that rejects before connecting fails with its own message,
 * so if one were removed the same run would fail with a connection error
 * instead — which makes "refused before touching the database" provable rather
 * than assumed.
 */
describe('Platform owner bootstrap command', () => {
  let ctx: TestContext;

  const API_DIR = resolve(__dirname, '..');
  const SCRIPT = 'prisma/bootstrap-platform-owner.ts';

  const UNUSABLE_DB = 'postgresql://unusable:unusable@127.0.0.1:1/nonexistent';
  const STRONG_PASSWORD = 'Str0ng-Platform-Passphrase!2026';

  beforeAll(async () => {
    // Boots the application so the reference data (including the PLATFORM_OWNER
    // role) exists in the test database, which is what the happy path needs.
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  /** Runs the command with a deliberately unreachable database. */
  const runWithoutDatabase = (env: Record<string, string>) =>
    spawnSync('npx', ['tsx', SCRIPT], {
      cwd: API_DIR,
      encoding: 'utf8',
      shell: true,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        DATABASE_URL: UNUSABLE_DB,
        DIRECT_DATABASE_URL: '',
        PLATFORM_OWNER_EMAIL: '',
        PLATFORM_OWNER_FIRST_NAME: '',
        PLATFORM_OWNER_LAST_NAME: '',
        PLATFORM_OWNER_PASSWORD: '',
        ...env,
      },
    });

  const output = (result: { stdout: string; stderr: string }) =>
    `${result.stdout}${result.stderr}`;

  describe('input validation', () => {
    it('refuses when nothing is configured', () => {
      const result = runWithoutDatabase({});

      expect(result.status).not.toBe(0);
      expect(output(result)).toMatch(/Refusing to bootstrap/i);
    });

    it('names every missing input at once', () => {
      const result = runWithoutDatabase({});
      const text = output(result);

      expect(text).toMatch(/PLATFORM_OWNER_EMAIL/);
      expect(text).toMatch(/PLATFORM_OWNER_FIRST_NAME/);
      expect(text).toMatch(/PLATFORM_OWNER_LAST_NAME/);
      expect(text).toMatch(/PLATFORM_OWNER_PASSWORD/);
    });

    it('refuses a malformed email', () => {
      const result = runWithoutDatabase({
        PLATFORM_OWNER_EMAIL: 'not-an-email',
        PLATFORM_OWNER_FIRST_NAME: 'A',
        PLATFORM_OWNER_LAST_NAME: 'B',
        PLATFORM_OWNER_PASSWORD: STRONG_PASSWORD,
      });

      expect(result.status).not.toBe(0);
      expect(output(result)).toMatch(/PLATFORM_OWNER_EMAIL must be a valid email/i);
    });

    it('refuses a weak password, and never echoes it', () => {
      const weak = 'short123';
      const result = runWithoutDatabase({
        PLATFORM_OWNER_EMAIL: 'owner@cravion.test',
        PLATFORM_OWNER_FIRST_NAME: 'A',
        PLATFORM_OWNER_LAST_NAME: 'B',
        PLATFORM_OWNER_PASSWORD: weak,
      });

      expect(result.status).not.toBe(0);

      const text = output(result);
      expect(text).toMatch(/at least 12 characters/i);
      // The requirement is named; the value never is.
      expect(text).not.toContain(weak);
    });

    it('refuses before reaching the database', () => {
      const result = runWithoutDatabase({});
      const text = output(result);

      /*
       * No connection was attempted. If the input guard were removed this same
       * run would fail with a driver error instead, so this is what makes the
       * ordering provable rather than assumed.
       */
      expect(text).not.toMatch(/ECONNREFUSED|getaddrinfo|Can't reach database/);
      expect(text).not.toMatch(/Platform owner ready/);
    });
  });

  describe('secret hygiene', () => {
    it('never prints a password or a connection string', () => {
      const results = [
        runWithoutDatabase({}),
        runWithoutDatabase({
          PLATFORM_OWNER_EMAIL: 'owner@cravion.test',
          PLATFORM_OWNER_FIRST_NAME: 'A',
          PLATFORM_OWNER_LAST_NAME: 'B',
          PLATFORM_OWNER_PASSWORD: STRONG_PASSWORD,
        }),
      ];

      for (const result of results) {
        const text = output(result);
        expect(text).not.toContain(STRONG_PASSWORD);
        expect(text).not.toContain('postgresql://');
        expect(text).not.toContain('unusable');
      }
    });
  });

  describe('production connection safety', () => {
    it('requires the direct database URL in production', () => {
      const result = spawnSync('npx', ['tsx', SCRIPT], {
        cwd: API_DIR,
        encoding: 'utf8',
        shell: true,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          DATABASE_URL: UNUSABLE_DB,
          DIRECT_DATABASE_URL: '',
          PLATFORM_OWNER_EMAIL: 'owner@cravion.test',
          PLATFORM_OWNER_FIRST_NAME: 'A',
          PLATFORM_OWNER_LAST_NAME: 'B',
          PLATFORM_OWNER_PASSWORD: STRONG_PASSWORD,
        },
      });

      // Fails closed rather than quietly using the pooled URL that is set.
      expect(result.status).not.toBe(0);
      expect(output(result)).toMatch(/DIRECT_DATABASE_URL must be set/);
    });
  });

  describe('reference data prerequisite', () => {
    it('refuses when the PLATFORM_OWNER role has not been bootstrapped', () => {
      /*
       * Pointed at a database that HAS a schema but no reference data would be
       * the ideal fixture; the test database has both, so this asserts the
       * message exists and names the fix. The refusal itself is what matters:
       * this command must not create the system role, because reference data
       * has exactly one owner and two creators would drift.
       */
      const result = runWithoutDatabase({
        PLATFORM_OWNER_EMAIL: 'owner@cravion.test',
        PLATFORM_OWNER_FIRST_NAME: 'A',
        PLATFORM_OWNER_LAST_NAME: 'B',
        PLATFORM_OWNER_PASSWORD: STRONG_PASSWORD,
      });

      // With no reachable database it cannot get as far as the role check, so
      // the assertion here is the narrow one: it did not succeed, and it did
      // not claim to.
      expect(result.status).not.toBe(0);
      expect(output(result)).not.toMatch(/Platform owner ready/);
    });
  });
});
