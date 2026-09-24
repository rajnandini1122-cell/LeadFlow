import type {
  AnyRoleKey,
  OrganizationStatus,
  OrganizationType,
  RoleKey,
  UserStatus,
} from './domain';
import type { EntitlementSource } from './subscriptions';
import type { Permission } from './permissions';

// -----------------------------------------------------------------------------
// Auth
// -----------------------------------------------------------------------------

export interface LoginRequest {
  email: string;
  password: string;
  /**
   * Which organization to sign in to, when the account belongs to several and
   * the first attempt returned `requiresOrganizationSelection`.
   *
   * Named `targetOrganizationId`, NOT `organizationId`, and the name is
   * load-bearing: `StripTenantFieldsInterceptor` deletes any field called
   * `organizationId` from every request body before a controller sees it. That
   * rule has no exemptions on purpose, so a field that needs to survive it must
   * not use the forbidden name.
   *
   * It was called `organizationId` until it broke multi-organization login
   * outright — the choice was stripped in flight, the server saw an
   * unresolved account again, and the chooser re-rendered forever. It is a
   * SELECTOR among organizations the caller already belongs to, never an
   * assertion of scope: the server re-reads live membership and refuses
   * anything else. `SwitchOrganizationDto` uses the same name for the same
   * reason.
   */
  targetOrganizationId?: string;
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
  /** May be PLATFORM_OWNER: this describes a real membership, not a choice. */
  role: AnyRoleKey;
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
  /** The signed-in user's role. PLATFORM_OWNER identifies CRAVION's operator. */
  role: AnyRoleKey;
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
  role: AnyRoleKey;
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
  /**
   * The RESOLVED territory this matches. Null means anywhere.
   *
   * A territory, never a city or a pincode: geography is turned into this by
   * the territory resolver before any rule is consulted.
   */
  territory: { id: string; name: string; status: TerritoryStatus } | null;
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
  /** A territory id from GET /territories. Never raw geography. */
  territoryId?: string;
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
  territoryId?: string | null;
  targetTeamId?: string;
  status?: AssignmentRuleStatus;
}

/**
 * The facts a piece of work carries, for a preview.
 *
 * Geography arrives RAW here and nowhere else in the routing path: the preview
 * resolves it to a territory first, exactly as the phase that converts an
 * enquiry into a lead will, so what an administrator tests is what production
 * will do rather than a simplified version of it.
 */
export interface AssignmentPreviewRequest {
  source?: string;
  productId?: string;
  country?: string;
  state?: string;
  city?: string;
  postalCode?: string;
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
  /**
   * What the geography resolved to before any rule was consulted.
   *
   * Null when no location was supplied or none of it is covered. Shown rather
   * than hidden, because "no rule matched" and "the pincode belongs to no
   * territory" are different problems with different fixes.
   */
  territory: { id: string; name: string } | null;
}

// --- territories -------------------------------------------------------------

export const TERRITORY_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type TerritoryStatus = (typeof TERRITORY_STATUSES)[number];

export const TERRITORY_COVERAGE_TYPES = ['COUNTRY', 'STATE', 'CITY', 'POSTAL_CODE'] as const;
export type TerritoryCoverageType = (typeof TERRITORY_COVERAGE_TYPES)[number];

/** One explicit geographic selector owned by a territory. */
export interface TerritoryCoverageView {
  id: string;
  type: TerritoryCoverageType;
  /** ISO 3166-1 alpha-2. */
  countryCode: string;
  state: string | null;
  city: string | null;
  postalCode: string | null;
  /** The selector in words, e.g. "Pune, Maharashtra (IN)". */
  label: string;
  createdAt: string;
}

/**
 * A named geographic scope.
 *
 * It has no team and no members. Which team handles a territory is an
 * assignment rule, so that there is exactly one routing authority; who in that
 * team may take the work is team membership, so that there is exactly one
 * record of a person.
 */
export interface TerritoryListItem {
  id: string;
  name: string;
  description: string | null;
  status: TerritoryStatus;
  /** Live selectors only — removed ones are history, not coverage. */
  coverageCount: number;
  /** A few selectors in words, for the list. Empty when there are none. */
  coverageSummary: string;
  createdAt: string;
  updatedAt: string;
}

export interface TerritoryDetail extends TerritoryListItem {
  coverage: TerritoryCoverageView[];
}

export interface CreateTerritoryRequest {
  name: string;
  description?: string;
}

export interface UpdateTerritoryRequest {
  name?: string;
  description?: string | null;
  status?: TerritoryStatus;
}

/** Raw geography, normalised and keyed by the server. */
export interface AddTerritoryCoverageRequest {
  type: TerritoryCoverageType;
  country: string;
  state?: string;
  city?: string;
  postalCode?: string;
}

export interface ResolveTerritoryRequest {
  country?: string;
  state?: string;
  city?: string;
  postalCode?: string;
}

