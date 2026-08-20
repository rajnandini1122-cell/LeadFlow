import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 configuration.
 *
 * `datasource.url` here is what migration and introspection commands use, and
 * it is deliberately DIRECT_DATABASE_URL, not DATABASE_URL.
 *
 * Prisma Migrate takes advisory locks and runs DDL. Neither survives a
 * transaction-mode connection pooler, so migrations must go to Neon's unpooled
 * endpoint while the running application uses the pooled one. Getting this
 * wrong produces migrations that hang or fail with confusing lock errors.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env['DIRECT_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '',
  },
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
});
