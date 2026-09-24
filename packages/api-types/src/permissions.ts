import type { AnyRoleKey } from './domain';

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

  /**
   * Territories — the geography routing is written against.
   *
   * Its own noun rather than part of assignment_rule.manage, because the two
   * can be delegated separately and usually are: redrawing which pincodes
   * belong to which territory changes where every future enquiry from those
   * places lands, whether or not the person doing it may touch a single rule.
   * Read is separated from manage on the line the catalogue already draws — a
   * manager whose region stops receiving enquiries needs to see the map;
   * redrawing it is administration.
   */
  TERRITORY_VIEW: 'territory.view',
  TERRITORY_MANAGE: 'territory.manage',

  /**
   * The website intake queue — enquiries as they arrived, and what routing did
   * with them.
   *
   * An operations surface rather than a CRM one, which is why it is its own
   * noun. A row here may be an enquiry that became nobody's lead because no
   * rule matched it, so it is visible to the people who maintain the routing
   * table rather than to everyone with a pipeline. Managing means retrying a
   * blocked enquiry after fixing the configuration — never rewriting what the
   * customer sent.
   */
  INTEGRATION_INTAKE_VIEW: 'integration_intake.view',
  INTEGRATION_INTAKE_MANAGE: 'integration_intake.manage',

  DASHBOARD_VIEW_OWN: 'dashboard.view.own',
  DASHBOARD_VIEW_TEAM: 'dashboard.view.team',
  DASHBOARD_VIEW_ALL: 'dashboard.view.all',
  REPORT_VIEW: 'report.view',

  SUBSCRIPTION_VIEW: 'subscription.view',
  SUBSCRIPTION_MANAGE: 'subscription.manage',

  /*
   * PLATFORM permissions — CRAVION operating LeadFlow, not a customer using it.
   *
   * Namespaced `platform.*` so the boundary is visible at a glance in a grant
   * table, an audit row and a guard. No tenant role holds any of these, and no
   * tenant API can grant one: they are absent from every ROLE_PERMISSION_MATRIX
   * entry except PLATFORM_OWNER's.
   *
   * Enumerated rather than expressed as a wildcard. The permission model has no
   * wildcard mechanism, and inventing one for the single most privileged role in
   * the system would mean the first use of `*` in this codebase granted
   * everything that will ever be added, including permissions written years
   * from now by somebody who never considered the platform role.
   */
  PLATFORM_CONFIG_VIEW: 'platform.config.view',
  PLATFORM_CONFIG_MANAGE: 'platform.config.manage',
  /** Read the tenant list and one tenant's status. Never their business data. */
  PLATFORM_ORGANIZATION_VIEW: 'platform.organization.view',
  /** Suspend, reactivate or retire a customer organization. */
  PLATFORM_ORGANIZATION_MANAGE: 'platform.organization.manage',
  PLATFORM_SUBSCRIPTION_VIEW: 'platform.subscription.view',
  PLATFORM_SUBSCRIPTION_MANAGE: 'platform.subscription.manage',
  /** Read platform-level audit history, including cross-tenant actions. */
  PLATFORM_AUDIT_VIEW: 'platform.audit.view',
  /** Manage CRAVION's own internal staff accounts. */
  PLATFORM_USER_MANAGE: 'platform.user.manage',
  PLATFORM_INTEGRATION_MANAGE: 'platform.integration.manage',
  /** Readiness, worker heartbeat, queue depth — operating the deployment. */
  PLATFORM_OPERATIONS_VIEW: 'platform.operations.view',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/**
 * The platform permissions, as a set.
 *
 * Derived from the catalogue by prefix rather than listed a second time, so a
 * new `platform.*` permission cannot be added and then forgotten here — which
 * would leave PLATFORM_OWNER without it and the feature quietly unreachable.
 */
export const PLATFORM_PERMISSIONS: Permission[] = Object.values(PERMISSIONS).filter(
  (key): key is Permission => key.startsWith('platform.'),
);

/** Whether a permission is a platform-level one. No tenant role holds these. */
export function isPlatformPermission(permission: string): boolean {
  return permission.startsWith('platform.');
}

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
  // Sees the map their routing is written against, for the same reason.
  PERMISSIONS.TERRITORY_VIEW,
  // Sees why enquiries did or did not reach their team. Retrying one is
  // administration, because it depends on having fixed the configuration.
  PERMISSIONS.INTEGRATION_INTAKE_VIEW,
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
  PERMISSIONS.TERRITORY_MANAGE,
  PERMISSIONS.INTEGRATION_INTAKE_MANAGE,
  PERMISSIONS.ORG_UPDATE,
  PERMISSIONS.DASHBOARD_VIEW_ALL,
];

const OWNER_PERMISSIONS: Permission[] = [
  ...ADMIN_PERMISSIONS,
  PERMISSIONS.SUBSCRIPTION_VIEW,
  PERMISSIONS.SUBSCRIPTION_MANAGE,
];

/**
 * CRAVION's platform administrator.
 *
 * The platform permissions, PLUS the tenant OWNER set. The second half needs
 * saying: a platform owner also operates CRAVION's own internal organization as
 * an ordinary tenant — their leads, their team, their settings — and holding no
 * tenant permissions would mean the master account could administer every
 * customer but not use the product.
 *
 * What this does NOT do is grant access to another tenant's data. These
 * permissions are checked against the caller's own membership, and the Prisma
 * tenant scope still narrows every ordinary query to the organization they are
 * signed in to. Reaching another tenant requires an explicit platform-admin
 * repository running under an audited system scope — a permission is
 * permission to ask, never a change to what the scoper allows.
 */
const PLATFORM_OWNER_PERMISSIONS: Permission[] = [
  ...OWNER_PERMISSIONS,
  ...PLATFORM_PERMISSIONS,
];

/**
 * Seeded into role_permissions by prisma/reference-data.ts.
 *
 * Keyed by AnyRoleKey rather than RoleKey so PLATFORM_OWNER is covered: the
 * matrix has to describe every role the database enum holds, while the
 * tenant-assignable list stays shorter.
 */
export const ROLE_PERMISSION_MATRIX: Record<AnyRoleKey, Permission[]> = {
  OWNER: OWNER_PERMISSIONS,
  ADMIN: ADMIN_PERMISSIONS,
  MANAGER: MANAGER_PERMISSIONS,
  SALES_REP: SALES_REP_PERMISSIONS,
  PLATFORM_OWNER: PLATFORM_OWNER_PERMISSIONS,
};