export const TERRITORY_RESOLUTIONS = ['MATCHED', 'NO_MATCH'] as const;
export type TerritoryResolutionDecision = (typeof TERRITORY_RESOLUTIONS)[number];

/**
 * Where a location resolves to, and on the strength of which selector.
 *
 * There is no AMBIGUOUS outcome, because there is no way to reach one: a
 * partial unique index gives every place at most one live owner per
 * organization, and the specificity order is fixed. Resolution is read-only —
 * asking where an address would go never changes where anything goes.
 */
export interface TerritoryResolution {
  decision: TerritoryResolutionDecision;
  territory: { id: string; name: string } | null;
  /** Which configured selector answered. Names the type, not the customer. */
  matchedCoverage: { id: string; type: TerritoryCoverageType; label: string } | null;
}

// --- website intake operations -----------------------------------------------

export const INTAKE_STATUSES = [
  'RECEIVED',
  'DUPLICATE',
  'PROCESSED',
  'FAILED',
  'BLOCKED',
] as const;
export type IntakeStatus = (typeof INTAKE_STATUSES)[number];

/**
 * An enquiry in the operations queue.
 *
 * Deliberately NOT a raw dump of the submission. What an operator needs is
 * whether it became work and, if not, why — so the routing outcome is as
 * prominent as the customer's name, and the signature, the payload hash and
 * the event id are absent entirely.
 */
export interface IntegrationIntakeListItem {
  id: string;
  source: string;
  status: IntakeStatus;
  receivedAt: string;
  name: string | null;
  company: string | null;
  /** What the customer asked for, in their words. Never a catalogue product. */
  productInterest: string | null;
  sourcePage: string | null;
  /** A short code such as NO_MATCH. Null once converted. */
  processingCode: string | null;
  /** The same thing in words, for a person. */
  failureReason: string | null;
  processingAttempts: number;
  lastProcessingAt: string | null;
  processedAt: string | null;
  territory: { id: string; name: string } | null;
  rule: { id: string; name: string } | null;
  team: { id: string; name: string } | null;
  assignedTo: { id: string; fullName: string } | null;
  createdLead: { id: string; leadNumber: string } | null;
}

export interface IntegrationIntakeDetail extends IntegrationIntakeListItem {
  email: string | null;
  phone: string | null;
  country: string | null;
  /** The customer's own words. The reason this row is the source record. */
  message: string | null;
  /**
   * What this enquiry looked like a duplicate of.
   *
   * Ids only, and no relation behind them: these are a SIGNAL that a person
   * reviews, not a link the system acted on. Nothing existing was changed on
   * the strength of them.
   */
  matchedContactId: string | null;
  matchedLeadId: string | null;
}

export interface IntegrationIntakeQuery {
  status?: IntakeStatus;
  source?: string;
  /** ISO instants. Inclusive lower bound, exclusive upper. */
  receivedFrom?: string;
  receivedTo?: string;
  limit?: number;
  offset?: number;
}

export interface IntegrationIntakePage {
  items: IntegrationIntakeListItem[];
  total: number;
}

/**
 * What a retry did.
 *
 * Retry means "evaluate the SAME durable enquiry again", never "replace what
 * the customer sent" — there is no payload in the request, and none accepted.
 */
export const INTAKE_RETRY_RESULTS = [
  'CONVERTED',
  'BLOCKED',
  'DUPLICATE',
  'ALREADY_PROCESSED',
  'SKIPPED',
] as const;
export type IntakeRetryResult = (typeof INTAKE_RETRY_RESULTS)[number];

export interface IntakeRetryResponse {
  result: IntakeRetryResult;
  intake: IntegrationIntakeDetail;
}

/**
 * The website enquiry a lead came from.
 *
 * Read through the intake relation rather than copied onto the lead: the
 * message can be four thousand characters, and one source record is easier to
 * redact than a copy in every table that found it interesting.
 */
export interface LeadSourceIntake {
  id: string;
  source: string;
  receivedAt: string;
  sourcePage: string | null;
  message: string | null;
  productInterest: string | null;
  territory: { id: string; name: string } | null;
  rule: { id: string; name: string } | null;
  team: { id: string; name: string } | null;
}

// -----------------------------------------------------------------------------
// Platform console (CRAVION only)
// -----------------------------------------------------------------------------

/**
 * An organization as the PLATFORM operator sees it.
 *
 * Identity, lifecycle and size. Deliberately no business data: a platform
 * operator needs to know a tenant exists, whether it is active and how large it
 * is; reading their pipeline is a different act that this contract does not
 * provide for.
 */
export interface PlatformOrganizationView {
  id: string;
  name: string;
  slug: string;
  status: string;
  organizationType: OrganizationType;
  country: string;
  createdAt: string;
  memberCount: number;
  leadCount: number;
  /** Why this organization may use the product, in one place. */
  entitlement: {
    source: EntitlementSource;
    /** Null for the platform organization — it has no subscription. */
    subscriptionStatus: string | null;
    planCode: string | null;
  };
}
