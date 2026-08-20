/**
 * Raised when tenant-scoped data access is attempted with no tenant context.
 *
 * This is always a programming error, never a user error, so it maps to a 500
 * and the detail never reaches the client. What matters is that it is a THROW:
 * the alternative — running the query unscoped — would silently return every
 * tenant's rows.
 */
export class TenantContextMissingError extends Error {
  override readonly name = 'TenantContextMissingError';

  constructor(message: string) {
    super(message);
  }
}
