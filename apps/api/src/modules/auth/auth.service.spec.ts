import { ERROR_CODES } from '@leadflow/api-types';
import type { AppConfig } from '../../common/config/config.module';
import type { AuditRepository } from '../../common/audit/audit.repository';
import { AppException } from '../../common/errors/app.exception';
import { AuthService, type RequestMetadata } from './auth.service';
import type { AuthRepository } from './auth.repository';
import type { EmailVerificationRepository } from './email-verification.repository';
import type { GoogleAuthService } from './google-auth.service';
import type { MembershipCacheService } from './membership-cache.service';
import type { PasswordService } from './password.service';
import type { SessionService } from './session.service';
import type { TokenService } from './token.service';

/**
 * What `REFRESH_REUSE_INTERVAL_MS = 0` must mean.
 *
 * Zero is documented as STRICT reuse detection, and that is not the same
 * thing as a zero-length window. The database comparison behind the interval
 * is `clock_timestamp() - revoked_at <= interval`, which is true at a
 * difference of exactly zero — and true for any revocation somehow stamped in
 * the future. A configured zero must therefore skip the interval entirely
 * rather than ask for a window of no length, or the strictest setting in the
 * product would quietly hand out grace at the instant of rotation.
 *
 * These tests drive the real service with the interval check stubbed to say
 * "inside the window". At zero it must never be consulted; above zero it must
 * be obeyed.
 */
describe('AuthService.refresh — rotation reuse interval', () => {
  const ROTATED_SESSION = {
    id: 'session-1',
    organizationId: 'org-1',
    userId: 'user-1',
    familyId: 'family-1',
    revokedAt: new Date('2026-09-22T00:00:00.000Z'),
    revokedReason: 'ROTATED',
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    platform: 'WEB',
  };

  const meta: RequestMetadata = { ipAddress: '127.0.0.1', userAgent: 'jest' };

  function build(intervalMs: number) {
    const repository = {
      findSessionByTokenHash: jest.fn().mockResolvedValue(ROTATED_SESSION),
      // Deliberately generous: if this is consulted at all, it grants grace.
      isWithinRotationReuseInterval: jest.fn().mockResolvedValue(true),
      revokeFamily: jest.fn().mockResolvedValue(3),
    };
    const tokens = { hashRefreshToken: jest.fn().mockReturnValue('hash') };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const config = { get: jest.fn().mockReturnValue(intervalMs) };

    /*
     * Refresh re-checks that the mailbox is still proven, from the DATABASE
     * rather than from the claim baked into the token. These cases are about
     * the reuse interval and refuse before reaching that check, so a verified
     * account is the neutral stand-in.
     */
    const verification = {
      findUserById: jest.fn().mockResolvedValue({
        id: 'user-1',
        email: 'rotator@example.test',
        fullName: 'Rita Rotate',
        status: 'ACTIVE',
        emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
    };

    const service = new AuthService(
      repository as unknown as AuthRepository,
      {} as unknown as PasswordService,
      tokens as unknown as TokenService,
      {} as unknown as MembershipCacheService,
      audit as unknown as AuditRepository,
      {} as unknown as SessionService,
      {} as unknown as GoogleAuthService,
      config as unknown as AppConfig,
      verification as unknown as EmailVerificationRepository,
    );

    return { service, repository, audit };
  }

  it('disables grace entirely when the interval is 0', async () => {
    const { service, repository, audit } = build(0);

    const error = await service.refresh('spent-token', meta).catch((caught: unknown) => caught);

    // The ordinary reuse path: family revoked, security audit written, and the
    // reuse error rather than a plain invalid-token error.
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).code).toBe(ERROR_CODES.TOKEN_REUSE_DETECTED);
    expect(repository.revokeFamily).toHaveBeenCalledWith('family-1', 'REUSE_DETECTED');
    expect(audit.record).toHaveBeenCalled();

    // The interval is not merely evaluated to false — it is never asked.
    expect(repository.isWithinRotationReuseInterval).not.toHaveBeenCalled();
  });

  it('honours the interval when one is configured', async () => {
    const { service, repository, audit } = build(2000);

    const error = await service.refresh('spent-token', meta).catch((caught: unknown) => caught);

    // A straggler inside the window: still refused, but the family lives and
    // nothing is recorded as a security event.
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).code).toBe(ERROR_CODES.TOKEN_INVALID);
    expect(repository.isWithinRotationReuseInterval).toHaveBeenCalledWith({
      sessionId: 'session-1',
      organizationId: 'org-1',
      intervalMs: 2000,
    });
    expect(repository.revokeFamily).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
