import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import type { Request } from 'express';
import type { SuccessResponse } from '@idea001/api-types';

/** Handlers may return this to opt out of the envelope (used by /health). */
export const RAW_RESPONSE = Symbol('RAW_RESPONSE');
export interface RawResponse<T> {
  [RAW_RESPONSE]: true;
  body: T;
}
export const raw = <T>(body: T): RawResponse<T> => ({ [RAW_RESPONSE]: true, body });

/**
 * Wraps every successful response in the standard envelope (spec §21) so that
 * no controller ever constructs one by hand and they cannot drift apart.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request & { id?: string }>();

    return next.handle().pipe(
      map((data: unknown): unknown => {
        if (data && typeof data === 'object' && RAW_RESPONSE in data) {
          return (data as RawResponse<unknown>).body;
        }

        const envelope: SuccessResponse<unknown> = {
          success: true,
          data: data ?? null,
          meta: {
            timestamp: new Date().toISOString(),
            requestId: request.id ?? 'unknown',
          },
        };
        return envelope;
      }),
    );
  }
}
