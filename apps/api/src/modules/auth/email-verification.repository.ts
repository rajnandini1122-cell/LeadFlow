import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Verification tokens, and the one column that says whether a mailbox is proven.
 *
 * `User` and `EmailVerificationToken` are both GLOBAL: a person exists before
 * any organization does, and verification happens before there is a tenant
 * context to scope to. So nothing here is tenant-scoped, and nothing here is a
 * tenant-scoping hole either — none of these reads can reach a lead, a contact
 * or anything a customer owns.
 */
@Injectable()
export class EmailVerificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The unextended client.
   *
   * `User` is not in TENANT_SCOPED_MODELS, so this is the same client the
   * password-reset path uses for the same reason: identity is not tenant data.
   */
  private get db() {
    return this.prisma.client;
  }

  async findUserByEmail(email: string) {
    return this.db.user.findFirst({
      where: { email },
      select: { id: true, email: true, fullName: true, status: true, emailVerifiedAt: true },
    });
  }

  async findUserById(userId: string) {
    return this.db.user.findFirst({
      where: { id: userId },
      select: { id: true, email: true, fullName: true, status: true, emailVerifiedAt: true },
    });
  }

  async issue(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    ipAddress?: string | undefined;
    userAgent?: string | undefined;
  }): Promise<void> {
    await this.db.emailVerificationToken.create({
      data: {
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  }

  /** Looked up by HASH. The raw token is never stored, so it cannot be queried. */
  async findByHash(tokenHash: string) {
    return this.db.emailVerificationToken.findFirst({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        usedAt: true,
        user: { select: { id: true, email: true, emailVerifiedAt: true } },
      },
    });
  }

  /**
   * Spends the token and marks the mailbox proven, atomically.
   *
   * ONE transaction, and the `usedAt: null` guard inside it is what makes the
   * token single-use under concurrency. Two clicks on the same link — a mail
   * client prefetching the URL, then the person tapping it — arrive together;
   * the first updates one row and the second updates none, so exactly one
   * redemption wins. A read-then-write would let both through.
   *
   * Returns false when the token was already spent, so the caller can report
   * ALREADY_COMPLETED rather than a failure. Somebody clicking twice has done
   * nothing wrong.
   */
  async consume(tokenId: string, userId: string, now: Date): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const spent = await tx.emailVerificationToken.updateMany({
        where: { id: tokenId, usedAt: null },
        data: { usedAt: now },
      });

      if (spent.count === 0) return false;

      // Only ever set forward from null: re-verifying must not rewrite the
      // original moment somebody proved the mailbox.
      await tx.user.updateMany({
        where: { id: userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: now },
      });

      return true;
    });
  }

  /**
   * Invalidates every live token for a user.
   *
   * Called before issuing a new one, so a resend really does replace the
   * previous link rather than adding a second live way in. Marked spent rather
   * than deleted, for the same reason redemption keeps the row: an attempt to
   * use a superseded link should be visible, not merely fail.
   */
  async invalidateOutstanding(userId: string, now: Date): Promise<number> {
    const result = await this.db.emailVerificationToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: now },
    });

    return result.count;
  }

  /** How many tokens this user was sent recently. Backs the resend rate limit. */
  async countIssuedSince(userId: string, since: Date): Promise<number> {
    return this.db.emailVerificationToken.count({
      where: { userId, createdAt: { gte: since } },
    });
  }

  /**
   * Marks a mailbox proven without a token.
   *
   * Two callers, both of which prove ownership by a different route than a
   * verification link: accepting an emailed invitation (the token only ever
   * reached the invited mailbox), and an identity provider asserting a
   * verified email. Deliberately narrow and deliberately named, so a third
   * caller has to justify itself.
   */
  async markVerified(userId: string, now: Date): Promise<void> {
    await this.db.user.updateMany({
      where: { id: userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: now },
    });
  }
}
