import { Injectable, Logger } from '@nestjs/common';

/**
 * A normalised error event, in the shape an aggregator ingests.
 *
 * Deliberately a FIXED shape rather than a free-form log line: an aggregator
 * groups by fingerprint, and a fingerprint built from an interpolated message
 * ("Lead 7f3a… not found") produces one group per lead instead of one group per
 * bug. `type` and `route` are what group correctly.
 */
export interface ErrorEvent {
  environment: string;
  release: string;
  /** The route pattern, not the concrete path — see the fingerprint note. */
  route: string;
  method: string;
  statusCode: number;
  requestId: string;
  /** Present only when the request was authenticated. */
  organizationId?: string | undefined;
  userId?: string | undefined;
  type: string;
  message: string;
  stack?: string | undefined;
  timestamp: string;
}

/**
 * Keys whose VALUES must never reach an error tracker.
 *
 * An error report is shipped to a third party and retained for months, so
 * anything here would outlive the incident it was captured for. Matched on
 * substring and case-insensitively, because the same secret appears as
 * `authorization`, `Authorization` and `refresh_token` depending on who wrote
 * the code.
 */
const REDACTED_KEYS = [
  'password',
  'token',
  'secret',
  'authorization',
  'cookie',
  'credential',
  'apikey',
  'api_key',
  'jwt',
  'session',
  'signature',
];

/**
 * Production error reporting.
 *
 * The autopsy scored observability 3/10 — structured logs and nothing else, so
 * a failure in production produced a line nobody read. This is the seam that
 * fixes it.
 *
 * Deliberately NOT a direct Sentry dependency. The abstraction exists so the
 * decision of WHICH tracker is a configuration change rather than a code
 * change, and so the redaction rules below are enforced in one place that no
 * provider SDK can bypass. `report()` emits a normalised event at error level
 * with a stable shape; wiring a provider means adding one transport here, and
 * every event it receives has already been through the redactor.
 */
@Injectable()
export class ErrorReporter {
  private readonly logger = new Logger('ErrorReporter');

  constructor(
    private readonly environment: string,
    private readonly release: string,
  ) {}

  /**
   * Reports one error.
   *
   * Never throws. An error in the error reporter must not replace the error it
   * was reporting — that turns one legible failure into two illegible ones.
   */
  report(input: {
    error: unknown;
    route: string;
    method: string;
    statusCode: number;
    requestId: string;
    organizationId?: string | undefined;
    userId?: string | undefined;
  }): void {
    try {
      const event = this.normalise(input);

      /*
       * Emitted at error level with `err_event` as the marker.
       *
       * Any log-shipping aggregator can select on that key without parsing
       * prose, which is what makes this useful before a tracker is wired and
       * what keeps it useful after.
       */
      this.logger.error({ err_event: event }, `${event.type}: ${event.message}`);
    } catch (reportingFailure) {
      this.logger.warn(
        { err: reportingFailure },
        'Error reporting itself failed — the original error is above',
      );
    }
  }

  private normalise(input: {
    error: unknown;
    route: string;
    method: string;
    statusCode: number;
    requestId: string;
    organizationId?: string | undefined;
    userId?: string | undefined;
  }): ErrorEvent {
    const error = input.error;
    const isError = error instanceof Error;

    return {
      environment: this.environment,
      release: this.release,
      route: input.route,
      method: input.method,
      statusCode: input.statusCode,
      requestId: input.requestId,
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
      type: isError ? error.constructor.name : typeof error,
      message: redactText(isError ? error.message : String(error)),
      ...(isError && error.stack ? { stack: redactText(error.stack) } : {}),
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Removes anything that looks like a credential from free text.
 *
 * A stack trace or an error message can contain a bearer token — a failed HTTP
 * call to a provider is the common case, where the request headers end up in
 * the message. This is a blunt instrument on purpose: over-redacting an error
 * report costs a little debugging context, while under-redacting one ships a
 * live token to a third party and leaves it there.
 */
export function redactText(text: string): string {
  let result = text;

  /*
   * ORDER MATTERS, and getting it wrong leaks the thing this exists to hide.
   *
   * The keyword rule below matches `authorization: <value>` and takes the
   * first token as the value. Against `Authorization: Bearer eyJhbGci…` that
   * value is the literal word "Bearer" — so running keywords first produced
   * "Authorization: [REDACTED] eyJhbGci…", redacting nothing and shipping a
   * live token. The specific patterns run FIRST for exactly that reason.
   */

  // Anything shaped like a JWT, labelled or not.
  result = result.replace(
    /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
    '[REDACTED_JWT]',
  );

  // Bearer tokens, wherever they appear.
  result = result.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');

  // Connection strings with inline credentials.
  result = result.replace(/\b([a-z+]+:\/\/)([^:@\s/]+):([^@\s/]+)@/gi, '$1$2:[REDACTED]@');

  /*
   * key=value and key: value, quoted or not.
   *
   * The optional `Bearer` prefix is consumed as part of the value so a header
   * is redacted as one unit rather than leaving the scheme and hiding nothing.
   */
  for (const key of REDACTED_KEYS) {
    const pattern = new RegExp(
      `(${key}["']?\\s*[=:]\\s*["']?)(?:Bearer\\s+)?([^\\s,;"'}]+)`,
      'gi',
    );
    result = result.replace(pattern, '$1[REDACTED]');
  }

  return result;
}
