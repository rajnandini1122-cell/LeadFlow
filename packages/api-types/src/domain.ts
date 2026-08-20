/**
 * Domain enums shared across API, web, and (Phase 1b) Android.
 *
 * These mirror the Postgres enums defined in prisma/schema.prisma. Keep them in
 * sync — the API's `packages/api-types` build is what web compiles against, so a
 * drift here shows up as a type error rather than a runtime surprise.
 */

export const ROLE_KEYS = ['OWNER', 'ADMIN', 'MANAGER', 'SALES_REP'] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

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
