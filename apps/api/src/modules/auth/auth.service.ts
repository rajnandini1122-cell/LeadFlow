import { Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from '../../common/utils/uuid';
import type {
  AuthenticatedUser,
  LoginResponse,
  MembershipSummary,
  OrganizationSummary,
  TokenPair,
} from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import { AUDIT_ACTIONS, AuditRepository } from '../../common/audit/audit.repository';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { AuthRepository, type MembershipRecord } from './auth.repository';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { MembershipCacheService } from './membership-cache.service';
import { SessionService } from './session.service';
import type { LoginDto } from './dto/auth.dto';

export interface RequestMetadata {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

export interface LoginResult {
  response: LoginResponse;
  /** Present only on a completed login; the controller sets the cookie. */
  refreshToken?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly repository: AuthRepository,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly membershipCache: MembershipCacheService,
    private readonly audit: AuditRepository,
    private readonly sessions: SessionService,
  ) {}

  // ---------------------------------------------------------------------------
  // LOGIN
  // ---------------------------------------------------------------------------

  async login(dto: LoginDto, meta: RequestMetadata): Promise<LoginResult> {
    const user = await this.repository.findUserByEmail(dto.email);

    // Spend the same time whether or not the account exists, then fail with
    // the same message either way.
    if (!user?.passwordHash) {
      await this.passwords.verifyDummy(dto.password);
      await this.audit.record({
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        entityType: 'user',
        after: { email: dto.email, reason: 'unknown_account' },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      throw AppException.invalidCredentials();
    }

    const passwordValid = await this.passwords.verify(user.passwordHash, dto.password);
    if (!passwordValid) {
      await this.audit.record({
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        actorUserId: user.id,
        entityType: 'user',
        entityId: user.id,
        after: { reason: 'bad_password' },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      throw AppException.invalidCredentials();
    }

    if (user.status === 'SUSPENDED') throw AppException.accountSuspended();

    const memberships = await this.repository.findMembershipsForUser(user.id);
    const usable = memberships.filter(
      (m) => m.membershipStatus === 'ACTIVE' && m.organizationStatus !== 'SUSPENDED',
    );

    if (usable.length === 0) {
      // Correct credentials but no organization to enter. Not a credential
      // problem, so it gets its own message.
      throw AppException.forbidden(
        'Your account is not active in any organization. Contact your administrator.',
      );
    }

    const membership = this.selectMembership(usable, dto.organizationId);

    // Multiple organizations and no choice made — ask, do not guess.
    if (!membership) {
      const organizations: OrganizationSummary[] = usable.map((m) => ({
        id: m.organizationId,
        name: m.organizationName,
        slug: m.organizationSlug,
        role: m.role,
      }));
      return { response: { requiresOrganizationSelection: true, organizations } };
    }

    const { tokens, refreshToken } = await this.issueSession(membership, dto, meta);
    await this.repository.touchLastLogin(user.id);

    await this.audit.record({
      action: AUDIT_ACTIONS.LOGIN_SUCCESS,
      organizationId: membership.organizationId,
      actorUserId: user.id,
      entityType: 'user',
      entityId: user.id,
      after: { platform: dto.platform ?? 'WEB' },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return {
      response: {
        requiresOrganizationSelection: false,
        tokens,
        user: toAuthenticatedUser(membership, user),
      },
      refreshToken,
    };
  }

  /**
   * Resolves which organization the login is for.
   *
   * A requested id is honoured only if it appears in the user's own membership
   * list, so passing someone else's organization id yields nothing.
   */
  private selectMembership(
    usable: MembershipRecord[],
    requestedOrganizationId?: string,
  ): MembershipRecord | undefined {
    if (requestedOrganizationId) {
      const match = usable.find((m) => m.organizationId === requestedOrganizationId);
      if (!match) throw AppException.forbidden('You do not have access to that organization.');
      return match;
    }

    return usable.length === 1 ? usable[0] : undefined;
  }

  private async issueSession(
    membership: MembershipRecord,
    dto: LoginDto,
    meta: RequestMetadata,
  ): Promise<{ tokens: TokenPair; refreshToken: string }> {
    const familyId = uuidv7();
    const refresh = this.tokens.issueRefreshToken();

    const session = await this.repository.createSession({
      organizationId: membership.organizationId,
      userId: membership.userId,
      refreshTokenHash: refresh.hash,
      familyId,
      expiresAt: refresh.expiresAt,
      platform: dto.platform ?? 'WEB',
      deviceId: dto.deviceId,
      deviceName: dto.deviceName,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    const access = await this.tokens.issueAccessToken({
      sub: membership.userId,
      org: membership.organizationId,
      role: membership.role,
      sid: session.id,
    });

    return {
      tokens: {
        accessToken: access.token,
        expiresIn: access.expiresIn,
        tokenType: 'Bearer',
      },
      refreshToken: refresh.token,
    };
  }

  // ---------------------------------------------------------------------------
  // REFRESH — rotation with reuse detection
  // ---------------------------------------------------------------------------

  async refresh(
    rawRefreshToken: string,
    meta: RequestMetadata,
  ): Promise<{ tokens: TokenPair; refreshToken: string; user: AuthenticatedUser }> {
    const hash = this.tokens.hashRefreshToken(rawRefreshToken);
    const session = await this.repository.findSessionByTokenHash(hash);

    if (!session) throw AppException.tokenInvalid();

    // --- reuse detection ----------------------------------------------------
    // A revoked token being presented means it leaked: the legitimate client
    // already rotated past it, so whoever sent this is replaying a copy. We
    // cannot tell which party is which, so the entire family dies and everyone
    // signs in again.
    if (session.revokedAt) {
      const revokedCount = await this.repository.revokeFamily(session.familyId, 'REUSE_DETECTED');

      this.logger.error(
        {
          userId: session.userId,
          organizationId: session.organizationId,
          familyId: session.familyId,
          revokedCount,
        },
        'Refresh token reuse detected — entire session family revoked',
      );

      await this.audit.record({
        action: AUDIT_ACTIONS.TOKEN_REUSE_DETECTED,
        organizationId: session.organizationId,
        actorUserId: session.userId,
        entityType: 'session',
        entityId: session.id,
        after: { familyId: session.familyId, revokedCount },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      throw AppException.tokenReuseDetected();
    }

    if (session.expiresAt.getTime() <= Date.now()) throw AppException.tokenExpired();

    // Re-validate access on every refresh — a user suspended since login must
    // not be able to extend their session.
    const membership = await this.membershipCache.get(session.userId, session.organizationId);
    if (!membership || membership.membershipStatus !== 'ACTIVE') {
      await this.repository.revokeFamily(session.familyId, 'MEMBERSHIP_INACTIVE');
      throw AppException.forbidden('Your access to this organization has been removed.');
    }
    if (membership.organizationStatus === 'SUSPENDED') throw AppException.organizationSuspended();
    if (membership.userStatus === 'SUSPENDED') throw AppException.accountSuspended();

    const next = this.tokens.issueRefreshToken();
    const rotated = await this.repository.rotateSession({
      currentSessionId: session.id,
      organizationId: session.organizationId,
      userId: session.userId,
      newRefreshTokenHash: next.hash,
      familyId: session.familyId,
      expiresAt: next.expiresAt,
      platform: session.platform,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    const access = await this.tokens.issueAccessToken({
      sub: membership.userId,
      org: membership.organizationId,
      role: membership.role,
      sid: rotated.id,
    });

    const user = await this.repository.findUserById(membership.userId);
    if (!user) throw AppException.tokenInvalid();

    return {
      tokens: { accessToken: access.token, expiresIn: access.expiresIn, tokenType: 'Bearer' },
      refreshToken: next.token,
      user: toAuthenticatedUser(membership, user),
    };
  }

  // ---------------------------------------------------------------------------
  // LOGOUT
  // ---------------------------------------------------------------------------

  async logout(principal: TenantPrincipal, jti: string, meta: RequestMetadata): Promise<void> {
    // Both halves matter: revoking the session stops renewal, and deny-listing
    // the jti stops the still-valid access token being used until it expires.
    await this.repository.revokeSession(principal.sessionId, 'LOGOUT');
    await this.tokens.denyAccessToken(jti);
    await this.membershipCache.invalidate(principal.userId, principal.organizationId);

    await this.audit.record({
      action: AUDIT_ACTIONS.LOGOUT,
      organizationId: principal.organizationId,
      actorUserId: principal.userId,
      entityType: 'session',
      entityId: principal.sessionId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  /** Organizations the caller may act in, with the current one flagged. */
  async listOrganizations(principal: TenantPrincipal): Promise<MembershipSummary[]> {
    const memberships = await this.repository.findMembershipsForUser(principal.userId);

    return memberships
      .filter((m) => m.membershipStatus === 'ACTIVE' && m.organizationStatus !== 'SUSPENDED')
      .map((m) => ({
        id: m.organizationId,
        name: m.organizationName,
        slug: m.organizationSlug,
        role: m.role,
        current: m.organizationId === principal.organizationId,
      }));
  }

  /**
   * Issues a NEW session scoped to a different organization.
   *
   * The client supplies an organization id, which is exactly the input §4 says
   * never to trust. It is not trusted: membership is re-read from the database
   * and must be ACTIVE, so the id only selects among organizations the caller
   * already belongs to. A foreign id yields 403 and no session.
   *
   * A fresh session is minted rather than the token being rewritten, so the
   * old organization's session remains independently valid and revocable.
   */
  async switchOrganization(
    principal: TenantPrincipal,
    organizationId: string,
    platform: 'WEB' | 'ANDROID' | 'IOS',
    meta: RequestMetadata,
  ): Promise<{ tokens: TokenPair; refreshToken: string; user: AuthenticatedUser }> {
    const membership = await this.membershipCache.get(principal.userId, organizationId);

    if (!membership || membership.membershipStatus !== 'ACTIVE') {
      throw AppException.forbidden('You do not have access to that organization.');
    }
    if (membership.organizationStatus === 'SUSPENDED') throw AppException.organizationSuspended();
    if (membership.userStatus === 'SUSPENDED') throw AppException.accountSuspended();

    const session = await this.sessions.issue({
      organizationId,
      userId: principal.userId,
      role: membership.role,
      platform,
      meta,
    });

    const user = await this.repository.findUserById(principal.userId);
    if (!user) throw AppException.unauthorized();

    await this.audit.record({
      action: 'auth.organization.switched',
      organizationId,
      actorUserId: principal.userId,
      entityType: 'organization',
      entityId: organizationId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return {
      tokens: session.tokens,
      refreshToken: session.refreshToken,
      user: toAuthenticatedUser(membership, user),
    };
  }

  async currentUser(principal: TenantPrincipal): Promise<AuthenticatedUser> {
    const membership = await this.membershipCache.get(
      principal.userId,
      principal.organizationId,
    );
    if (!membership) throw AppException.unauthorized();

    const user = await this.repository.findUserById(principal.userId);
    if (!user) throw AppException.unauthorized();

    return toAuthenticatedUser(membership, user);
  }
}

function toAuthenticatedUser(
  membership: MembershipRecord,
  user: { id: string; email: string; fullName: string; mobile: string | null; avatarUrl: string | null },
): AuthenticatedUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    mobile: user.mobile,
    avatarUrl: user.avatarUrl,
    organization: {
      id: membership.organizationId,
      name: membership.organizationName,
      slug: membership.organizationSlug,
      timezone: membership.organizationTimezone,
      currency: membership.organizationCurrency,
      locale: membership.organizationLocale,
      country: membership.organizationCountry,
      status: membership.organizationStatus,
    },
    role: membership.role,
    permissions: membership.permissions,
  };
}
