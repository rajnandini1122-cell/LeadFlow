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
