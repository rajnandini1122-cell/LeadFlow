/**
 * Small, real rate limits for the rate-limit suite — installed at IMPORT time.
 *
 * @nestjs/config validates process.env inside ConfigModule.forRoot(), and that
 * call runs the moment config.module.ts is first imported, not when the
 * application is created. Setting these values in a beforeAll would therefore
 * be too late: the snapshot has already been taken, and the suite would run
 * against the enormous limits the global setup installs, quietly asserting
 * nothing.
 *
 * So this module exists for its side effect, and must be imported BEFORE
 * anything that pulls in AppModule. Jest gives each spec file its own copy of
 * process.env, so the suites running alongside keep the limits they expect.
 */
/*
 * Five, the production default — and the floor that works here. The fixture
 * signs four seeded users in from the same loopback address before the first
 * test runs, so a smaller allowance throttles the setup rather than the code
 * under test.
 */
export const CREDENTIAL_LIMIT = 5;
export const CREDENTIAL_TTL_SECONDS = 2;
export const GENERAL_LIMIT = 1000;

process.env['AUTH_THROTTLE_LIMIT'] = String(CREDENTIAL_LIMIT);
process.env['AUTH_THROTTLE_TTL'] = String(CREDENTIAL_TTL_SECONDS);
// Generous, as in production: the general policy must never be what trips in a
// test about the credential policy.
process.env['THROTTLE_LIMIT'] = String(GENERAL_LIMIT);
// The deployment default, and what makes the spoofing case below meaningful.
process.env['TRUST_PROXY_HOPS'] = '0';
