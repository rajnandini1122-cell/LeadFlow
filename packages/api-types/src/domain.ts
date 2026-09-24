/**
 * Domain enums shared across API, web, and (Phase 1b) Android.
 *
 * These mirror the Postgres enums defined in prisma/schema.prisma. Keep them in
 * sync — the API's `packages/api-types` build is what web compiles against, so a
 * drift here shows up as a type error rather than a runtime surprise.
 */

/**
 * The roles a TENANT may assign.
 *
 * This list is what invite forms, role-change endpoints and their DTOs
 * validate against, so it is deliberately the tenant-assignable set and not
 * simply "every role in the enum". PLATFORM_OWNER is excluded for exactly that
 * reason — see PLATFORM_ROLE_KEY below.
 */
export const ROLE_KEYS = ['OWNER', 'ADMIN', 'MANAGER', 'SALES_REP'] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

/**
 * CRAVION's own platform administrator, and the one role no tenant can grant.
 *
 * Kept OUT of `ROLE_KEYS` on purpose. Every place that lets somebody choose a
 * role — the invite DTO, the role-change endpoint, the member dropdown —
 * validates against that list, so excluding it here is what makes
 * "PLATFORM_OWNER cannot be assigned through ordinary tenant APIs" a property
 * of the types rather than a rule somebody has to remember. Adding it to
 * ROLE_KEYS would put it in a dropdown.
 *
 * It exists in the database enum and in the permission matrix, because it is a
 * real system role that reference bootstrap must create. It simply is not
 * something a customer can hand out.
 */
export const PLATFORM_ROLE_KEY = 'PLATFORM_OWNER' as const;
export type PlatformRoleKey = typeof PLATFORM_ROLE_KEY;

/**
 * Every role the database enum holds: the tenant-assignable ones plus the
 * platform role. Use this for anything that must cover all of them — the
 * permission matrix, reference bootstrap — and `ROLE_KEYS` for anything a
 * tenant chooses from.
 */
export const ALL_ROLE_KEYS = [...ROLE_KEYS, PLATFORM_ROLE_KEY] as const;
export type AnyRoleKey = (typeof ALL_ROLE_KEYS)[number];

/** Whether a role is CRAVION's platform administrator. */
export function isPlatformRole(role: AnyRoleKey): role is PlatformRoleKey {
  return role === PLATFORM_ROLE_KEY;
}

/**
 * What an organization IS, as opposed to what state it is in.
 *
 *   CUSTOMER  a paying (or trialling) tenant. Every organization created by
 *             self-service registration.
 *   INTERNAL  CRAVION operating the platform. Exactly one may exist, enforced
 *             by a partial unique index rather than by convention.
 *
 * Separate from `OrganizationStatus`, which is ACTIVE/TRIAL/SUSPENDED — a
 * lifecycle position. An internal organization has a status too.
 *
 * An EXPLICIT marker, and that is the requirement. Recognising the platform
 * operator by its name, its slug, an email domain or a UUID compiled into the
 * source would all be guesses that a rename, a typo or a second deployment
 * quietly breaks — and the thing being guessed at is "may this account
 * administer every customer".
 */
export const ORGANIZATION_TYPES = ['CUSTOMER', 'INTERNAL'] as const;
export type OrganizationType = (typeof ORGANIZATION_TYPES)[number];

/** Whether this organization is CRAVION's own. */
export function isPlatformOrganization(type: OrganizationType): boolean {
  return type === 'INTERNAL';
}

/**
 * Fixed pipeline (spec §8). Deliberately NOT configurable in the MVP —
 * a custom pipeline builder is on the exclusion list (§31).
 */
export const LEAD_STATUSES = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'FOLLOW_UP',
  'QUOTATION_SENT',
  'NEGOTIATION',
  'WON',
  'LOST',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Terminal statuses are the ONLY ones exempt from the next-follow-up rule. */
export const TERMINAL_LEAD_STATUSES = ['WON', 'LOST'] as const satisfies readonly LeadStatus[];

export function isTerminalLeadStatus(status: LeadStatus): boolean {
  return (TERMINAL_LEAD_STATUSES as readonly LeadStatus[]).includes(status);
}

export const LEAD_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type LeadPriority = (typeof LEAD_PRIORITIES)[number];

export const FOLLOW_UP_STATUSES = [
  'UPCOMING',
  'DUE',
  'OVERDUE',
  'COMPLETED',
  'SKIPPED',
  'CANCELLED',
] as const;
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number];

export const ACTIVITY_TYPES = [
  'LEAD_CREATED',
  'LEAD_UPDATED',
  'LEAD_ASSIGNED',
  'LEAD_REASSIGNED',
  'CALL_COMPLETED',
  'CALL_NOT_ANSWERED',
  'CALL_BACK_LATER',
  'WHATSAPP_OPENED',
  'WHATSAPP_SENT',
  'WHATSAPP_DELIVERED',
  'WHATSAPP_READ',
  'WHATSAPP_RECEIVED',
  'NOTE_ADDED',
  'STATUS_CHANGED',
  'FOLLOW_UP_CREATED',
  'FOLLOW_UP_COMPLETED',
  'FOLLOW_UP_RESCHEDULED',
  'LEAD_WON',
  'LEAD_LOST',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const NOTIFICATION_TYPES = [
  'FOLLOW_UP_DUE',
  'FOLLOW_UP_OVERDUE',
  'NEW_LEAD_ASSIGNED',
  'LEAD_REASSIGNED',
  'MANAGER_ALERT',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const USER_STATUSES = ['ACTIVE', 'INVITED', 'SUSPENDED', 'REMOVED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const ORGANIZATION_STATUSES = ['TRIAL', 'ACTIVE', 'SUSPENDED'] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];
