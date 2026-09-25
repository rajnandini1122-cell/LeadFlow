import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { ERROR_CODES, type RoleKey } from '@leadflow/api-types';
import { AppConfig } from '../../common/config/config.module';
import { AppException } from '../../common/errors/app.exception';
import { AuditRepository } from '../../common/audit/audit.repository';
import { EmailService } from '../../common/email/email.service';
import { EmailVerificationService } from '../auth/email-verification.service';
import { PasswordService } from '../auth/password.service';
import { InvitationsRepository } from './invitations.repository';
import type { AcceptInvitationDto } from './dto/invitations.dto';

export const INVITE_TTL_DAYS = 7;

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

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly repository: InvitationsRepository,
    private readonly passwords: PasswordService,
    private readonly audit: AuditRepository,
    private readonly config: AppConfig,
    private readonly email: EmailService,
    private readonly verification: EmailVerificationService,
  ) {}

  /**
   * Generates a token and returns both halves.
   *
   * Only the SHA-256 hash is ever stored, so a database disclosure yields no
   * usable invitation links. SHA-256 rather than argon2 is right here: the
   * input is 256 bits of entropy, so there is no dictionary to defend against.
   */
  static mintToken(): { token: string; hash: string; expiresAt: Date } {
    const token = randomBytes(32).toString('base64url');
    return {
      token,
      hash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
    };
  }

  static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Withheld in production, where returning it would leak a credential. */
  revealToken(token: string): string | undefined {
    return this.config.isProduction ? undefined : token;
  }

  // --- management ------------------------------------------------------------

  async listPending(): Promise<PendingInvitation[]> {
    const rows = await this.repository.listPending();

    return rows.map((row) => ({
      id: row.id,
      email: row.user.email,
      fullName: row.user.fullName,
      role: row.role.key as RoleKey,
      invitedBy: row.invitedBy?.fullName ?? null,
      expiresAt: row.inviteExpiresAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async resend(
    id: string,
  ): Promise<{ id: string; email: string; emailDelivered: boolean; inviteToken?: string }> {
    const invitation = await this.repository.findPendingById(id);
    // Tenant-scoped lookup: another organization's id is simply not found.
    if (!invitation) throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Invitation not found.');

    const minted = InvitationsService.mintToken();
    const rotated = await this.repository.rotateToken(id, minted.hash, minted.expiresAt);
    if (rotated === 0) throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Invitation not found.');

    await this.audit.record({
      action: 'user.invitation.resent',
      entityType: 'membership',
      entityId: id,
      after: { email: invitation.user.email },
    });

    /*
     * SEND THE EMAIL.
     *
     * Resend did not, and that was the whole defect: it rotated the token,
     * wrote an audit row and returned success — inviting the administrator to
     * believe a fresh link was on its way while nothing left the building. It
     * was strictly worse than doing nothing, because rotating the hash
     * invalidates the previous link, so the one email the invitee might
     * actually have had stopped working too.
     *
     * Worse still, this was the documented recovery path for a failed
     * invitation email. The advice was to resend, and resending sent nothing.
     */
    const organizationName = await this.repository.organizationName();

    const delivery = await this.email.sendInvitation({
      to: invitation.user.email,
      // The original inviter is not carried on the membership row, so the
      // organization speaks for itself rather than naming somebody who may no
      // longer be here.
      inviterName: organizationName,
      organizationName,
      role: invitation.role.key,
      token: minted.token,
      expiresInDays: INVITE_TTL_DAYS,
    });

    if (!delivery.accepted) {
      this.logger.error(
        { invitationId: id, provider: this.email.providerName },
        'Resent invitation email was not accepted by the mail provider',
      );
    }

    // Rotating the hash invalidates the previous link, so a forwarded old email
    // stops working — otherwise every resend would add another live way in.
    return {
      id,
      email: invitation.user.email,
      emailDelivered: delivery.accepted,
      ...(this.revealToken(minted.token) ? { inviteToken: minted.token } : {}),
    };
  }

  async revoke(id: string): Promise<void> {
    const revoked = await this.repository.revoke(id);
    if (revoked === 0) throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Invitation not found.');

    await this.audit.record({
      action: 'user.invitation.revoked',
      entityType: 'membership',
      entityId: id,
    });
  }

  // --- redemption ------------------------------------------------------------

  async preview(token: string): Promise<InvitationPreview> {
    const invitation = await this.loadRedeemable(token);

    // Deliberately minimal: organization NAME but not its id, and nothing about
    // other members. An invitation link may be forwarded anywhere.
    return {
      organizationName: invitation.organization.name,
      role: invitation.role.key as RoleKey,
      email: invitation.user.email,
      hasAccount: invitation.user.passwordHash !== null,
      expiresAt: invitation.inviteExpiresAt?.toISOString() ?? null,
    };
  }

  async accept(
    token: string,
    dto: AcceptInvitationDto,
  ): Promise<{ organizationId: string; userId: string; role: RoleKey; email: string }> {
    const invitation = await this.loadRedeemable(token);

    const alreadyHasAccount = invitation.user.passwordHash !== null;

    // A brand new user must set a password; an existing user must not be asked
    // for one, and must not have theirs replaced by whoever holds the link.
    if (!alreadyHasAccount && !dto.password) {
      throw AppException.validation('Choose a password to finish setting up your account.', {
        password: ['is required'],
      });
    }

    const fullName =
      dto.firstName && dto.lastName ? `${dto.firstName} ${dto.lastName}`.trim() : undefined;

    const accepted = await this.repository.acceptAtomically({
      membershipId: invitation.id,
      userId: invitation.user.id,
      fullName: alreadyHasAccount ? undefined : fullName,
      passwordHash:
        alreadyHasAccount || !dto.password
          ? undefined
          : await this.passwords.hash(dto.password),
    });

    // Lost the race, or consumed between the read and the write. Either way the
    // token is spent — reporting success would be a lie.
    if (!accepted) throw invitationGone();

    /*
     * Accepting an invitation IS proof of mailbox ownership.
     *
     * The invitation token was generated here, hashed here, and sent to one
     * address. Redeeming it means whoever did so read that mailbox — the same
     * thing a verification link proves, by the same mechanism. Emailing them a
     * second link to confirm an address they just demonstrably received mail
     * at would be ceremony, and ceremony that blocks a new colleague from
     * getting to work.
     *
     * So invited users are verified on acceptance rather than being sent
     * through a redundant round trip. Only ever set forward from null, so
     * somebody who verified earlier keeps their original timestamp.
     */
    await this.verification.markVerified(invitation.user.id, 'invitation');

    await this.audit.record({
      action: 'user.invitation.accepted',
      organizationId: invitation.organizationId,
      actorUserId: invitation.user.id,
      entityType: 'membership',
      entityId: invitation.id,
      after: { role: invitation.role.key, existingAccount: alreadyHasAccount },
    });

    return {
      organizationId: invitation.organizationId,
      userId: invitation.user.id,
      role: invitation.role.key as RoleKey,
      email: invitation.user.email,
    };
  }

  /**
   * Loads an invitation that is genuinely redeemable, or throws.
   *
   * Accepting, revoking or resending CLEARS or ROTATES the stored hash, so a
   * spent token is genuinely absent from the index and is indistinguishable
   * from one that never existed. Both return 404 with the same actionable
   * message. That is deliberate: keeping consumed hashes around purely to
   * answer "this used to be valid" would build an oracle for no real benefit.
   *
   * Expiry is different. An expired invitation has not been consumed, so the
   * row is still findable, and 410 Gone lets a legitimate user understand that
   * their link timed out rather than that the product is broken.
   */
  private async loadRedeemable(token: string) {
    const invitation = await this.repository.findByTokenHash(
      InvitationsService.hashToken(token),
    );

    if (!invitation) {
      throw AppException.notFound(
        ERROR_CODES.NOT_FOUND,
        'This invitation link is no longer valid. Ask an administrator to send a new one.',
      );
    }
    if (invitation.inviteRevokedAt || invitation.inviteAcceptedAt) throw invitationGone();
    if (invitation.status !== 'INVITED') throw invitationGone();
    if (invitation.inviteExpiresAt && invitation.inviteExpiresAt.getTime() <= Date.now()) {
      throw invitationGone();
    }
    if (invitation.organization.status === 'SUSPENDED') {
      throw AppException.forbidden('This organization is not currently active.');
    }

    return invitation;
  }
}

/** 410 Gone: the link was valid once and definitively is not any more. */
function invitationGone(): AppException {
  return new AppException(
    ERROR_CODES.CONFLICT,
    'This invitation link is no longer valid. Ask an administrator to send a new one.',
    HttpStatus.GONE,
  );
}
