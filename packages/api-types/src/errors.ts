/**
 * Canonical API error codes.
 *
 * This is the single source of truth. The API throws these, the web client
 * switches on them, and the Android client (Phase 1b) mirrors them as a sealed
 * class. Adding a code here without handling it on the clients is a compile
 * error on web, which is the point.
 */
export const ERROR_CODES = {
  // --- auth / identity -------------------------------------------------------
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  /** A revoked refresh token was replayed. The whole session family is killed. */
  TOKEN_REUSE_DETECTED: 'TOKEN_REUSE_DETECTED',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  ORGANIZATION_SELECTION_REQUIRED: 'ORGANIZATION_SELECTION_REQUIRED',

  // --- tenancy ---------------------------------------------------------------
  ORGANIZATION_NOT_FOUND: 'ORGANIZATION_NOT_FOUND',
  ORGANIZATION_SUSPENDED: 'ORGANIZATION_SUSPENDED',
  MEMBERSHIP_NOT_FOUND: 'MEMBERSHIP_NOT_FOUND',
  /** Internal: tenant context was missing where it was required. Never leaks details. */
  TENANT_CONTEXT_MISSING: 'TENANT_CONTEXT_MISSING',

  // --- CRM (Phase 2+) --------------------------------------------------------
  LEAD_NOT_FOUND: 'LEAD_NOT_FOUND',
  DUPLICATE_LEAD: 'DUPLICATE_LEAD',
  FOLLOW_UP_NOT_FOUND: 'FOLLOW_UP_NOT_FOUND',
  FOLLOW_UP_REQUIRED: 'FOLLOW_UP_REQUIRED',
  INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_ALREADY_EXISTS: 'USER_ALREADY_EXISTS',

  // --- organization administration (Phase 7) ---------------------------------
  /**
   * The action would leave the organization with nobody able to administer it.
   * Refused for removal, deactivation, demotion and leaving alike.
   */
  LAST_ADMINISTRATOR: 'LAST_ADMINISTRATOR',
  /**
   * The member still owns active leads or open follow-ups. Offboarding must
   * name a colleague to take the work over, or it would be orphaned.
   */
  REASSIGNMENT_REQUIRED: 'REASSIGNMENT_REQUIRED',

  // --- platform --------------------------------------------------------------
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  PLAN_LIMIT_EXCEEDED: 'PLAN_LIMIT_EXCEEDED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
