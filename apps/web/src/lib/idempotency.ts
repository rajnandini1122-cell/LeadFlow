/**
 * A fresh Idempotency-Key.
 *
 * Generate ONE per dialog opening, not per click. A second click — or the
 * same request retried after a dropped connection — then carries the same key,
 * and the API answers it with the original result instead of doing the work
 * twice. Reopening the dialog mints a new key, so a genuinely new action is
 * never mistaken for a replay.
 *
 * `crypto.randomUUID` needs a secure context. The Android WebView and localhost
 * both are one; the fallback exists for anything that is not, and still meets
 * the API's 8–100 character [A-Za-z0-9_-] rule.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** The request option that carries a key, or nothing when there is none. */
export function idempotencyHeaders(key: string | undefined): { headers?: Record<string, string> } {
  return key ? { headers: { 'Idempotency-Key': key } } : {};
}
