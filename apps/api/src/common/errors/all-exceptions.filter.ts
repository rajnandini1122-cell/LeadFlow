import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ERROR_CODES, type ErrorCode, type ErrorResponse } from '@idea001/api-types';
import { AppException } from './app.exception';
import { TenantContextMissingError } from '../tenancy/tenancy.errors';

interface NormalisedError {
  status: number;
  code: ErrorCode;
  message: string;
  details?: Record<string, string[]>;
  /** Logged, never sent to the client. */
  internal?: unknown;
}

/**
 * The single place an error becomes an HTTP response (spec §21).
 *
 * Two rules:
 *   1. The response shape is identical for every failure.
 *   2. Nothing unexpected leaks. Unrecognised errors become a generic 500 with
 *      the detail written to the log against the request id.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly isProduction: boolean) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { id?: string }>();
    const requestId = request.id ?? 'unknown';

    const normalised = this.normalise(exception);

    if (normalised.status >= 500) {
      this.logger.error(
        {
          requestId,
          method: request.method,
          url: request.url,
          err: normalised.internal ?? exception,
        },
        `Unhandled error: ${normalised.message}`,
      );
    } else if (normalised.status === 401 || normalised.status === 403) {
      // Spec §28 — authentication and authorization failures are always logged.
      this.logger.warn({
        requestId,
        method: request.method,
        url: request.url,
        code: normalised.code,
      });
    }

    const body: ErrorResponse = {
      success: false,
      error: {
        code: normalised.code,
        message: normalised.message,
        ...(normalised.details ? { details: normalised.details } : {}),
      },
      meta: { timestamp: new Date().toISOString(), requestId },
    };

    response.status(normalised.status).json(body);
  }

  private normalise(exception: unknown): NormalisedError {
    if (exception instanceof AppException) {
      return {
        status: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        ...(exception.details ? { details: exception.details } : {}),
      };
    }

    if (exception instanceof ThrottlerException) {
      return {
        status: HttpStatus.TOO_MANY_REQUESTS,
        code: ERROR_CODES.RATE_LIMITED,
        message: 'Too many requests. Please slow down and try again shortly.',
      };
    }

    // A missing tenant context is always a bug in our code, never the client's
    // fault. It must surface as a 500 with no detail — the message names
    // internal helpers and would be a roadmap for an attacker.
    if (exception instanceof TenantContextMissingError) {
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'An unexpected error occurred.',
        internal: exception,
      };
    }

    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ERROR_CODES.INTERNAL_ERROR,
      message: this.isProduction
        ? 'An unexpected error occurred.'
        : ((exception as Error)?.message ?? 'An unexpected error occurred.'),
      internal: exception,
    };
  }

  private fromHttpException(exception: HttpException): NormalisedError {
    const status = exception.getStatus();
    const payload = exception.getResponse();

    // ValidationPipe emits { message: string[], error, statusCode }.
    if (typeof payload === 'object' && payload !== null) {
      const record = payload as Record<string, unknown>;

      if (Array.isArray(record['message'])) {
        return {
          status,
          code: ERROR_CODES.VALIDATION_ERROR,
          message: 'Request validation failed.',
          details: { _: record['message'] as string[] },
        };
      }

      if (typeof record['code'] === 'string') {
        return {
          status,
          code: record['code'] as ErrorCode,
          message: String(record['message'] ?? exception.message),
          ...(record['details'] ? { details: record['details'] as Record<string, string[]> } : {}),
        };
      }
    }

    return { status, code: this.codeForStatus(status), message: exception.message };
  }

  private codeForStatus(status: number): ErrorCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ERROR_CODES.VALIDATION_ERROR;
      case HttpStatus.UNAUTHORIZED:
        return ERROR_CODES.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ERROR_CODES.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ERROR_CODES.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ERROR_CODES.CONFLICT;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ERROR_CODES.RATE_LIMITED;
      default:
        return ERROR_CODES.INTERNAL_ERROR;
    }
  }
}
