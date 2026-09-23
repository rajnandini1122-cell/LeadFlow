/**
 * Turns the Central Admin control plane on for one spec file — at IMPORT time.
 *
 * @nestjs/config validates and snapshots process.env when the config module is
 * first imported, not when the application is created, so a beforeAll would be
 * too late: the suite would run against a disabled control plane and assert 404
 * everywhere, which is exactly what a passing test would look like.
 *
 * Imported BEFORE anything that pulls in AppModule. Jest gives each spec file
 * its own copy of process.env, so no other suite sees any of this.
 */

/**
 * The tenant the control plane administers.
 *
 * Fixed rather than generated, because the configuration has to exist before
 * the application boots while a seeded organization does not exist until after.
 * The spec creates an organization with exactly this id.
 */
export const ADMIN_ORGANIZATION_ID = '01888888-8888-7888-8888-888888888888';

/** A test fixture, not a secret: nothing real is reachable with it. */
export const ADMIN_SECRET = 'admin-control-e2e-signing-secret-32-chars';

process.env['ADMIN_CONTROL_ENABLED'] = 'true';
process.env['ADMIN_CONTROL_ORGANIZATION_ID'] = ADMIN_ORGANIZATION_ID;
process.env['ADMIN_CONTROL_SIGNING_SECRET'] = ADMIN_SECRET;
