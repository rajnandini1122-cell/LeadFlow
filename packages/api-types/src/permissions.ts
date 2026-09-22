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

  ACCOUNT_VIEW: 'account.view',
  ACCOUNT_CREATE: 'account.create',
  ACCOUNT_UPDATE: 'account.update',
  /** Merging is destructive and irreversible, so it is separate from update. */
  ACCOUNT_MERGE: 'account.merge',
  /**
   * Reclassifying a relationship — PROSPECT to CUSTOMER, or a customer to
   * former. Separate from ACCOUNT_UPDATE because it is what every retention
   * and acquisition figure is counted from, so changing it rewrites reported
   * history in a way that editing an address does not.
   */
  ACCOUNT_STATUS_CHANGE: 'account.status.change',

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

  /**
   * Sales teams.
   *
   * A noun of their own rather than a stretch of `org.update`, because every
   * other noun in this catalogue has its own verbs and teams will shortly be
   * what assignment rules are written against. Reading is separated from
   * managing on the same line USER_VIEW and USER_UPDATE already draw: a
   * manager needs to see the structure they work in; restructuring it is
   * administration.
   */
  TEAM_VIEW: 'team.view',
  TEAM_MANAGE: 'team.manage',

  /**
   * Assignment rules — which team handles which work.
   *
   * Separate from team.manage, and not an overload of it, because they are
   * materially different powers: staffing a team decides who does the work,
   * while the routing table decides which customers reach which team at all.
   * Somebody trusted to add a colleague to Pune Sales is not automatically
   * trusted to send every website enquiry there.
   */
  ASSIGNMENT_RULE_VIEW: 'assignment_rule.view',
  ASSIGNMENT_RULE_MANAGE: 'assignment_rule.manage',

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
  PERMISSIONS.ACCOUNT_VIEW,
  /*
   * A rep creating a lead for a company nobody has dealt with before must be
   * able to record that company. Withholding this would mean either a lead
   * with no customer attached, or a rep waiting on a manager mid-call — and
   * the first is how the free-text company field became unusable in the first
   * place. Duplicate candidates are surfaced on create, so the risk this
   * carries is a suggestion, not a silent second record.
   */
  PERMISSIONS.ACCOUNT_CREATE,
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
  PERMISSIONS.ACCOUNT_UPDATE,
  PERMISSIONS.ACCOUNT_STATUS_CHANGE,
  PERMISSIONS.FOLLOW_UP_VIEW_TEAM,
  PERMISSIONS.USER_VIEW,
  // Sees the teams and who is in them. Cannot restructure them -- being
  // responsible for a team is a business role, not an administrative one.
  PERMISSIONS.TEAM_VIEW,
  // Sees how work is routed -- a manager whose team stops receiving enquiries
  // needs to be able to find out why. Changing it is administration.
  PERMISSIONS.ASSIGNMENT_RULE_VIEW,
  PERMISSIONS.DASHBOARD_VIEW_TEAM,
  PERMISSIONS.REPORT_VIEW,
];

const ADMIN_PERMISSIONS: Permission[] = [
  ...MANAGER_PERMISSIONS,
  PERMISSIONS.LEAD_VIEW_ALL,
  PERMISSIONS.LEAD_DELETE,
  PERMISSIONS.CONTACT_MERGE,
  PERMISSIONS.ACCOUNT_MERGE,
  PERMISSIONS.LEAD_IMPORT,
  PERMISSIONS.USER_INVITE,
  PERMISSIONS.USER_UPDATE,
  PERMISSIONS.USER_SUSPEND,
  PERMISSIONS.USER_REMOVE,
  PERMISSIONS.ROLE_ASSIGN,
  PERMISSIONS.TEAM_MANAGE,
  PERMISSIONS.ASSIGNMENT_RULE_MANAGE,
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
