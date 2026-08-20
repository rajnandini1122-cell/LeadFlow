import { z } from 'zod';

/**
 * Environment schema.
 *
 * The process refuses to boot on a missing or malformed variable, rather than
 * discovering the problem on the first request that happens to need it. A
 * typo'd JWT secret should fail at deploy time, not at 3am.
 */

const durationString = z
  .string()
  .regex(/^\d+[smhd]$/, 'must be a duration such as 15m, 24h or 30d');

/** Rejects the placeholder values shipped in .env.example. */
const secret = z
  .string()
  .min(32, 'must be at least 32 characters')
  .refine((v) => !v.toLowerCase().startsWith('change-me'), {
    message: 'is still the placeholder from .env.example — generate a real secret',
  });

const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    API_BASE_URL: z.string().url().default('http://localhost:3000'),

    DATABASE_URL: z.string().min(1, 'is required'),
    /** Unpooled endpoint. Migrations only — see prisma.config.ts. */
    DIRECT_DATABASE_URL: z.string().optional(),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

    REDIS_URL: z.string().min(1, 'is required'),

    JWT_ACCESS_SECRET: secret,
    JWT_REFRESH_SECRET: secret,
    JWT_ACCESS_TTL: durationString.default('15m'),
    JWT_REFRESH_TTL: durationString.default('30d'),

    ARGON2_MEMORY_COST: z.coerce.number().int().min(8192).default(19456),
    ARGON2_TIME_COST: z.coerce.number().int().min(2).default(2),
    ARGON2_PARALLELISM: z.coerce.number().int().min(1).default(1),

    S3_ENDPOINT: z.string().optional(),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_REGION: z.string().default('ap-south-1'),

    FIREBASE_PROJECT_ID: z.string().optional(),
    FIREBASE_CLIENT_EMAIL: z.string().optional(),
    FIREBASE_PRIVATE_KEY: z.string().optional(),

    WHATSAPP_PROVIDER: z.string().default('meta'),
    WHATSAPP_APP_SECRET: z.string().optional(),
    WHATSAPP_VERIFY_TOKEN: z.string().optional(),

    THROTTLE_TTL: z.coerce.number().int().positive().default(60),
    THROTTLE_LIMIT: z.coerce.number().int().positive().default(100),
    AUTH_THROTTLE_TTL: z.coerce.number().int().positive().default(900),
    AUTH_THROTTLE_LIMIT: z.coerce.number().int().positive().default(5),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    CORS_ORIGINS: csv,
  })
  .superRefine((env, ctx) => {
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_REFRESH_SECRET'],
        message:
          'must differ from JWT_ACCESS_SECRET — sharing them lets a refresh token be presented as an access token',
      });
    }

    if (env.NODE_ENV === 'production' && env.CORS_ORIGINS.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: 'must be set explicitly in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Validates `process.env` and returns the typed config, or exits with a report
 * listing every problem at once rather than one per restart.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const lines = result.error.issues.map((i) => `  • ${i.path.join('.') || '(root)'} ${i.message}`);
    throw new Error(
      `Invalid environment configuration:\n${lines.join('\n')}\n\n` +
        `See .env.example for the full template.`,
    );
  }

  return result.data;
}
