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

/**
 * Accepts "user@example.com" and "Display Name <user@example.com>".
 *
 * Deliberately narrow: this exists to catch a mistyped From before it becomes
 * mail that no receiving server will accept, not to re-implement RFC 5322.
 */
function isMailbox(value: string): boolean {
  const address = /^\s*[^<>]*<([^<>]+)>\s*$/.exec(value)?.[1] ?? value.trim();

  return z.string().email().safeParse(address).success;
}

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
    // --- product identity ---------------------------------------------------
    // Kept in configuration rather than in source so the same build can be
    // rebranded per deployment without a code change.
    PRODUCT_NAME: z.string().min(1).default('LeadFlow'),
    PRODUCT_TAGLINE: z
      .string()
      .default('Simple lead management and follow-up for growing teams'),
    PRODUCT_LOGO_URL: z.string().default(''),

    // --- email --------------------------------------------------------------
    /**
     * Which transport carries password resets and invitations.
     *
     * 'console' logs instead of sending and is refused in production; 'smtp'
     * delivers through any standards-compliant server. Deliberately a plain
     * string rather than an enum: an unrecognised value must fail loudly at
     * boot in production and merely warn in development, which is a decision
     * createEmailProvider makes with more context than the schema has.
     */
    EMAIL_PROVIDER: z.string().default('console'),
    /**
     * The envelope sender. Either a bare address or a display name with one:
     *
     *   no-reply@example.com
     *   LeadFlow <no-reply@example.com>
     *
     * Validated because a malformed From is rejected by the receiving server,
     * not by us — the failure would surface as mail that silently never
     * arrives, which is the class of problem this whole schema exists to catch.
     */
    EMAIL_FROM: z
      .string()
      .default('LeadFlow <no-reply@example.com>')
      .refine((value) => isMailbox(value), {
        message:
          'must be an email address, optionally with a display name: ' +
          '"no-reply@example.com" or "LeadFlow <no-reply@example.com>"',
      }),

    /**
     * SMTP transport. Required together when EMAIL_PROVIDER=smtp, ignored
     * otherwise — see the conditional check below.
     *
     * No defaults, deliberately. A default host or port would let a
     * half-configured production deployment boot and send nowhere, and a
     * default credential is worse than none.
     */
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    /**
     * TLS mode, stated rather than inferred from the port.
     *
     * 'true' means implicit TLS from the first byte (usually port 465).
     * 'false' means the connection starts in cleartext and is upgraded with
     * STARTTLS (usually 587) — which this application requires rather than
     * merely attempts, so credentials never cross an unencrypted socket.
     *
     * Strict about its spelling on purpose: the house style elsewhere treats
     * anything that is not 'true' as false, and here that would turn
     * SMTP_SECURE=1 or =TRUE into a silent downgrade to the other mode.
     */
    SMTP_SECURE: z
      .enum(['true', 'false'], {
        message: "must be exactly 'true' or 'false'",
      })
      .transform((value) => value === 'true')
      .optional(),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    // Where emailed links point. The WEB app, not the API.
    WEB_BASE_URL: z.string().url().default('http://localhost:5173'),
    // Where public contact-form enquiries are delivered. Configuration rather
    // than a constant in source, so the address can differ per deployment and
    // can be changed without a release.
    SALES_EMAIL: z.string().email().default('sales@cravionventures.com'),

    // --- defaults for newly created organizations ---------------------------
    // Fallbacks only. Each organization stores its own, and every
    // tenant-visible figure is formatted from the tenant value, never these.
    DEFAULT_TIMEZONE: z.string().default('UTC'),
    DEFAULT_CURRENCY: z.string().length(3).default('USD'),
    DEFAULT_LOCALE: z.string().default('en-US'),
    DEFAULT_COUNTRY: z.string().length(2).default('US'),

    // --- platform operations ------------------------------------------------
    // Contact number for the PLATFORM operator, not for any tenant. Read in
    // exactly one place (PlatformService) and used only for operational
    // alerting and future support tooling. It confers no permission and takes
    // no part in authentication — see the comment on that service.
    PLATFORM_MASTER_PHONE: z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/, 'must be an E.164 number such as +14155550100')
      .or(z.literal(''))
      .default(''),

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

    /**
     * How long after a refresh token is rotated a second presentation of it is
     * still treated as a straggler rather than a leak.
     *
     * Requests sent together can reach the database far apart — a saturated
     * connection pool is enough — and from database state alone a legitimate
     * straggler is indistinguishable from a replay sent immediately after the
     * rotation. This interval is that ambiguity, made explicit and bounded.
     *
     * It suppresses FAMILY REVOCATION only. Inside it the spent token still
     * fails with 401, still mints no child, and still returns no credential;
     * outside it, reuse kills the whole family as before. Larger values trade
     * detection speed for tolerance, so the upper bound is deliberately low.
     * Set it to 0 for strict detection with no tolerance at all.
     */
    REFRESH_REUSE_INTERVAL_MS: z.coerce.number().int().min(0).max(10_000).default(2000),

    ARGON2_MEMORY_COST: z.coerce.number().int().min(8192).default(19456),
    ARGON2_TIME_COST: z.coerce.number().int().min(2).default(2),
    ARGON2_PARALLELISM: z.coerce.number().int().min(1).default(1),

    FIREBASE_PROJECT_ID: z.string().optional(),
    FIREBASE_CLIENT_EMAIL: z.string().optional(),
    FIREBASE_PRIVATE_KEY: z.string().optional(),

    WHATSAPP_PROVIDER: z.string().default('meta'),
    /** Meta app secret. Every webhook body is HMAC-signed with it. */
    WHATSAPP_APP_SECRET: z.string().optional(),
    /** Shared string Meta echoes back when the webhook URL is first saved. */
    WHATSAPP_VERIFY_TOKEN: z.string().optional(),
    /**
     * Graph API version, in one place.
     *
     * Meta deprecates versions on a rolling schedule, so this has to be a
     * configuration value: pinning it across a dozen call sites turns a routine
     * upgrade into a search-and-replace with no way to roll back.
     */
    WHATSAPP_API_VERSION: z.string().default('v21.0'),
    /**
     * Meta app secret for the Instagram product.
     *
     * Separate from the WhatsApp one because the two products can live in
     * different Meta apps. If yours share an app, set the same value — but the
     * config says which secret guards which endpoint rather than assuming.
     */
    INSTAGRAM_APP_SECRET: z.string().optional(),
    /** Shared string Meta echoes back when the Instagram webhook is saved. */
    INSTAGRAM_VERIFY_TOKEN: z.string().optional(),
    /**
     * Meta app secret for the Messenger product.
     *
     * Separate again, for the same reason: the three products can live in
     * three different Meta apps, and sharing a secret by accident would mean a
     * leak of any one compromised all three.
     */
    FACEBOOK_APP_SECRET: z.string().optional(),
    /** Shared string Meta echoes back when the Messenger webhook is saved. */
    FACEBOOK_VERIFY_TOKEN: z.string().optional(),
    /**
     * Whether the stale-outbound-message sweep runs in this process.
     *
     * On by default. Turned off in the test suite, where recovery is invoked
     * directly so a background timer cannot race the assertions or keep the
     * process alive after the suite finishes.
     */
    /**
     * Whether THIS process runs queue processors.
     *
     * The API and the worker are built from the same image, so without this
     * every API replica would also sweep — three replicas meaning three
     * concurrent sweeps. The idempotency markers would hold, but the wasted
     * queries would not, and the point of a separate process is that
     * background work does not compete with request latency.
     *
     * Default FALSE. A process runs processors only when deliberately told to,
     * which is the safe default when the same image serves both roles.
     */
    WORKER_ENABLED: z
      .string()
      .default('false')
      .transform((value) => value === 'true'),
    /**
     * How often the follow-up sweep runs, in seconds.
     *
     * Sixty seconds. The sweep is cheap — bounded queries against an index
     * built for it — and a reminder that arrives up to a minute late is
     * indistinguishable from one that arrives on time. Anything longer starts
     * to be visible to a rep watching for a due follow-up.
     */
    FOLLOW_UP_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
    OUTBOUND_RECOVERY_ENABLED: z
      .string()
      .default('true')
      .transform((value) => value !== 'false'),
    /**
     * How long a message may sit PENDING before it is treated as abandoned.
     *
     * Default 120 seconds. The provider call itself times out at 15, so
     * anything still PENDING two minutes later is not in flight — it belongs
     * to a process that is no longer running. Short enough that nobody watches
     * "Sending…" for long; far enough past the timeout that a slow-but-alive
     * send is never finalised out from under itself.
     */
    OUTBOUND_RECOVERY_AFTER_SECONDS: z.coerce.number().int().positive().default(120),
    /** How often the sweep runs. */
    OUTBOUND_RECOVERY_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
    /**
     * Base64 32-byte key encrypting provider access tokens at rest.
     *
     * Optional so the application still boots without WhatsApp configured;
     * connecting an integration fails loudly if it is missing, rather than
     * quietly storing a bearer token in plaintext.
     *
     *   openssl rand -base64 32
     */
    CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),

    /**
     * Google OAuth client id, for "Continue with Google".
     *
     * OPTIONAL, and its absence is a supported state rather than a
     * misconfiguration: a deployment without it simply does not offer Google
     * sign-in, and the client hides the button rather than showing one that
     * fails on click.
     *
     * A client ID is PUBLIC by design — it is embedded in every browser that
     * loads the sign-in button. There is deliberately no client SECRET here:
     * this flow verifies an ID token that Google issued to the browser, which
     * needs the id and the audience check, not a secret.
     *
     * Created at console.cloud.google.com under APIs & Services → Credentials
     * → OAuth client ID → Web application.
     */
    GOOGLE_CLIENT_ID: z.string().optional(),

    /** The general API limit. Applies to every route. */
    THROTTLE_TTL: z.coerce.number().int().positive().default(60),
    THROTTLE_LIMIT: z.coerce.number().int().positive().default(100),
    /**
     * The credential limit: login, registration, password reset and the rest
     * of the endpoints where guessing is the attack.
     *
     * It reaches ONLY handlers marked with @CredentialThrottle(). It used to
     * reach everything, which is what made an ordinary sales team behind one
     * office IP share five requests per fifteen minutes.
     */
    AUTH_THROTTLE_TTL: z.coerce.number().int().positive().default(900),
    AUTH_THROTTLE_LIMIT: z.coerce.number().int().positive().default(5),

    /**
     * How many reverse proxies sit in front of this process.
     *
     * Express derives `req.ip` — which is what every rate limit and audit row
     * is keyed on — by walking `X-Forwarded-For` from the right, trusting
     * this many hops. Getting it wrong is a security bug in both directions:
     * trust too many and any caller invents a fresh identity per request by
     * setting a header, closing the limiter entirely; trust too few and every
     * customer behind the load balancer shares the proxy's address.
     *
     * Defaults to 0 — trust nothing — because that is the only value that is
     * safe without knowing the topology. Set it to the real number of hops
     * when the deployment is fixed (1 for a single load balancer; 2 behind a
     * CDN in front of it). See docs/production.md.
     */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),

    /**
     * The build this process is running.
     *
     * Read from the environment rather than package.json: what matters is
     * which BUILD is deployed, and two deploys of the same version number are
     * different builds. Required in production — see the check below.
     */
    RELEASE_SHA: z.string().optional(),

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

    /*
     * SMTP is all-or-nothing, in every environment.
     *
     * The failure this prevents is the familiar one: with a host but no
     * password the provider constructs, the process boots, every send is
     * attempted and refused, and password resets disappear while the
     * application reports itself healthy. Checked everywhere rather than only
     * in production so a staging deployment finds the gap first.
     *
     * Nothing is required when the provider is not smtp — a developer running
     * the console provider must not need mail credentials to start the app.
     */
    if (env.EMAIL_PROVIDER === 'smtp') {
      const required = {
        SMTP_HOST: env.SMTP_HOST,
        SMTP_PORT: env.SMTP_PORT,
        SMTP_USER: env.SMTP_USER,
        SMTP_PASSWORD: env.SMTP_PASSWORD,
        // A boolean, so absence is the only thing to test: `false` is a
        // perfectly good value and must not read as "missing".
        SMTP_SECURE: env.SMTP_SECURE,
      };

      for (const [name, value] of Object.entries(required)) {
        if (value === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [name],
            message:
              'is required when EMAIL_PROVIDER=smtp — a partially configured ' +
              'transport accepts every message and delivers none',
          });
        }
      }
    }

    /*
     * A HALF-CONFIGURED push provider is always a mistake.
     *
     * FCM needs all three values. With one or two set, the provider reports
     * itself unconfigured and every notification is created, persisted, and
     * silently never delivered — while the process looks entirely healthy.
     * That is the failure mode this whole class of check exists to prevent, so
     * it fails at boot in every environment rather than only in production.
     */
    const fcmParts = [
      env.FIREBASE_PROJECT_ID,
      env.FIREBASE_CLIENT_EMAIL,
      env.FIREBASE_PRIVATE_KEY,
    ];
    const fcmSet = fcmParts.filter(Boolean).length;

    if (fcmSet > 0 && fcmSet < fcmParts.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['FIREBASE_PRIVATE_KEY'],
        message:
          'FCM needs FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and ' +
          'FIREBASE_PRIVATE_KEY together. Partially configured, push is ' +
          'silently disabled while everything reports healthy.',
      });
    }

    if (env.NODE_ENV === 'production') {
      /*
       * A WORKER whose entire job is to notify people, deployed with no way to
       * notify anyone.
       *
       * The sweep would run, follow-ups would advance, notifications would be
       * written — and no phone would ever ring, with every health check green.
       * A salesperson would learn about it by missing a customer. Refusing to
       * boot is the only signal that arrives before the damage.
       *
       * Only the worker: an API replica has WORKER_ENABLED=false and does not
       * deliver anything, so push credentials are none of its business.
       */
      if (env.WORKER_ENABLED && fcmSet === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['FIREBASE_PROJECT_ID'],
          message:
            'a production worker with WORKER_ENABLED=true must have FCM ' +
            'configured — otherwise it generates notifications nobody can ' +
            'receive while reporting healthy',
        });
      }

      /*
       * Without a release identifier every deploy looks like the same deploy
       * in the error tracker, so a regression introduced today groups with
       * errors from three months ago and nobody can tell what changed.
       */
      if (!env.RELEASE_SHA) {
        ctx.addIssue({
          code: 'custom',
          path: ['RELEASE_SHA'],
          message:
            'must be set in production so errors group by deploy — ' +
            'see docs/production.md',
        });
      }
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
