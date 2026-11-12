/**
 * Customer sending AND Resend Broadcasts on, for one e2e suite, against the
 * in-memory fake Resend only. Imported FIRST (the config module reads the
 * environment on import). RESEND_API_KEY is the platform's TRANSACTIONAL key,
 * set so the suite can prove campaigns never use it.
 */
export const EMAIL_BROADCASTS_ENV = {
  EMAIL_CAMPAIGNS_SENDING_ENABLED: 'true',
  EMAIL_RESEND_BROADCASTS_ENABLED: 'true',
  EMAIL_DISPATCH_ENABLED: 'false',
  RESEND_API_KEY: 're_transactional_platform_key_000',
  // The recipient allowlist is exercised by its own tests, which turn it back on.
  EMAIL_SENDING_UNRESTRICTED: 'true',
} as const;

const previous: Record<string, string | undefined> = {};
for (const [key, value] of Object.entries(EMAIL_BROADCASTS_ENV)) {
  previous[key] = process.env[key];
  process.env[key] = value;
}

export function restoreEmailBroadcastsEnv(): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
