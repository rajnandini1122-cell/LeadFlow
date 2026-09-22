/**
 * Turns the website integration on for one spec file — at IMPORT time.
 *
 * @nestjs/config validates process.env when the config module is first
 * imported, not when the application is created, so a beforeAll would be too
 * late: the snapshot is already taken and the suite would run against a
 * disabled integration, asserting 404s and calling it a pass.
 *
 * Imported BEFORE anything that pulls in AppModule. Jest gives each spec file
 * its own copy of process.env, so no other suite sees any of this.
 */

/**
 * The tenant the integration is configured for.
 *
 * Fixed rather than generated, because the configuration has to exist before
 * the application boots, while a seeded organization does not exist until
 * after. The spec creates an organization with exactly this id.
 */
export const INTAKE_ORGANIZATION_ID = '01999999-9999-7999-8999-999999999999';

/** A test fixture, not a secret: nothing real is reachable with it. */
export const INTAKE_SECRET = 'test-website-intake-signing-secret-32-chars';

process.env['WEBSITE_INTAKE_ENABLED'] = 'true';
process.env['WEBSITE_INTAKE_ORGANIZATION_ID'] = INTAKE_ORGANIZATION_ID;
process.env['WEBSITE_INTAKE_SIGNING_SECRET'] = INTAKE_SECRET;
