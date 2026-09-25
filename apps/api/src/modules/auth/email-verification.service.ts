import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { ERROR_CODES } from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import { AuditRepository } from '../../common/audit/audit.repository';
import { AppConfig } from '../../common/config/config.module';
import { EmailService } from '../../common/email/email.service';
import { EmailVerificationRepository } from './email-verification.repository';

/**
 * Proving that somebody controls the address they registered with.
 *
 * Registration used to sign people straight in. That meant a typo produced a
 * working account whose owner could never reset the password — the only
 * recovery path goes to an address they do not control — and nothing stopped
 * anyone registering under somebody else's address.
 *
 * MIRRORS THE PASSWORD-RESET PATTERN, and does not share its table. Same
 * shape: 32 random bytes, only the SHA-256 stored, bounded expiry, single use,
 * spent rows kept so a replay is visible. Separate storage, because the two
 * tokens mean different things — one proves an address, the other grants the
 * power to change a credential — and a shared table would let a verification
 * link be redeemed as a reset the first time somebody confused two columns.
 */
@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);

  constructor(
    private readonly repository: EmailVerificationRepository,
    private readonly audit: AuditRepository,
    private readonly config: AppConfig,
    private readonly email: EmailService,
  ) {}

  private static hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Issues a token and emails the link.
   *
   * Returns whether the PROVIDER accepted the message — never whether anybody
   * received it. The caller needs the distinction: registration reports a
   * recoverable "we could not send it" state rather than claiming an inbox it
   * cannot see.
   *
   * Any outstanding token is spent first, so there is only ever one live link.
   */
  async sendVerification(
    user: { id: string; email: string; fullName: string },
    meta: { ipAddress?: string | undefined; userAgent?: string | undefined } = {},
  ): Promise<{ accepted: boolean }> {
    const now = new Date();
    await this.repository.invalidateOutstanding(user.id, now);

    const token = randomBytes(32).toString('base64url');

    await this.repository.issue({
      userId: user.id,
      tokenHash: EmailVerificationService.hash(token),
      expiresAt: new Date(now.getTime() + VERIFICATION_TTL_HOURS * 3_600_000),
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    const delivery = await this.email.sendEmailVerification({
      to: user.email,
      name: user.fullName,
      token,
      expiresInHours: VERIFICATION_TTL_HOURS,
    });

    /*
     * The token is NOT in this log line, and neither is the link.
     * A verification URL in an aggregator is a live credential in an
     * aggregator: anybody who can read the logs can take the account.
     */
    this.logger.log(
      {
        event: 'verification_requested',
        recipientDomain: domainOf(user.email),
        provider: this.email.providerName,
        accepted: delivery.accepted,
      },
      'Email verification requested',
    );

    await this.audit.record({
      action: 'auth.email_verification.requested',
      actorUserId: user.id,
      entityType: 'user',
      entityId: user.id,
      after: { accepted: delivery.accepted },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return { accepted: delivery.accepted };
  }

  /**
   * Redeems a link.
   *
   * Every refusal names itself with a stable code, because the four outcomes
   * send somebody to four different screens: ask for a new link, tell them it
   * expired, tell them it is already done, or tell them to sign in. A client
   * matching on prose would break the first time the wording improved.
   */
  async verify(
    rawToken: string,
    meta: { ipAddress?: string | undefined; userAgent?: string | undefined } = {},
  ): Promise<{ email: string }> {
    const record = await this.repository.findByHash(EmailVerificationService.hash(rawToken));

    if (!record) {
      // A token that never existed and one for a deleted user are the same
      // answer on purpose: distinguishing them would confirm which links were
      // ever real.
      throw AppException.notFound(
        ERROR_CODES.EMAIL_VERIFICATION_INVALID,
        'That verification link is not valid. Request a new one.',
      );
    }

    if (record.usedAt) {
      /*
       * Already spent. Reported as ALREADY_COMPLETED rather than as a failure,
       * because the overwhelmingly common cause is somebody clicking the link
       * twice — or a mail client prefetching it and then the person tapping
       * it. Telling them something went wrong would be a lie about their own
       * account, which is already verified.
       */
      throw AppException.conflict(
        ERROR_CODES.EMAIL_VERIFICATION_ALREADY_COMPLETED,
        'This email address has already been verified. You can sign in.',
      );
    }

    if (record.expiresAt.getTime() <= Date.now()) {
      throw AppException.conflict(
        ERROR_CODES.EMAIL_VERIFICATION_EXPIRED,
        'That verification link has expired. Request a new one.',
      );
    }

    const consumed = await this.repository.consume(record.id, record.userId, new Date());

    if (!consumed) {
      // Lost a race with a concurrent redemption of the same link. The account
      // is verified either way, so this is the already-done answer rather than
      // an error.
      throw AppException.conflict(
        ERROR_CODES.EMAIL_VERIFICATION_ALREADY_COMPLETED,
        'This email address has already been verified. You can sign in.',
      );
    }

    this.logger.log(
      { event: 'verification_accepted', recipientDomain: domainOf(record.user.email) },
      'Email verification accepted',
    );

    await this.audit.record({
      action: 'auth.email_verification.completed',
      actorUserId: record.userId,
      entityType: 'user',
      entityId: record.userId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return { email: record.user.email };
  }

  /**
   * Sends another link, for a public caller.
   *
   * ENUMERATION-SAFE. The answer is identical whether the address has an
   * account, has one that is already verified, or has none at all — an
   * unauthenticated endpoint that distinguishes them tells a competitor
   * exactly who uses this product.
   *
   * Rate-limited per account as well as by the route's own throttle: the
   * throttle limits one caller, this limits how much mail any single mailbox
   * can be made to receive, which is what stops the endpoint being used to
   * send somebody a hundred emails from a hundred addresses.
   */
  async resend(
    email: string,
    meta: { ipAddress?: string | undefined; userAgent?: string | undefined } = {},
  ): Promise<{ message: string }> {
    const user = await this.repository.findUserByEmail(email.trim().toLowerCase());

    if (!user || user.emailVerifiedAt || user.status === 'SUSPENDED') {
      // Nothing to do, and the caller is told exactly what a real send is told.
      this.logger.log(
        { event: 'verification_resend_ignored', recipientDomain: domainOf(email) },
        'Verification resend requested for an address with nothing to send',
      );

      return { message: NEUTRAL_RESEND_RESPONSE };
    }

    const recent = await this.repository.countIssuedSince(
      user.id,
      new Date(Date.now() - RESEND_WINDOW_MINUTES * 60_000),
    );

    if (recent >= RESEND_LIMIT_PER_WINDOW) {
      /*
       * Refused, and still with the neutral message.
       *
       * Returning a distinguishable rate-limit error here would reintroduce
       * the enumeration oracle from the other side: only a real, unverified
       * account can be rate limited, so the error itself would confirm one
       * exists. The refusal is recorded server-side instead.
       */
      this.logger.warn(
        { event: 'verification_resend_rate_limited', recipientDomain: domainOf(user.email) },
        'Verification resend refused by the per-account rate limit',
      );

      return { message: NEUTRAL_RESEND_RESPONSE };
    }

    await this.sendVerification(user, meta);

    return { message: NEUTRAL_RESEND_RESPONSE };
  }

  /**
   * Marks a mailbox proven without a link.
   *
   * For the two flows that prove ownership another way: accepting an emailed
   * invitation, and a trusted verified-email claim from an identity provider.
   * Both are argued at their call sites.
   */
  async markVerified(userId: string, reason: 'invitation' | 'oidc'): Promise<void> {
    await this.repository.markVerified(userId, new Date());

    await this.audit.record({
      action: 'auth.email_verification.completed',
      actorUserId: userId,
      entityType: 'user',
      entityId: userId,
      after: { via: reason },
    });
  }

  /** Whether this account may hold a session. */
  isVerified(user: { emailVerifiedAt: Date | null }): boolean {
    return user.emailVerifiedAt !== null;
  }

  /** Development only, so the flow is testable without reading a mailbox. */
  revealToken(token: string): string | undefined {
    return this.config.isProduction ? undefined : token;
  }
}

/**
 * How long a link lives.
 *
 * A day, not an hour. This is the first thing somebody does with the product,
 * often on a phone, often not immediately — an hour produces expired links and
 * a support burden for no security gain, since the token is single-use and
 * tied to one account either way. Password resets are shorter because a live
 * reset link is a live credential; this one only proves an address.
 */
export const VERIFICATION_TTL_HOURS = 24;

/** Per-account resend budget, independent of the route throttle. */
export const RESEND_LIMIT_PER_WINDOW = 5;
export const RESEND_WINDOW_MINUTES = 60;

/**
 * Identical for every public resend, whatever the truth.
 *
 * Deliberately says what WILL happen rather than what did, so it stays true
 * for an address with no account.
 */
const NEUTRAL_RESEND_RESPONSE =
  'If that address needs verifying, a new link is on its way.';

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}
