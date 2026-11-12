/**
 * Turns customer sending ON for one e2e suite, against local fake mail servers
 * only. Imported FIRST, because the config module reads the environment on
 * import. The dispatcher's timer stays off: the suite drives `tick()` itself,
 * so every pass is deterministic.
 */
export const EMAIL_CAMPAIGNS_ENV = {
  EMAIL_CAMPAIGNS_SENDING_ENABLED: 'true',
  EMAIL_DISPATCH_ENABLED: 'false',
  // The recipient allowlist is exercised by its own tests, which turn it back on.
  EMAIL_SENDING_UNRESTRICTED: 'true',
} as const;

const previous: Record<string, string | undefined> = {};
for (const [key, value] of Object.entries(EMAIL_CAMPAIGNS_ENV)) {
  previous[key] = process.env[key];
  process.env[key] = value;
}

export function restoreEmailCampaignsEnv(): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
