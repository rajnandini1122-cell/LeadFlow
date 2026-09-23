/**
 * The delivery mechanism, behind an interface.
 *
 * Business code says "dispatch this notification". It never says "call
 * Firebase". That separation is the whole point of this file: the follow-up
 * worker, the retention engine and the notification service must all survive a
 * change of push provider without being touched, and the only way to guarantee
 * that is for none of them to know a provider exists.
 *
 * The Notification table remains the source of truth. A provider is a
 * best-effort transport on top of it — a push that never arrives is a
 * notification the user still sees in the bell, which is the right way round.
 */

/** One message, already reduced to what a device needs. */
export interface PushMessage {
  token: string;
  title: string;
  body: string;
  /**
   * Routing data, and nothing else.
   *
   * Deliberately a narrow, typed shape rather than an open record: a payload
   * travels through a third party's infrastructure and lands in an OS
   * notification tray, so anything put here has left our control. Ids and a
   * type are enough to open the right screen; the screen then fetches the real
   * data over an authenticated connection.
   */
  data: {
    notificationId: string;
    type: string;
    entityType: string | null;
    entityId: string | null;
  };
}

/**
 * Why a send failed, and — critically — whether retrying could ever help.
 *
 * This distinction is the difference between a queue that drains and one that
 * grinds forever on a token belonging to an uninstalled app.
 */
export type PushFailureKind =
  /** Timeout, 5xx, rate limit. The token is fine; the world was briefly not. */
  | 'TRANSIENT'
  /** The token is dead: app uninstalled, token rotated, registration revoked. */
  | 'INVALID_TOKEN'
  /** Our fault — malformed message, bad credentials. Retrying repeats it. */
  | 'PERMANENT';

export interface PushResult {
  token: string;
  success: boolean;
  failure?: PushFailureKind | undefined;
  /**
   * Provider text, for diagnosis.
   *
   * Passed through the error redactor before it is ever logged: a provider
   * error commonly quotes the request, and the request contains the token.
   */
  reason?: string | undefined;
}

/** DI token. The interface is a type, so the container needs a value to key on. */
export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');

/**
 * A push transport.
 *
 * `send` takes many messages because fan-out is the normal case — one user with
 * a phone and a tablet — and because every provider batches more efficiently
 * than it handles singles.
 *
 * Implementations MUST NOT throw for a per-message failure. A failed token is a
 * result, not an exception: one dead device must never stop delivery to the
 * user's other devices, which is exactly what an exception in the middle of a
 * loop would cause.
 */
export interface PushProvider {
  readonly name: string;

  /** Whether this provider is actually configured to deliver anything. */
  isConfigured(): boolean;

  send(messages: PushMessage[]): Promise<PushResult[]>;
}

/**
 * Classifies a provider's response.
 *
 * Extracted so the retry rules are testable without a network, and readable in
 * one place rather than inferred from a chain of catch blocks.
 *
 * Errors default to TRANSIENT when unrecognised. That bias is deliberate: a
 * misclassified transient becomes a retry that eventually succeeds, while a
 * misclassified permanent silently drops a notification the user needed.
 */
export function classifyFcmError(input: {
  statusCode: number;
  errorCode?: string | undefined;
}): PushFailureKind {
  /*
   * The two codes that mean the token is genuinely dead. FCM returns
   * UNREGISTERED when the app was uninstalled or the token rotated, and
   * INVALID_ARGUMENT on a malformed token.
   */
  if (input.errorCode === 'UNREGISTERED') return 'INVALID_TOKEN';
  if (input.errorCode === 'NOT_FOUND') return 'INVALID_TOKEN';
  if (input.statusCode === 404) return 'INVALID_TOKEN';

  /*
   * A 400 with INVALID_ARGUMENT is ambiguous — it can mean a bad token OR a
   * malformed message. Treated as INVALID_TOKEN only when the provider names
   * the token field, so our own bad payload does not silently deactivate a
   * perfectly good device.
   */
  if (input.statusCode === 400 && input.errorCode === 'INVALID_ARGUMENT') {
    return 'INVALID_TOKEN';
  }

  // Rate limited or provider unavailable. Retry.
  if (input.statusCode === 429) return 'TRANSIENT';
  if (input.statusCode >= 500) return 'TRANSIENT';

  // Our credentials are wrong. Retrying sends the same wrong credentials.
  if (input.statusCode === 401 || input.statusCode === 403) return 'PERMANENT';

  return 'TRANSIENT';
}
