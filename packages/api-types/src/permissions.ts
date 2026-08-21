import type { RoleKey } from './domain';

/**
 * Permission catalogue.
 *
 * Roles are a convenience over permissions, not a replacement for them. Guards
 * check permissions, so a future custom role needs no code change.
 */
export const PERMISSIONS = {
  LEAD_VIEW_OWN: 'lead.view.own',
  LEAD_VIEW_TEAM: 'lead.view.team',
  LEAD_VIEW_ALL: 'lead.view.all',
  LEAD_CREATE: 'lead.create',
  LEAD_UPDATE: 'lead.update',
  LEAD_DELETE: 'lead.delete',
  LEAD_ASSIGN: 'lead.assign',

  CONTACT_VIEW: 'contact.view',
  CONTACT_UPDATE: 'contact.update',
  /** Merging is destructive and irreversible, so it is separate from update. */
  CONTACT_MERGE: 'contact.merge',
  LEAD_IMPORT: 'lead.import',

  ACTIVITY_CREATE: 'activity.create',
  ACTIVITY_VIEW: 'activity.view',

  FOLLOW_UP_CREATE: 'followup.create',
  FOLLOW_UP_COMPLETE: 'followup.complete',
  FOLLOW_UP_VIEW_TEAM: 'followup.view.team',

  USER_VIEW: 'user.view',
  USER_INVITE: 'user.invite',
  USER_UPDATE: 'user.update',
  USER_SUSPEND: 'user.suspend',
  /** Soft removal from the organization. Separate from suspension on purpose. */
  USER_REMOVE: 'user.remove',
  ROLE_ASSIGN: 'role.assign',

  ORG_VIEW: 'org.view',
  ORG_UPDATE: 'org.update',

  DASHBOARD_VIEW_OWN: 'dashboard.view.own',
  DASHBOARD_VIEW_TEAM: 'dashboard.view.team',
  DASHBOARD_VIEW_ALL: 'dashboard.view.all',
  REPORT_VIEW: 'report.view',

  SUBSCRIPTION_VIEW: 'subscription.view',
  SUBSCRIPTION_MANAGE: 'subscription.manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const SALES_REP_PERMISSIONS: Permission[] = [
  PERMISSIONS.LEAD_VIEW_OWN,
  PERMISSIONS.LEAD_CREATE,
  PERMISSIONS.CONTACT_VIEW,
  PERMISSIONS.LEAD_UPDATE,
  PERMISSIONS.ACTIVITY_CREATE,
  PERMISSIONS.ACTIVITY_VIEW,
  PERMISSIONS.FOLLOW_UP_CREATE,
  PERMISSIONS.FOLLOW_UP_COMPLETE,
  PERMISSIONS.DASHBOARD_VIEW_OWN,
  PERMISSIONS.ORG_VIEW,
];

const MANAGER_PERMISSIONS: Permission[] = [
  ...SALES_REP_PERMISSIONS,
  PERMISSIONS.LEAD_VIEW_TEAM,
  PERMISSIONS.LEAD_ASSIGN,
  PERMISSIONS.CONTACT_UPDATE,
  PERMISSIONS.FOLLOW_UP_VIEW_TEAM,
  PERMISSIONS.USER_VIEW,
  PERMISSIONS.DASHBOARD_VIEW_TEAM,
  PERMISSIONS.REPORT_VIEW,
];

const ADMIN_PERMISSIONS: Permission[] = [
  ...MANAGER_PERMISSIONS,
  PERMISSIONS.LEAD_VIEW_ALL,
  PERMISSIONS.LEAD_DELETE,
  PERMISSIONS.CONTACT_MERGE,
  PERMISSIONS.LEAD_IMPORT,
  PERMISSIONS.USER_INVITE,
  PERMISSIONS.USER_UPDATE,
  PERMISSIONS.USER_SUSPEND,
  PERMISSIONS.USER_REMOVE,
  PERMISSIONS.ROLE_ASSIGN,
  PERMISSIONS.ORG_UPDATE,
  PERMISSIONS.DASHBOARD_VIEW_ALL,
];

const OWNER_PERMISSIONS: Permission[] = [
  ...ADMIN_PERMISSIONS,
  PERMISSIONS.SUBSCRIPTION_VIEW,
  PERMISSIONS.SUBSCRIPTION_MANAGE,
];

/** Seeded into role_permissions by prisma/seed.ts. */
export const ROLE_PERMISSION_MATRIX: Record<RoleKey, Permission[]> = {
  OWNER: OWNER_PERMISSIONS,
  ADMIN: ADMIN_PERMISSIONS,
  MANAGER: MANAGER_PERMISSIONS,
  SALES_REP: SALES_REP_PERMISSIONS,
};
