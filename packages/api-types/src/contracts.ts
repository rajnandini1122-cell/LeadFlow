import type { OrganizationStatus, RoleKey, UserStatus } from './domain';
import type { Permission } from './permissions';

// -----------------------------------------------------------------------------
// Auth
// -----------------------------------------------------------------------------

export interface LoginRequest {
  email: string;
  password: string;
  /**
   * Only required when the user belongs to more than one organization and the
   * first login attempt returned `requiresOrganizationSelection`.
   */
  organizationId?: string;
  deviceId?: string;
  deviceName?: string;
  platform?: 'WEB' | 'ANDROID' | 'IOS';
}

export interface TokenPair {
  accessToken: string;
  /**
   * Opaque 256-bit token. On web this is delivered as an httpOnly cookie and is
   * NOT present in the JSON body; Android reads it from here and stores it in
   * EncryptedSharedPreferences.
   */
  refreshToken?: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  role: RoleKey;
}

/**
 * A login either succeeds outright or asks which organization to enter.
 * Modelled as a discriminated union so clients cannot forget the second case.
 */
export type LoginResponse =
  | { requiresOrganizationSelection: false; tokens: TokenPair; user: AuthenticatedUser }
  | { requiresOrganizationSelection: true; organizations: OrganizationSummary[] };

export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
  mobile: string | null;
  avatarUrl: string | null;
  organization: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
    currency: string;
    /** BCP 47 — drives all client-side number and date formatting. */
    locale: string;
    /** ISO 3166-1 alpha-2 — default dialling region for phone entry. */
    country: string;
    status: OrganizationStatus;
  };
  role: RoleKey;
  permissions: Permission[];
}

export interface RefreshRequest {
  /** Omitted on web — read from the httpOnly cookie instead. */
  refreshToken?: string;
}

// -----------------------------------------------------------------------------
// Users
// -----------------------------------------------------------------------------

export interface UserListItem {
  id: string;
  email: string;
  fullName: string;
  mobile: string | null;
  avatarUrl: string | null;
  role: RoleKey;
  status: UserStatus;
  joinedAt: string | null;
  lastLoginAt: string | null;
}

export interface InviteUserRequest {
  email: string;
  fullName: string;
  role: RoleKey;
  mobile?: string;
}

export interface InviteUserResponse {
  userId: string;
  /** Address for resend and revoke. The membership row IS the invitation. */
  invitationId: string;
  email: string;
  role: RoleKey;
  status: UserStatus;
  /**
   * Present in non-production only. In production the invite is emailed;
   * returning it in the API response would be a token-leak vector.
   */
  inviteToken?: string;
}

export interface UpdateUserRequest {
  fullName?: string;
  mobile?: string | null;
  role?: RoleKey;
  status?: UserStatus;
}

// -----------------------------------------------------------------------------
// Organization
// -----------------------------------------------------------------------------

export interface OrganizationDetail {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  currency: string;
  locale: string;
  country: string;
  status: OrganizationStatus;
  settings: OrganizationSettings;
  createdAt: string;
}

/**
 * Follow-up escalation thresholds live here, per spec §10: "build configuration
 * so escalation rules can later become tenant-specific". The Phase 6 worker
 * reads these rather than hardcoded constants.
 */
export interface OrganizationSettings {
  followupReminderMinutes: number;
  followupOverdueMinutes: number;
  escalateToManager: boolean;
  workingHoursStart: string;
  workingHoursEnd: string;
  /** Tenant-defined lead sources; empty means use the neutral built-in list. */
  leadSources: string[];
  /**
   * Whether omnichannel capture is switched on for this tenant.
   *
   * Read-only from the client's side: it is exposed so the app can hide a
   * feature the organization has not enabled, and NOT included in
   * UpdateOrganizationRequest, because turning capture on is a decision that
   * belongs with connecting a channel rather than with editing settings.
   */
  omnichannelEnabled: boolean;
  /**
   * Whether ordinary sales users may browse conversations nobody owns.
   *
   * Editable, unlike omnichannelEnabled: it is a policy choice about who sees
   * unclaimed customer enquiries, and it belongs with the organization's other
   * settings.
   */
  sharedUnassignedQueue: boolean;
}

export interface UpdateOrganizationRequest {
  name?: string;
  timezone?: string;
  settings?: Partial<OrganizationSettings>;
}

// -----------------------------------------------------------------------------
// Registration, invitations and organization switching (Phase 2A)
// -----------------------------------------------------------------------------

export interface RegisterRequest {
  organizationName: string;
  /** Optional — derived from the organization name when omitted. */
  organizationSlug?: string;
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  timezone?: string;
  currency?: string;
  country?: string;
}

