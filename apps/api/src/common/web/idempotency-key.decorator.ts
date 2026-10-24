import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AppException } from '../errors/app.exception';

/**
 * What an Idempotency-Key may look like.
 *
 * A UUID fits with room to spare. The character class excludes anything that
 * could matter inside a JSON path or a log line, and the floor of eight stops a
 * client from sending "1" and colliding with itself across unrelated actions.
 */
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

/**
 * Parses the `Idempotency-Key` header. Absent → null.
 *
 * A PRESENT but malformed key is refused with 400 rather than ignored. Silently
 * dropping it would turn the caller's protection off without telling them —
 * the double submit they were guarding against would then go through.
 */
export function parseIdempotencyKey(raw: string | string[] | undefined): string | null {
  if (raw === undefined) return null;

  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === '') return null;

  if (!KEY_PATTERN.test(value)) {
    throw AppException.validation('Invalid Idempotency-Key header.', {
      'idempotency-key': ['must be 8–100 characters of A–Z, a–z, 0–9, "-" or "_"'],
    });
  }

  return value;
}

/**
 * Injects the caller's Idempotency-Key, validated, or null.
 *
 * Used on the agent actions where a double-click or a retried request must be
 * ONE logical action: logging an attempt, scheduling, completing and
 * rescheduling a follow-up. The key is matched against the timeline entry the
 * first request wrote, inside a transaction holding the lead's row lock — so a
 * replay is answered with the original result and never writes twice.
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | null =>
    parseIdempotencyKey(context.switchToHttp().getRequest<Request>().headers['idempotency-key']),
);
