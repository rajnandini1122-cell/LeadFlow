/**
 * Switches billing on for ONE e2e suite: enforcement, checkout (against a
 * stubbed Razorpay client), the LeadFlow webhook and the signed admin
 * subscriptions API. Imported FIRST, before the test app, because the config
 * module reads the environment on import. Fixed test values, never real keys.
 */
export const BILLING_ENV = {
  SUBSCRIPTION_ENFORCEMENT_ENABLED: 'true',
  BILLING_CHECKOUT_ENABLED: 'true',
  RAZORPAY_KEY_ID: 'rzp_test_e2eKeyId00001',
  RAZORPAY_KEY_SECRET: 'e2e-razorpay-key-secret',
  RAZORPAY_WEBHOOK_SECRET: 'e2e-razorpay-webhook-secret',
  ADMIN_SUBSCRIPTIONS_ENABLED: 'true',
  ADMIN_SUBSCRIPTIONS_SIGNING_SECRET: 'admin-subscriptions-e2e-signing-secret-32',
} as const;

const previous: Record<string, string | undefined> = {};
for (const [key, value] of Object.entries(BILLING_ENV)) {
  previous[key] = process.env[key];
  process.env[key] = value;
}

/** Restores the environment so later suites in the same process are unaffected. */
export function restoreBillingEnv(): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