export interface PendingInvitation {
  id: string;
  email: string;
  fullName: string;
  role: RoleKey;
  invitedBy: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface InvitationPreview {
  organizationName: string;
  role: RoleKey;
  email: string;
  /** True when the invitee already has an account and needs no new password. */
  hasAccount: boolean;
  expiresAt: string | null;
}

export interface AcceptInvitationRequest {
  firstName?: string;
  lastName?: string;
  password?: string;
}

/** One organization the signed-in user may act in. */
export interface MembershipSummary {
  id: string;
  name: string;
  slug: string;
  role: RoleKey;
  /** True for the organization the current access token is scoped to. */
  current: boolean;
}

// --- sales teams -------------------------------------------------------------

export const TEAM_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type TeamStatus = (typeof TEAM_STATUSES)[number];

/** A team as it appears in the list. */
export interface TeamListItem {
  id: string;
  name: string;
  description: string | null;
  status: TeamStatus;
  manager: TeamManagerSummary | null;
  /**
   * Members currently in the team whose organization membership is ACTIVE.
   *
   * Deliberately not "rows in team_members": a removed colleague and a
   * suspended one both still have history here, and counting them would
   * overstate every team the moment somebody leaves.
   */
  activeMemberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TeamManagerSummary {
  /** The organization MEMBERSHIP id — what the team actually references. */
  membershipId: string;
  userId: string;
  fullName: string;
  role: RoleKey;
}

export interface TeamDetail extends TeamListItem {
  members: TeamMemberView[];
}

/** One person's place in one team. */
export interface TeamMemberView {
  /** Identifies this membership row, for removal and toggling. */
  id: string;
  membershipId: string;
  userId: string;
  fullName: string;
  email: string;
  avatarUrl: string | null;
  role: RoleKey;
  /** The ORGANIZATION membership status. Authoritative over anything below. */
  status: UserStatus;
  assignmentEnabled: boolean;
  joinedAt: string;
  /**
   * Whether future automatic assignment may route work to this person.
   *
   * A derived answer, never stored: it needs the live organization membership
   * status, the role, the team's own status and assignmentEnabled together.
   * Storing it would mean a suspended colleague stayed "eligible" until
   * something remembered to recompute it.
   */
  eligibleForAssignment: boolean;
}

/** An organization member, with the teams they are in. For team management. */
export interface TeamAgentCandidate {
  membershipId: string;
  userId: string;
  fullName: string;
  email: string;
  avatarUrl: string | null;
  role: RoleKey;
  status: UserStatus;
  /** True when this role may receive automatically assigned work at all. */
  assignableRole: boolean;
  teams: { teamId: string; teamName: string; assignmentEnabled: boolean }[];
}

export interface CreateTeamRequest {
  name: string;
  description?: string;
  /** An organization member's USER id. Resolved to their membership server-side. */
  managerUserId?: string;
}

export interface UpdateTeamRequest {
  name?: string;
  description?: string | null;
  /** Null clears the manager; omitted leaves it alone. */
  managerUserId?: string | null;
  status?: TeamStatus;
}

export interface AddTeamMemberRequest {
  userId: string;
}

export interface UpdateTeamMemberRequest {
  assignmentEnabled: boolean;
}

// --- assignment rules --------------------------------------------------------

export const ASSIGNMENT_RULE_STATUSES = ['ACTIVE', 'PAUSED', 'ARCHIVED'] as const;
export type AssignmentRuleStatus = (typeof ASSIGNMENT_RULE_STATUSES)[number];

/** One routing rule: work that looks like THIS goes to THAT team. */
export interface AssignmentRuleView {
  id: string;
  name: string;
  description: string | null;
  status: AssignmentRuleStatus;
  /** Lower runs first. Unique among a tenant's active non-fallback rules. */
  priority: number;
  /** The lead source this matches, as the tenant writes it. Null means any. */
  source: string | null;
  /** The CANONICAL product, never free text. Null means any. */
  product: { id: string; name: string; sku: string } | null;
  /** Evaluated only when no specific rule matched. */
  isFallback: boolean;
  targetTeam: { id: string; name: string; status: string };
  createdAt: string;
  updatedAt: string;
}

export interface CreateAssignmentRuleRequest {
  name: string;
  description?: string;
  /** Omitted, the server places it after the current lowest-precedence rule. */
  priority?: number;
  source?: string;
  productId?: string;
  isFallback?: boolean;
  targetTeamId: string;
}

export interface UpdateAssignmentRuleRequest {
  name?: string;
  description?: string | null;
  priority?: number;
  /** Null clears the criterion, meaning "any". */
  source?: string | null;
  productId?: string | null;
  targetTeamId?: string;
  status?: AssignmentRuleStatus;
}

/** The facts a piece of work carries, for a preview. */
export interface AssignmentPreviewRequest {
  source?: string;
  productId?: string;
}

/**
 * What the evaluator decided, and why.
 *
 * MATCHED / FALLBACK_MATCHED say which rule answered — the distinction
 * matters, because falling through to the catch-all usually means the routing
 * table is missing a rule somebody meant to write.
 */
export const ASSIGNMENT_DECISIONS = [
  'MATCHED',
  'FALLBACK_MATCHED',
  'NO_MATCH',
  'NO_ELIGIBLE_AGENTS',
] as const;
export type AssignmentDecision = (typeof ASSIGNMENT_DECISIONS)[number];

export interface AssignmentPreviewResult {
  decision: AssignmentDecision;
  /** The rule that answered, when one did. */
  rule: { id: string; name: string; priority: number; isFallback: boolean } | null;
  team: { id: string; name: string } | null;
  /**
   * Who in that team could receive work right now.
   *
   * A POOL, never a choice. Picking the person is the job of the phase that
   * writes the lead, so that the selection and the write happen together —
   * and because territories may still narrow this pool first.
   */
  eligibleAgents: { membershipId: string; userId: string; fullName: string }[];
  eligibleAgentCount: number;
}
