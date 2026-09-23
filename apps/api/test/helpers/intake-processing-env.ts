/**
 * Turns automatic intake processing on for one spec file — at IMPORT time.
 *
 * @nestjs/config validates and snapshots process.env when the config module is
 * first imported, not when the application is created, so setting this in a
 * beforeAll would be too late: the suite would run against a disabled pipeline
 * and assert that nothing happened, which is exactly what a passing test would
 * look like.
 *
 * Imported BEFORE anything that pulls in AppModule. Jest gives each spec file
 * its own copy of process.env, so no other suite sees this.
 *
 * WORKER_ENABLED is deliberately NOT set here. The sweep is driven directly in
 * the tests that need it; leaving the queue off keeps BullMQ and its Redis
 * connections out of a suite that is about conversion, not scheduling.
 */
process.env['INTAKE_AUTO_PROCESSING_ENABLED'] = 'true';
process.env['INTAKE_SWEEP_BATCH_SIZE'] = '50';
