/**
 * Turns the signed CRAVION Admin analytics API on for one E2E suite.
 *
 * Imported FIRST, before the test app, because the config module reads the
 * environment when it is first imported.
 */
export const ANALYTICS_SECRET = 'admin-analytics-e2e-signing-secret-32-chars';

process.env['ADMIN_ANALYTICS_ENABLED'] = 'true';
process.env['ADMIN_ANALYTICS_SIGNING_SECRET'] = ANALYTICS_SECRET;
process.env['WEB_ANALYTICS_ENABLED'] = 'true';
