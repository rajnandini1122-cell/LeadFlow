import { Injectable } from '@nestjs/common';
import type { Permission, RoleKey, TokenPair } from '@leadflow/api-types';
import { uuidv7 } from '../../common/utils/uuid';
import { AuthRepository } from './auth.repository';
import { TokenService } from './token.service';
import { MembershipCacheService } from './membership-cache.service';

export interface RequestMetadata {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

export interface IssuedSession {
  tokens: TokenPair;
  refreshToken: string;
  permissions: Permission[];
}

/**
 * Mints a session for one user in one organization.
 *
 * Extracted because four flows now need identical session semantics — login,
 * registration, invitation acceptance and organization switching. Four copies
 * of "create the row, then sign the token" would drift, and the one that drifts
 * is the one that forgets to bind the session to the right tenant.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly tokens: TokenService,
    private readonly membershipCache: MembershipCacheService,
  ) {}

  async issue(input: {
    organizationId: string;
    userId: string;
    role: RoleKey;
    platform: 'WEB' | 'ANDROID' | 'IOS';
    meta: RequestMetadata;
    deviceId?: string | undefined;
    deviceName?: string | undefined;
  }): Promise<IssuedSession> {
    const refresh = this.tokens.issueRefreshToken();

    const session = await this.repository.createSession({
      organizationId: input.organizationId,
      userId: input.userId,
      refreshTokenHash: refresh.hash,
      // A fresh family per issuance: switching organizations must not let the
      // new session be revoked by reuse detection on the old one, and vice
      // versa. They are independent logins that happen to share a password.
      familyId: uuidv7(),
      expiresAt: refresh.expiresAt,
      platform: input.platform,
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      ipAddress: input.meta.ipAddress,
      userAgent: input.meta.userAgent,
    });

    const access = await this.tokens.issueAccessToken({
      sub: input.userId,
      org: input.organizationId,
      role: input.role,
      sid: session.id,
    });

    // Read back through the cache so the permission list attached to the
    // response is exactly what the guard will enforce on the next request.
    const membership = await this.membershipCache.get(input.userId, input.organizationId);

    return {
      tokens: {
        accessToken: access.token,
        expiresIn: access.expiresIn,
        tokenType: 'Bearer',
      },
      refreshToken: refresh.token,
      permissions: membership?.permissions ?? [],
    };
  }
}
