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
}

export interface UpdateOrganizationRequest {
  name?: string;
  timezone?: string;
  settings?: Partial<OrganizationSettings>;
}
