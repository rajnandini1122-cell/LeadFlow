import { HttpException, HttpStatus } from '@nestjs/common';
import { ERROR_CODES, type ErrorCode } from '@idea001/api-types';

/**
 * Every deliberate error in the application is one of these.
 *
 * Carrying an explicit `code` means clients switch on a stable identifier
 * rather than parsing human-readable text, and it keeps the wire format
 * consistent without controllers thinking about it.
 */
export class AppException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    status: HttpStatus,
    readonly details?: Record<string, string[]>,
  ) {
    super({ code, message, details }, status);
  }

  static unauthorized(message = 'Authentication is required.'): AppException {
    return new AppException(ERROR_CODES.UNAUTHORIZED, message, HttpStatus.UNAUTHORIZED);
  }

  static invalidCredentials(): AppException {
    // Deliberately identical whether the email is unknown or the password is
    // wrong — distinguishing them turns login into a user-enumeration oracle.
    return new AppException(
      ERROR_CODES.INVALID_CREDENTIALS,
      'Email or password is incorrect.',
      HttpStatus.UNAUTHORIZED,
    );
  }

  static tokenExpired(): AppException {
    return new AppException(
      ERROR_CODES.TOKEN_EXPIRED,
      'Session has expired. Please sign in again.',
      HttpStatus.UNAUTHORIZED,
    );
  }

  static tokenInvalid(): AppException {
    return new AppException(
      ERROR_CODES.TOKEN_INVALID,
      'Invalid authentication token.',
      HttpStatus.UNAUTHORIZED,
    );
  }

  static tokenReuseDetected(): AppException {
    return new AppException(
      ERROR_CODES.TOKEN_REUSE_DETECTED,
      'This session has been revoked for security reasons. Please sign in again.',
      HttpStatus.UNAUTHORIZED,
    );
  }

  static forbidden(message = 'You do not have permission to perform this action.'): AppException {
    return new AppException(ERROR_CODES.FORBIDDEN, message, HttpStatus.FORBIDDEN);
  }

  static accountSuspended(): AppException {
    return new AppException(
      ERROR_CODES.ACCOUNT_SUSPENDED,
      'This account has been suspended.',
      HttpStatus.FORBIDDEN,
    );
  }

  static organizationSuspended(): AppException {
    return new AppException(
      ERROR_CODES.ORGANIZATION_SUSPENDED,
      'This organization is suspended. Contact your administrator.',
      HttpStatus.FORBIDDEN,
    );
  }

  /**
   * A resource that either does not exist, or belongs to another tenant.
   *
   * These two cases MUST be indistinguishable. Returning 403 for another
   * tenant's id would confirm the id exists, turning the endpoint into an
   * enumeration oracle. 404 leaks nothing.
   */
  static notFound(code: ErrorCode, message: string): AppException {
    return new AppException(code, message, HttpStatus.NOT_FOUND);
  }

  static leadNotFound(): AppException {
    return AppException.notFound(ERROR_CODES.LEAD_NOT_FOUND, 'Lead not found.');
  }

  static userNotFound(): AppException {
    return AppException.notFound(ERROR_CODES.USER_NOT_FOUND, 'User not found.');
  }

  static organizationNotFound(): AppException {
    return AppException.notFound(ERROR_CODES.ORGANIZATION_NOT_FOUND, 'Organization not found.');
  }

  static validation(message: string, details?: Record<string, string[]>): AppException {
    return new AppException(
      ERROR_CODES.VALIDATION_ERROR,
      message,
      HttpStatus.BAD_REQUEST,
      details,
    );
  }

  static conflict(code: ErrorCode, message: string): AppException {
    return new AppException(code, message, HttpStatus.CONFLICT);
  }

  static internal(message = 'An unexpected error occurred.'): AppException {
    return new AppException(ERROR_CODES.INTERNAL_ERROR, message, HttpStatus.INTERNAL_SERVER_ERROR);
  }
}
