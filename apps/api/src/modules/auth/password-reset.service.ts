import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { ERROR_CODES } from '@leadflow/api-types';
import { AppConfig } from '../../common/config/config.module';
import { AppException } from '../../common/errors/app.exception';
import { AuditRepository } from '../../common/audit/audit.repository';
import type { RequestMetadata } from './session.service';
import { PasswordResetRepository } from './password-reset.repository';
import { PasswordService } from './password.service';

/**
 * Reset tokens live for one hour, not the seven days an invitation gets.
 *
 * An invitation is an expected message you may act on at leisure. A reset token
 * is a live credential to an existing account, frequently issued because
 * something has already gone wrong, and its value to an attacker is far higher.
 */
const RESET_TTL_MINUTES = 60;

/** Identical for every caller — see requestReset. */
const NEUTRAL_RESPONSE =
  'If an account exists for that email, a password reset link has been sent.';

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly repository: PasswordResetRepository,
    private readonly passwords: PasswordService,
    private readonly audit: AuditRepository,
    private readonly config: AppConfig,
  ) {}

  private static hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Requests a reset.
   *
   * ALWAYS reports the same thing, whether or not the email has an account.
   * Any difference — status code, message, or shape — turns this endpoint into
   * a way to enumerate customers, and an unauthenticated enumeration oracle on
   * a B2B product tells a competitor exactly who your users are.
   */
  async requestReset(
    email: string,
    meta: RequestMetadata,
  ): Promise<{ message: string; resetToken?: string }> {
    const user = await this.repository.findUserByEmail(email.trim().toLowerCase());

    // An account that has never set a password (an unaccepted invitation)
    // cannot be "reset" — the invitation is the way in.
    if (!user || user.passwordHash === null || user.status === 'SUSPENDED') {
      await this.audit.record({
        action: 'auth.password_reset.requested',
        entityType: 'user',
        after: { email, issued: false },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      return { message: NEUTRAL_RESPONSE };
    }

    const token = randomBytes(32).toString('base64url');

    await this.repository.issue({
      userId: user.id,
      tokenHash: PasswordResetService.hash(token),
      expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    await this.audit.record({
      action: 'auth.password_reset.requested',
      actorUserId: user.id,
      entityType: 'user',
      entityId: user.id,
      after: { issued: true },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return {
      message: NEUTRAL_RESPONSE,
      // Returned outside production only, so the flow is testable without an
      // email provider. In production this would put a live credential into
      // logs, proxies and browser history.
      ...(this.config.isProduction ? {} : { resetToken: token }),
    };
  }

  async reset(token: string, newPassword: string, meta: RequestMetadata): Promise<void> {
    const record = await this.repository.findByTokenHash(PasswordResetService.hash(token));

    // Unknown or already spent: both are 404 with one message. Spent tokens are
    // retained for the audit trail, so this deliberately does NOT distinguish
    // them — that would confirm a token was once real.
    if (!record || record.usedAt !== null) {
      throw AppException.notFound(
        ERROR_CODES.NOT_FOUND,
        'This password reset link is not valid. Please request a new one.',
      );
    }

    // Expiry IS distinguished. The link was genuinely theirs and simply timed
    // out, so telling them lets them act instead of assuming a broken product.
    if (record.expiresAt.getTime() <= Date.now()) {
      throw new AppException(
        ERROR_CODES.CONFLICT,
        'This password reset link has expired. Please request a new one.',
        HttpStatus.GONE,
      );
    }

    if (record.user.status === 'SUSPENDED') throw AppException.accountSuspended();

    const consumed = await this.repository.consumeAndSetPassword({
      tokenId: record.id,
      userId: record.user.id,
      passwordHash: await this.passwords.hash(newPassword),
    });

    // Lost a concurrent race. The token is spent; claiming success would be a
    // lie and would leave the caller believing a password they did not set.
    if (!consumed) {
      throw AppException.notFound(
        ERROR_CODES.NOT_FOUND,
        'This password reset link is not valid. Please request a new one.',
      );
    }

    this.logger.warn(
      { userId: record.user.id },
      'Password reset completed — all sessions revoked',
    );

    await this.audit.record({
      action: 'auth.password_reset.completed',
      actorUserId: record.user.id,
      entityType: 'user',
      entityId: record.user.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  /**
   * Changes the password for a signed-in user.
   *
   * The current password is required even though the caller already holds a
   * valid access token. Without it, a stolen 15-minute token upgrades into
   * permanent account takeover — the attacker simply sets a new password.
   */
  async changePassword(input: {
    userId: string;
    sessionId: string;
    currentPassword: string;
    newPassword: string;
    meta: RequestMetadata;
  }): Promise<void> {
    const user = await this.repository.findUserById(input.userId);
    if (!user?.passwordHash) throw AppException.unauthorized();

    const valid = await this.passwords.verify(user.passwordHash, input.currentPassword);
    if (!valid) {
      await this.audit.record({
        action: 'auth.password_change.failed',
        actorUserId: input.userId,
        entityType: 'user',
        entityId: input.userId,
        after: { reason: 'bad_current_password' },
        ipAddress: input.meta.ipAddress,
        userAgent: input.meta.userAgent,
      });

      throw AppException.invalidCredentials();
    }

    await this.repository.changePassword({
      userId: input.userId,
      passwordHash: await this.passwords.hash(input.newPassword),
      exceptSessionId: input.sessionId,
    });

    await this.audit.record({
      action: 'auth.password_change.completed',
      actorUserId: input.userId,
      entityType: 'user',
      entityId: input.userId,
      ipAddress: input.meta.ipAddress,
      userAgent: input.meta.userAgent,
    });
  }

  /** The caller's own live sessions, with the current one flagged. */
  async listSessions(userId: string, currentSessionId: string) {
    const sessions = await this.repository.listSessions(userId);

    return sessions.map((session) => ({
      id: session.id,
      platform: session.platform,
      deviceName: session.deviceName,
      ipAddress: session.ipAddress,
      organization: session.organization,
      createdAt: session.createdAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      current: session.id === currentSessionId,
    }));
  }

  async revokeSession(userId: string, sessionId: string, meta: RequestMetadata): Promise<void> {
    const revoked = await this.repository.revokeSession(userId, sessionId);

    // 404 rather than 403: someone else's session id must not be confirmed to
    // exist, or sessions become enumerable.
    if (revoked === 0) {
      throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Session not found.');
    }

    await this.audit.record({
      action: 'auth.session.revoked',
      actorUserId: userId,
      entityType: 'session',
      entityId: sessionId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }
}
